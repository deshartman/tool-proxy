// On-disk shape for the connector's config store, plus atomic read/write.
//
// Replaces config-store/schema.ts (Postgres DDL). See
// Why a file rather than a database: the store holds five kinds of
// record totalling under ten rows in any real deployment — one controller,
// one key fingerprint, one network-access flag, one trusted-issuer config and
// a handful of API clients. No joins, no queries, no concurrency beyond a
// single process. Postgres was chosen when the enterprise-knowledge bundle
// already required it ("zero new infrastructure"); EK was removed and the
// justification went with it, leaving a database server to hold four secrets.
//
// Sealing is unchanged — the same libsodium crypto_secretbox_easy from
// seal.ts protects the same four values. BYTEA becomes base64 at the JSON
// boundary and nothing else moves. It still earns its place: the master key
// arrives from a K8s Secret / Fly secret / mounted file while this file lives
// on a volume, so a volume snapshot without the key yields nothing.
//
// Timestamps are ISO strings on disk and Date objects in memory, because
// that is what the pg driver handed callers and every caller expects it.

import { isShimId, mintShimId } from "../identity/shim-id.js";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { envOptional } from "../env.js";

/** Bumped only when the on-disk shape changes; `migrate` keys off it. */
export const CURRENT_VERSION = 1;

/**
 * Default state directory — a SUBDIRECTORY of the volume, not its root.
 *
 * That is load-bearing and was nearly a shipped boot failure. `writeDocAtomic`
 * writes a sibling `.tmp` and renames, so it needs write permission on the
 * containing DIRECTORY, not just the file. The volume root is deliberately
 * left root-owned 0755 (see entrypoint.sh: a compromised child must not be
 * able to litter the volume or plant a drop-in for the next boot), and a
 * mounted volume shadows whatever the image created — Fly mounts `uid: 0`,
 * and a K8s PVC or raw EFS mount behaves the same. The connector runs as
 * `mcp`, so a store at the root would fail EACCES on the first write on every
 * cloud target while passing in dev and under docker-compose, where a named
 * volume keeps the image's ownership.
 *
 * So the store lives beside agentic-memory/ and customer-mcps/ in a directory
 * entrypoint.sh creates and chowns while it is still root. Adding a fourth
 * directory to that loop is the whole fix; do not "simplify" this back to the
 * volume root, and do not chown the root instead.
 */
export const DEFAULT_STATE_DIR = "/var/lib/mcp-connector/state";

export const STATE_FILENAME = "config.json";

/** Sealed values are base64 on disk; `null` means absent, as NULL did. */
export interface ControllerDoc {
  id: string;
  name: string;
  controllerUrl: string;
  connectorName: string;
  environment: string | null;
  authMode: "static-bearer" | "oauth2-cc";
  tunnelAuthTokenCt: string | null;
  oauthClientId: string | null;
  oauthClientSecretCt: string | null;
  oauthTokenUrl: string | null;
  registrationTokenCt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
  lastDisconnectReason: string | null;
  /**
   * This controller's federated trust config (MULTI-PLATFORM-MCP §5.6). Each
   * entry has its own, because one IdP must not mint tokens valid for two
   * tunnels. Absent on a store written before Phase 6; the legacy top-level
   * `StoreDoc.trustedIssuer` is moved in here by ConfigStore (see
   * `adoptLegacyBindings`).
   */
  trustedIssuer?: TrustedIssuerDoc | null;
}

export interface ApiClientDoc {
  clientId: string;
  clientSecretCt: string;
  name: string | null;
  createdAt: string;
  revokedAt: string | null;
  /**
   * The controller entry this client drives (MULTI-PLATFORM-MCP §5.6). A
   * machine-API call runs on that entry's tunnel only. Absent on a client
   * minted before Phase 6, or before any controller existed; ConfigStore binds
   * such a client to the controller it was used with (see
   * `adoptLegacyBindings`), so an unbound client exists only while the store
   * has no controller at all.
   */
  controllerId?: string;
}

export interface TrustedIssuerDoc {
  issuer: string;
  jwksUrl: string;
  audience: string;
}

export interface StoreDoc {
  version: number;
  /** SHA-256 hex of the master key. Was the `encryption_meta` table. */
  keyFingerprint: string;
  /**
   * This shim's own identity — see identity/shim-id.ts. Minted once by
   * emptyDoc; a store written before the field existed is back-filled by
   * ConfigStore.open. Optional in the type only so migrate() can tell the two
   * apart: it is always present after open().
   *
   * Deliberately NOT a version bump: an older connector reading a store that
   * carries it ignores the field, so a rollback keeps working.
   */
  shimId?: string;
  /**
   * One entry per controller this shim dials; each is one TunnelWorkspace
   * (MULTI-PLATFORM-MCP Phase 6), identified by its `id`. An array from day
   * one, so Phase 6 needed no reshape here.
   */
  controllers: ControllerDoc[];
  networkAccess: { enabled: boolean };
  /**
   * Legacy, pre-Phase-6 location of the trusted issuer. Since Phase 6 it is
   * per controller entry; this field only holds a value while the store has
   * no controller, and moves into the first entry added.
   */
  trustedIssuer: TrustedIssuerDoc | null;
  apiClients: ApiClientDoc[];
}

