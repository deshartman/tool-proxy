import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { MasterKey } from "./master-key.js";
import { mintProxyId } from "../identity/proxy-id.js";
import { seal, open } from "./seal.js";
import {
  ensureStateDir,
  emptyDoc,
  readDoc,
  resolveStatePath,
  writeDocAtomic,
  type ControllerDoc,
  type StoreDoc,
  type TrustedIssuerDoc,
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
  /** The controller entry this client drives; absent only before any controller exists. */
  controllerId: string | null;
}

const iso = (d: Date): string => d.toISOString();
const toDate = (s: string): Date => new Date(s);
const toDateOrNull = (s: string | null): Date | null => (s === null ? null : new Date(s));
const b64 = (buf: Buffer): string => buf.toString("base64");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64");

/**
 * The connector's configuration store, backed by a sealed JSON file on the
 * state volume.
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
    let dirty = false;
    if (doc.proxyId === undefined) {
      // Back-fill a store with neither key. Done here, before the
      // constructor, rather than through mutate(): no other writer can hold
      // this store yet, and the id must exist before anything reads it.
      // Written once; never re-minted for a store that already has one (a
      // legacy `shimId` was already carried into proxyId by readDoc).
      doc.proxyId = mintProxyId();
    }
    // Dual-write: keep the legacy key equal to proxyId for one release, and
    // persist a shimId -> proxyId migration the first time it is seen.
    if (doc.shimId !== doc.proxyId) doc.shimId = doc.proxyId;
    const raw = JSON.parse(readFileSync(path, "utf8")) as { proxyId?: unknown; shimId?: unknown };
    if (raw.proxyId !== doc.proxyId || raw.shimId !== doc.shimId) dirty = true;
    // A pre-Phase-6 store had at most one controller, so binding its legacy
    // trusted issuer and API clients to that controller is exact, not a guess.
    if (doc.controllers[0] && adoptLegacyBindings(doc, doc.controllers[0])) dirty = true;
    if (dirty) writeDocAtomic(path, doc);
    return new ConfigStore(path, masterKey);
  }

  /** This proxy's identity. Always present after open(). */
  getProxyId(): string {
    const id = this.read().proxyId;
    if (!id) throw new Error("config store has no proxyId — open() must back-fill it");
    return id;
  }

  /**
   * Mint a new identity, for a cloned volume (two proxies sharing one id). The
   * operator's deliberate act: every procedure ref to this proxy's tools breaks
   * until the platform re-points them, so this is never called automatically.
   */
  regenerateProxyId(): Promise<string> {
    return this.mutate((doc) => {
      doc.proxyId = mintProxyId();
      doc.shimId = doc.proxyId; // legacy key, dual-written for one release
      return doc.proxyId;
    });
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

  // ─── Controllers ────────────────────────────────────────────────────────
  // One entry per controller this proxy dials (MULTI-PLATFORM-MCP Phase 6).
  // Each is one TunnelWorkspace, identified by the entry's `id`, which is
  // stable across credential rotation.

  async listControllers(): Promise<ControllerRow[]> {
    return this.read().controllers.map((c) => this.hydrate(c));
  }

  async getControllerById(id: string): Promise<ControllerRow | null> {
    const c = this.read().controllers.find((x) => x.id === id);
    return c ? this.hydrate(c) : null;
  }

  /**
   * The single-controller view that predates Phase 6: the first entry, or
   * null. Kept for callers that only ever deal with one controller; anything
   * that may see several uses listControllers / getControllerById.
   */
  async getController(): Promise<ControllerRow | null> {
    const doc = this.read();
    const c = doc.controllers[0];
    return c ? this.hydrate(c) : null;
  }

  /** Add a new controller entry — a new workspace. */
  async addController(input: ControllerInput): Promise<ControllerRow> {
    requireIdentityFields(input);
    return this.mutate((doc) => {
      const next = this.buildControllerDoc(undefined, input);
      doc.controllers.push(next);
      // The FIRST controller inherits whatever was configured before any
      // controller existed: the legacy trusted issuer and unbound API clients.
      if (doc.controllers.length === 1) adoptLegacyBindings(doc, next);
      return this.hydrate(next);
    });
  }

  /** Replace one entry's fields, keeping its id, token and sealed secrets where allowed. */
  async updateController(id: string, input: ControllerInput): Promise<ControllerRow> {
    requireIdentityFields(input);
    return this.mutate((doc) => {
      const index = doc.controllers.findIndex((x) => x.id === id);
      if (index < 0) throw new Error(`no controller with id ${id}`);
      const next = this.buildControllerDoc(doc.controllers[index], input);
      doc.controllers[index] = next;
      return this.hydrate(next);
    });
  }

  /**
   * Remove one entry. API clients bound to it are left in place but can no
   * longer drive anything — their workspace is gone, so a call fails closed.
   */
  async removeController(id: string): Promise<boolean> {
    return this.mutate((doc) => {
      const before = doc.controllers.length;
      doc.controllers = doc.controllers.filter((x) => x.id !== id);
      return doc.controllers.length < before;
    });
  }

  /**
   * Pre-Phase-6 single-controller upsert: update the first entry, or add one.
   * The update-or-add decision is made INSIDE the lock — taken outside it,
   * concurrent first-time upserts each see an empty store and each add an
   * entry (pinned by write-serialisation.test.ts).
   */
  async upsertController(input: ControllerInput): Promise<ControllerRow> {
    requireIdentityFields(input);
    return this.mutate((doc) => {
      const prior = doc.controllers[0];
      const next = this.buildControllerDoc(prior, input);
      if (prior) {
        doc.controllers[0] = next;
      } else {
        doc.controllers.push(next);
        adoptLegacyBindings(doc, next);
      }
      return this.hydrate(next);
    });
  }

  private buildControllerDoc(prior: ControllerDoc | undefined, input: ControllerInput): ControllerDoc {
    // Read the prior authMode + sealed-secret presence so the "secret is
    // required" rule relaxes when the caller is only updating display
    // fields. Preservation is valid ONLY when authMode is unchanged; a
    // switch between static-bearer and oauth2-cc must supply the new secret.
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

    return {
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
      // Rotating an entry's credential keeps its workspace, and with it the
      // workspace's federated trust config.
      ...(prior?.trustedIssuer ? { trustedIssuer: prior.trustedIssuer } : {}),
    };
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

  /** Pre-Phase-6: remove every controller entry. */
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

  // Per controller entry since Phase 6 (§5.6): each workspace has its own
  // issuer + audience, and a federated token is routed to the entry whose
  // `iss` + `aud` it carries. `controllerId` is optional on every method so
  // the single-controller callers keep working: omitted, it means "the only
  // controller" (or the legacy top-level slot when there is none), and it is
  // an error to omit it once there are several.

  async getTrustedIssuerConfig(controllerId?: string): Promise<TrustedIssuerConfig | undefined> {
    const doc = this.read();
    const slot = controllerId === undefined && doc.controllers.length === 0
      ? doc.trustedIssuer
      : resolveController(doc, controllerId).trustedIssuer;
    return toTrustedIssuer(slot);
  }

  /** Every configured trusted issuer, with the controller entry it belongs to. */
  async listTrustedIssuers(): Promise<Array<TrustedIssuerConfig & { controllerId: string }>> {
    const out: Array<TrustedIssuerConfig & { controllerId: string }> = [];
    for (const c of this.read().controllers) {
      const t = toTrustedIssuer(c.trustedIssuer);
      if (t) out.push({ ...t, controllerId: c.id });
    }
    return out;
  }

  /** The controller entry whose trusted issuer is exactly this `iss` + `aud`. */
  async findControllerByIssuer(issuer: string, audience: string): Promise<string | undefined> {
    return (await this.listTrustedIssuers()).find((t) => t.issuer === issuer && t.audience === audience)?.controllerId;
  }

  async setTrustedIssuerConfig(config: TrustedIssuerConfig, controllerId?: string): Promise<void> {
    await this.mutate((doc) => {
      const value = { issuer: config.issuer, jwksUrl: config.jwksUrl, audience: config.audience };
      if (controllerId === undefined && doc.controllers.length === 0) {
        doc.trustedIssuer = value;
        return;
      }
      const target = resolveController(doc, controllerId);
      // One IdP must not mint tokens valid for two tunnels: a federated token
      // is routed by iss + aud, so a second entry with the same pair would make
      // the route ambiguous.
      const clash = doc.controllers.find((c) =>
        c.id !== target.id && c.trustedIssuer?.issuer === value.issuer && c.trustedIssuer?.audience === value.audience);
      if (clash) {
        throw new Error(`issuer ${value.issuer} with audience ${value.audience} is already trusted by another controller — use a distinct audience per controller`);
      }
      target.trustedIssuer = value;
    });
  }

  async clearTrustedIssuerConfig(controllerId?: string): Promise<void> {
    await this.mutate((doc) => {
      if (controllerId === undefined && doc.controllers.length === 0) {
        doc.trustedIssuer = null;
        return;
      }
      resolveController(doc, controllerId).trustedIssuer = null;
    });
  }

  // ─── Machine-API client credentials ────────────────────────────────────

  // A client is bound to one controller entry (§5.6): its tokens drive that
  // workspace's tunnel and no other. `controllerId` omitted means the only
  // controller; with none configured yet the client stays unbound and is bound
  // to the first controller added (adoptLegacyBindings).
  async mintApiClient(name?: string, controllerId?: string): Promise<{ clientId: string; clientSecret: string }> {
    const clientId = randomBytes(16).toString("hex");
    const clientSecret = randomBytes(32).toString("base64url");
    await this.mutate((doc) => {
      const bound = controllerId === undefined && doc.controllers.length === 0
        ? undefined
        : resolveController(doc, controllerId).id;
      doc.apiClients.push({
        clientId,
        clientSecretCt: b64(seal(Buffer.from(clientSecret, "utf8"), this.key.bytes)),
        name: name ?? null,
        createdAt: iso(new Date()),
        revokedAt: null,
        ...(bound ? { controllerId: bound } : {}),
      });
    });
    return { clientId, clientSecret };
  }

  /** The controller entry an active client is bound to, if any. */
  async apiClientController(clientId: string): Promise<string | undefined> {
    const entry = this.read().apiClients.find((c) => c.clientId === clientId && c.revokedAt === null);
    return entry?.controllerId;
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
        controllerId: c.controllerId ?? null,
      }));
  }

  // Retained for interface parity — there is no pool to drain now. Callers
  // (tests, shutdown paths) still call it.
  async close(): Promise<void> {}
}

