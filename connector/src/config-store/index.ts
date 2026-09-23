import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { MasterKey } from "./master-key.js";
import { seal, open } from "./seal.js";
import {
  ensureStateDir,
  emptyDoc,
  readDoc,
  resolveStatePath,
  writeDocAtomic,
  type ApiClientDoc,
  type ControllerDoc,
  type StoreDoc,
} from "./store-file.js";
import type { TrustedIssuerConfig } from "../auth/jwt.js";

export interface ControllerRow {
  id: string;
  name: string;
  controllerUrl: string;
  connectorName: string;
  environment: string | null;
  authMode: "static-bearer" | "oauth2-cc";
  tunnelAuthToken: string | null;    // decrypted; null when authMode="oauth2-cc"
  oauthClientId: string | null;
  oauthClientSecret: string | null;  // decrypted
  oauthTokenUrl: string | null;
  registrationToken: string | null;  // decrypted; null before first register-ack
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastConnectedAt: Date | null;
  lastDisconnectReason: string | null;
}

export interface ControllerInput {
  name: string;
  controllerUrl: string;
  connectorName: string;
  environment: string | null;
  authMode: "static-bearer" | "oauth2-cc";
  tunnelAuthToken?: string;        // required when authMode="static-bearer"
  oauthClientId?: string;          // required when authMode="oauth2-cc"
  oauthClientSecret?: string;      // required when authMode="oauth2-cc"
  oauthTokenUrl?: string;          // required when authMode="oauth2-cc"
}

export interface NetworkAccessState {
  enabled: boolean;
}

export interface ApiClientSummary {
  clientId: string;
  name: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

const iso = (d: Date): string => d.toISOString();
const toDate = (s: string): Date => new Date(s);
const toDateOrNull = (s: string | null): Date | null => (s === null ? null : new Date(s));
const b64 = (buf: Buffer): string => buf.toString("base64");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64");

/**
 * The connector's configuration store, backed by a sealed JSON file on the
 * state volume. See architectural-plans/DB-TO-FILE.md.
 *
 * Every public method signature is unchanged from the Postgres implementation
 * this replaced, so no caller moved. Methods stay `async` even though the
 * backend is synchronous file I/O — changing signatures would touch every
 * caller for no benefit, and leaves room for a future backend.
 */
export class ConfigStore {
  /**
   * Serialises mutations. Postgres was arbitrating writes for us and this is
   * the one thing lost in the swap, so it is designed in rather than patched
   * on: two in-process writers exist — the inspector's routes, and the
   * frame-router persisting a registration token after register-ack. With
   * whole-file read-modify-write, an interleaving would let the frame-router
   * write back a stale document and silently discard an operator's Configure
   * Tunnel submit.
   *
   * The read happens INSIDE the lock (see `mutate`), which is what makes this
   * correct — a read taken before queueing would reintroduce the same race.
   */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private path: string, private key: MasterKey) {}

  static async open(masterKey: MasterKey): Promise<ConfigStore> {
    const path = resolveStatePath();
    ensureStateDir(path);

    if (!existsSync(path)) {
      // Write the initial document NOW rather than on first mutation. Parity
      // with the old `INSERT INTO encryption_meta` on first boot, and it turns
      // an unwritable state directory into a boot failure instead of a failure
      // on the operator's first Configure Tunnel submit — the lazy-write trap
      // that made agentic-memory's EACCES look like a healthy deploy.
      writeDocAtomic(path, emptyDoc(masterKey.fingerprint));
      return new ConfigStore(path, masterKey);
    }

    const doc = readDoc(path);
    if (doc.keyFingerprint !== masterKey.fingerprint) {
      throw new Error(
        `master key does not match the fingerprint recorded in ${path}. ` +
        `Restore the original key, or move that file aside and re-add the ` +
        `controller via the inspector (which discards the sealed tunnel identity).`,
      );
    }
    return new ConfigStore(path, masterKey);
  }

  private read(): StoreDoc {
    return readDoc(this.path);
  }