export function emptyDoc(keyFingerprint: string): StoreDoc {
  return {
    version: CURRENT_VERSION,
    keyFingerprint,
    shimId: mintShimId(),
    controllers: [],
    networkAccess: { enabled: false },
    trustedIssuer: null,
    apiClients: [],
  };
}

/**
 * Where the store lives. `CONNECTOR_STATE_DIR` exists for dev and tests only
 * — scripts/start-connector.sh points each multi-instance port at its own
 * directory, the same job POSTGRES_SCHEMA used to do. Operators never set it;
 * the container default is correct. Same category as the Dockerfile's
 * AGENTIC_MEMORY_STATE_PATH.
 */
export function resolveStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = envOptional("CONNECTOR_STATE_DIR", env) ?? DEFAULT_STATE_DIR;
  return join(resolve(dir), STATE_FILENAME);
}

/**
 * Read and parse. Throws on unreadable or malformed content rather than
 * silently starting empty — a corrupt store must not look like a fresh
 * install, because the operator would then reconfigure over a file that still
 * holds a recoverable registration token.
 */
export function readDoc(path: string): StoreDoc {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read config store at ${path}: ${(error as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `config store at ${path} is not valid JSON (${(error as Error).message}). ` +
      `Restore it from a backup, or move it aside to start fresh — moving it ` +
      `aside discards the tunnel identity and requires re-adding it in the inspector.`,
    );
  }
  return migrate(parsed, path);
}

/** Version switch. Only version 1 exists; later versions upgrade in place here. */
export function migrate(parsed: unknown, path: string): StoreDoc {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`config store at ${path} must contain a JSON object.`);
  }
  const doc = parsed as Partial<StoreDoc>;
  if (doc.version !== CURRENT_VERSION) {
    throw new Error(
      `config store at ${path} has version ${String(doc.version)}; ` +
      `this connector understands version ${CURRENT_VERSION}. Upgrade the connector.`,
    );
  }
  if (typeof doc.keyFingerprint !== "string") {
    throw new Error(`config store at ${path} is missing keyFingerprint.`);
  }
  // Tolerate absent collections so a hand-edited or partially-written file
  // still loads; anything present must be the right shape.
  return {
    version: CURRENT_VERSION,
    keyFingerprint: doc.keyFingerprint,
    // A malformed id is dropped rather than trusted, so open() re-mints it.
    // That is a NEW identity — only reached by a hand-edited file, never by
    // anything the connector wrote.
    ...(isShimId(doc.shimId) ? { shimId: doc.shimId } : {}),
    controllers: Array.isArray(doc.controllers) ? doc.controllers : [],
    networkAccess: { enabled: doc.networkAccess?.enabled === true },
    trustedIssuer: doc.trustedIssuer ?? null,
    apiClients: Array.isArray(doc.apiClients) ? doc.apiClients : [],
  };
}

/**
 * Atomic write: sibling temp file, fsync, rename. The rename is atomic within
 * a directory, so a crash mid-write leaves the previous file intact rather
 * than a truncated one.
 *
 * The same tmp-then-rename shape agentic-memory's saveState uses — and worth
 * remembering why that one is called out in CLAUDE.md: it wrote lazily, so a
 * root-owned directory produced EACCES on the first *write* rather than at
 * boot, and the deploy looked healthy. ConfigStore.open therefore writes the
 * initial document immediately, which turns that into a boot-time failure.
 */
export function writeDocAtomic(path: string, doc: StoreDoc): void {
  const tmp = `${path}.tmp`;
  const body = `${JSON.stringify(doc, null, 2)}\n`;
  // 0600: this file holds sealed credentials. Readable only by the connector's
  // uid, which entrypoint.sh has already made the owner of the directory.
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  const fd = openSync(tmp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort — the rename failure is what matters.
    }
    throw error;
  }
}

/**
 * Create the state directory if absent. In the container this is the mounted
 * volume, already chowned to `mcp` by entrypoint.sh before it drops privileges.
 *
 * The raw mkdir error is unhelpful outside a container: an unprivileged user
 * running the connector directly gets `EACCES ... mkdir /var/lib/mcp-connector`
 * with no hint that the location is configurable. Name the knob instead —
 * scripts/start-connector.sh sets it, so this fires for someone running
 * `node dist/index.js` by hand.
 */
export function ensureStateDir(path: string): void {
  const dir = dirname(path);
  if (existsSync(dir)) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `cannot create the config store directory ${dir}: ${code}. ` +
        `That is the container default; outside a container set CONNECTOR_STATE_DIR ` +
        `to a writable path (scripts/start-connector.sh does this for you).`,
      );
    }
    throw error;
  }
}