function requireIdentityFields(input: ControllerInput): void {
  if (!input.name || !input.controllerUrl || !input.connectorName) {
    throw new Error("name, controllerUrl, and connectorName are required");
  }
}

/**
 * The controller entry a per-controller setting applies to. `id` omitted is
 * the single-controller shorthand: valid only while there is exactly one, so a
 * caller that predates Phase 6 can never silently pick one of several.
 */
function resolveController(doc: StoreDoc, id: string | undefined): ControllerDoc {
  if (id !== undefined) {
    const c = doc.controllers.find((x) => x.id === id);
    if (!c) throw new Error(`no controller with id ${id}`);
    return c;
  }
  if (doc.controllers.length === 1) return doc.controllers[0];
  if (doc.controllers.length === 0) throw new Error("no controller configured");
  throw new Error("several controllers are configured — name one");
}

function toTrustedIssuer(t: TrustedIssuerDoc | null | undefined): TrustedIssuerConfig | undefined {
  if (!t || !t.issuer || !t.jwksUrl || !t.audience) return undefined;
  return { issuer: t.issuer, jwksUrl: t.jwksUrl, audience: t.audience };
}

/**
 * Move settings made before any controller existed (or before Phase 6) onto a
 * controller entry: the top-level trusted issuer, and every unbound API client.
 * Returns whether anything moved. Only ever applied to the first controller,
 * which is exact for a pre-Phase-6 store (it had at most one).
 */
function adoptLegacyBindings(doc: StoreDoc, controller: ControllerDoc): boolean {
  let moved = false;
  if (doc.trustedIssuer) {
    if (!controller.trustedIssuer) controller.trustedIssuer = doc.trustedIssuer;
    doc.trustedIssuer = null;
    moved = true;
  }
  for (const client of doc.apiClients) {
    if (client.controllerId === undefined) {
      client.controllerId = controller.id;
      moved = true;
    }
  }
  return moved;
}