  /**
   * Read-modify-write under the queue. `fn` mutates the document in place and
   * may return a value; the document is written once `fn` resolves.
   */
  private mutate<T>(fn: (doc: StoreDoc) => T): Promise<T> {
    const run = this.writeQueue.then(() => {
      const doc = this.read();
      const result = fn(doc);
      writeDocAtomic(this.path, doc);
      return result;
    });
    // Keep the chain alive after a rejection, else one failed mutation would
    // wedge every later write. Callers still see their own rejection via `run`.
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private hydrate(c: ControllerDoc): ControllerRow {
    return {
      id: c.id,
      name: c.name,
      controllerUrl: c.controllerUrl,
      connectorName: c.connectorName,
      environment: c.environment,
      authMode: c.authMode,
      tunnelAuthToken: c.tunnelAuthTokenCt
        ? open(unb64(c.tunnelAuthTokenCt), this.key.bytes).toString("utf8")
        : null,
      oauthClientId: c.oauthClientId,
      oauthClientSecret: c.oauthClientSecretCt
        ? open(unb64(c.oauthClientSecretCt), this.key.bytes).toString("utf8")
        : null,
      oauthTokenUrl: c.oauthTokenUrl,
      registrationToken: c.registrationTokenCt
        ? open(unb64(c.registrationTokenCt), this.key.bytes).toString("utf8")
        : null,
      enabled: c.enabled,
      createdAt: toDate(c.createdAt),
      updatedAt: toDate(c.updatedAt),
      lastConnectedAt: toDateOrNull(c.lastConnectedAt),
      lastDisconnectReason: c.lastDisconnectReason,
    };
  }

  async getController(): Promise<ControllerRow | null> {
    const doc = this.read();
    const c = doc.controllers[0];
    return c ? this.hydrate(c) : null;
  }

  async upsertController(input: ControllerInput): Promise<ControllerRow> {
    if (!input.name || !input.controllerUrl || !input.connectorName) {
      throw new Error("name, controllerUrl, and connectorName are required");
    }

    return this.mutate((doc) => {
      // Read the prior authMode + sealed-secret presence so the "secret is
      // required" rule relaxes when the caller is only updating display
      // fields. Preservation is valid ONLY when authMode is unchanged; a
      // switch between static-bearer and oauth2-cc must supply the new secret.
      const prior = doc.controllers[0];
      const canPreserveTunnelAuthToken =
        prior?.authMode === "static-bearer" && prior?.tunnelAuthTokenCt !== null;
      const canPreserveOauthClientSecret =
        prior?.authMode === "oauth2-cc" && prior?.oauthClientSecretCt !== null;

      if (input.authMode === "static-bearer" && !input.tunnelAuthToken && !canPreserveTunnelAuthToken) {
        throw new Error("tunnelAuthToken is required when authMode is static-bearer");
      }
      if (input.authMode === "oauth2-cc") {
        if (!input.oauthClientId || !input.oauthTokenUrl) {
          throw new Error("oauthClientId and oauthTokenUrl are required when authMode is oauth2-cc");
        }
        if (!input.oauthClientSecret && !canPreserveOauthClientSecret) {
          throw new Error("oauthClientSecret is required when authMode is oauth2-cc");
        }
      }

      const now = iso(new Date());
      const nextTunnelCt =
        input.authMode === "static-bearer" && input.tunnelAuthToken
          ? b64(seal(Buffer.from(input.tunnelAuthToken, "utf8"), this.key.bytes))
          : null;
      const nextOauthCt =
        input.authMode === "oauth2-cc" && input.oauthClientSecret
          ? b64(seal(Buffer.from(input.oauthClientSecret, "utf8"), this.key.bytes))
          : null;

      const next: ControllerDoc = {
        id: prior ? prior.id : randomUUID(),
        name: input.name,
        controllerUrl: input.controllerUrl,
        connectorName: input.connectorName,
        environment: input.environment,
        authMode: input.authMode,
        // `?? prior` mirrors the old SQL COALESCE(EXCLUDED.x, controllers.x).
        // Note the inherited quirk this preserves deliberately: switching to
        // the other posture leaves the previous posture's sealed secret in
        // place, because the incoming value is null. It is unreachable — the
        // authMode decides which one callers read — so behaviour parity wins
        // over tidying it up during a backend swap.
        tunnelAuthTokenCt: nextTunnelCt ?? prior?.tunnelAuthTokenCt ?? null,
        oauthClientId: input.oauthClientId ?? null,
        oauthClientSecretCt: nextOauthCt ?? prior?.oauthClientSecretCt ?? null,
        oauthTokenUrl: input.oauthTokenUrl ?? null,
        registrationTokenCt: prior?.registrationTokenCt ?? null,
        enabled: prior?.enabled ?? true,
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
        lastConnectedAt: prior?.lastConnectedAt ?? null,
        lastDisconnectReason: prior?.lastDisconnectReason ?? null,
      };

      doc.controllers = [next];
      return this.hydrate(next);
    });
  }

  async updateRegistrationToken(id: string, token: string): Promise<void> {
    const ct = b64(seal(Buffer.from(token, "utf8"), this.key.bytes));
    await this.mutate((doc) => {
      const c = doc.controllers.find((x) => x.id === id);
      if (!c) return;
      c.registrationTokenCt = ct;
      c.updatedAt = iso(new Date());
    });
  }

  async clearRegistrationToken(id: string): Promise<void> {
    await this.mutate((doc) => {
      const c = doc.controllers.find((x) => x.id === id);
      if (!c) return;
      c.registrationTokenCt = null;
      c.updatedAt = iso(new Date());
    });
  }

  async recordConnect(id: string): Promise<void> {
    await this.mutate((doc) => {
      const c = doc.controllers.find((x) => x.id === id);
      if (c) c.lastConnectedAt = iso(new Date());
    });
  }

  async recordDisconnect(id: string, reason: string): Promise<void> {
    await this.mutate((doc) => {
      const c = doc.controllers.find((x) => x.id === id);
      if (c) c.lastDisconnectReason = reason;
    });
  }

  async deleteController(): Promise<boolean> {
    return this.mutate((doc) => {
      const had = doc.controllers.length > 0;
      doc.controllers = [];
      return had;
    });
  }

  // ─── Network access ─────────────────────────────────────────────────────
  // Gates ONLY the machine API being reachable non-loopback. There is no
  // admin secret / session concept — the operator UI stays loopback-only
  // unconditionally, forever (see CLAUDE.md "Inspector UI notes").

  async getNetworkAccessState(): Promise<NetworkAccessState> {
    return { enabled: this.read().networkAccess.enabled };
  }

  // Called once, the first time an operator adds an API client — never
  // reverts automatically, even if every client is later removed.
  async setNetworkAccessEnabled(enabled: boolean): Promise<void> {
    await this.mutate((doc) => {
      doc.networkAccess.enabled = enabled;
    });
  }

  // ─── Federated JWT trust config ─────────────────────────────────────────
  // Presence = federated mode configured. Not sealed — issuer/JWKS URL/
  // audience are public IdP metadata, not secrets. The three fields move
  // together: set writes all three, clear nulls the lot, get returns
  // undefined unless all three are present.

  async getTrustedIssuerConfig(): Promise<TrustedIssuerConfig | undefined> {
    const t = this.read().trustedIssuer;
    if (!t || !t.issuer || !t.jwksUrl || !t.audience) return undefined;
    return { issuer: t.issuer, jwksUrl: t.jwksUrl, audience: t.audience };
  }

  async setTrustedIssuerConfig(config: TrustedIssuerConfig): Promise<void> {
    await this.mutate((doc) => {
      doc.trustedIssuer = {
        issuer: config.issuer,
        jwksUrl: config.jwksUrl,
        audience: config.audience,
      };
    });
  }

  async clearTrustedIssuerConfig(): Promise<void> {
    await this.mutate((doc) => {
      doc.trustedIssuer = null;
    });
  }

  // ─── Machine-API client credentials ────────────────────────────────────

  async mintApiClient(name?: string): Promise<{ clientId: string; clientSecret: string }> {
    const clientId = randomBytes(16).toString("hex");
    const clientSecret = randomBytes(32).toString("base64url");
    const entry: ApiClientDoc = {
      clientId,
      clientSecretCt: b64(seal(Buffer.from(clientSecret, "utf8"), this.key.bytes)),
      name: name ?? null,
      createdAt: iso(new Date()),
      revokedAt: null,
    };
    await this.mutate((doc) => {
      doc.apiClients.push(entry);
    });
    return { clientId, clientSecret };
  }

  // Unknown client_id and wrong-secret-for-a-known-client_id both return
  // false — callers must not distinguish the two in their error response
  // (OAuth2 §5.2 invalid_client shape).
  async verifyApiClient(clientId: string, clientSecret: string): Promise<boolean> {
    if (typeof clientId !== "string" || typeof clientSecret !== "string" || clientSecret.length === 0) {
      return false;
    }
    const entry = this.read().apiClients.find(
      (c) => c.clientId === clientId && c.revokedAt === null,
    );
    if (!entry) return false;
    const known = open(unb64(entry.clientSecretCt), this.key.bytes);
    const supplied = Buffer.from(clientSecret, "utf8");
    if (known.length !== supplied.length) return false;
    return timingSafeEqual(known, supplied);
  }

  async revokeApiClient(clientId: string): Promise<boolean> {
    return this.mutate((doc) => {
      const entry = doc.apiClients.find((c) => c.clientId === clientId && c.revokedAt === null);
      if (!entry) return false;
      entry.revokedAt = iso(new Date());
      return true;
    });
  }

  // Hard-deletes the entry. Only ever allowed for an ALREADY-revoked client
  // — enforced here, not just in the UI, so a caller can't skip straight
  // to deleting a still-active credential without revoking it first.
  async deleteApiClient(clientId: string): Promise<boolean> {
    return this.mutate((doc) => {
      const before = doc.apiClients.length;
      doc.apiClients = doc.apiClients.filter(
        (c) => !(c.clientId === clientId && c.revokedAt !== null),
      );
      return doc.apiClients.length < before;
    });
  }

  async listApiClients(): Promise<ApiClientSummary[]> {
    return this.read()
      .apiClients.slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((c) => ({
        clientId: c.clientId,
        name: c.name,
        createdAt: toDate(c.createdAt),
        revokedAt: toDateOrNull(c.revokedAt),
      }));
  }

  // Retained for interface parity — there is no pool to drain now. Callers
  // (tests, shutdown paths) still call it.
  async close(): Promise<void> {}
}
