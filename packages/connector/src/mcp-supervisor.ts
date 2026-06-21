// Live MCP supervisor (W-B1 of MCP-LOADING).
//
// Owns the lifecycle of every MCP child the connector runs:
//   * Type 1 (customer-authored Type 1 with server.ts) — spawn `tsx server.ts`
//   * Type 1 dropin (no server.ts; tools/*.ts only) — spawn the SDK's
//     dropin-runner against the folder
//   * Type 2 stdio — connect via the existing servers/connect path
//   * Type 2 http (external endpoint) — connect via the existing path
//   * Type 3 bundled — same as Type 2 stdio (the spec is already synthetic)
//
// At boot the supervisor takes the resolved spec list, spawns/connects each,
// and surfaces an McpServerConnection map the dispatcher consumes. It also
// keeps a per-MCP McpStatus so the inspector can show process state, creds
// source, and restart history.
//
// At runtime the supervisor offers restart(name, newEnv): a creds-update
// from the controller (or an inspector "Reload creds" click) calls this to
// stop the child, swap env, respawn, and reconnect — without going through
// the WS reconnect path. sameMcpServers() in boot/lifecycle stays untouched.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import {
  isType1Spawn,
  type McpServerSpec,
} from "./config.js";
import {
  isDropinSpec,
  dropinRunnerPath,
  type DropinSpec,
} from "./dropin.js";
import { envNumber } from "./env.js";
import { connectServer } from "./servers/connect.js";
import type { McpServerConnection } from "./servers/index.js";
import type { Logger } from "./logger.js";
import { resolveAuthHeaders, isSyncResolvable } from "./auth/resolve-mcp-auth.js";
import { resolveOAuthBearer, type OAuthProviderCache } from "./auth/resolve-mcp-auth-async.js";

// Resolve tsx's bin from the connector package's own node_modules — same
// approach as the original spawner. Going via package.json sidesteps tsx's
// `exports` map blocking subpath access to ./dist/cli.mjs.
const TSX_BIN = join(dirname(require.resolve("tsx/package.json")), "dist/cli.mjs");

// Spec union the supervisor accepts. Dropin specs are an internal extension
// of Type 1 (transport: http + dir) carrying a marker; the rest is plain
// McpServerSpec.
export type SupervisedSpec = McpServerSpec | DropinSpec;

export interface McpStatus {
  name: string;
  process: "running" | "stopped" | "restarting" | "permanently-failed";
  credsSource: "controller" | "dir/.env" | "yaml" | "none";
  credsLastUpdated?: number;
  restartCount: number;
  lastRestartReason?: string;
  toolsCount: number;
}

interface Entry {
  spec: SupervisedSpec;
  // Controller-supplied env values. Merged on every spawn so a creds-update
  // → restart picks them up. Cleared when controller returns nothing.
  controllerEnv: Record<string, string>;
  child?: ChildProcess;
  connection?: McpServerConnection;
  status: McpStatus;
}

export interface SupervisorOpts {
  basePort?: number;
  readyTimeoutMs?: number;
  log: Logger;
  // Called whenever a spawn or restart happens. Useful for logging which env
  // source each key came from (W-B3 deprecation tracker).
  onSpawn?: (info: { name: string; envSources: Record<string, EnvSource> }) => void;
  // Shared connection map. The supervisor mutates this on every spawn /
  // restart so the dispatcher and inspector pick up new connections without
  // rewiring closures. Caller owns the map's lifetime.
  servers: Map<string, McpServerConnection>;
  // Called after a restart completes successfully. The boot wiring uses this
  // to push a manifest-delta if the new child advertises a different toolset.
  onRestart?: (name: string) => void | Promise<void>;
}

export type EnvSource = "controller" | "dir/.env" | "yaml" | "process.env";

export class McpSupervisor {
  private readonly entries = new Map<string, Entry>();
  private readonly reservedPorts = new Set<number>();
  private readonly opts: Required<Pick<SupervisorOpts, "basePort" | "readyTimeoutMs">> & SupervisorOpts;
  // W-E4: per-supervisor OAuth2 client_credentials provider cache, shared
  // across MCPs. Key = `${tokenUrl} ${clientId} ${clientSecret}`. Two MCPs
  // with identical OAuth2 creds reuse the same cached JWT — deliberate,
  // since the controller-side row mints the same secret pair for both.
  // Any change to one of the three keys invalidates the cache slot.
  private readonly oauthCache: OAuthProviderCache = new Map();

  constructor(opts: SupervisorOpts) {
    this.opts = {
      basePort: opts.basePort ?? envNumber("MCP_BASE_PORT", 7100),
      readyTimeoutMs: opts.readyTimeoutMs ?? 5000,
      ...opts,
    };
  }

  // Register specs without spawning. Use this when the boot flow wants to
  // collect creds before the first spawn.
  register(specs: SupervisedSpec[]): void {
    for (const spec of specs) {
      if (this.entries.has(spec.name)) continue;
      this.entries.set(spec.name, {
        spec,
        controllerEnv: {},
        status: {
          name: spec.name,
          process: "stopped",
          credsSource: spec.env ? "dir/.env" : "none",
          restartCount: 0,
          toolsCount: 0,
        },
      });
    }
  }

  // Boot path: spawn every Type 1/dropin child, then connect to every
  // server. Mutates http+dir+no-endpoint specs to set their endpoint URL
  // and populates the shared servers map so callers can wire dispatcher /
  // inspector against it.
  async startAll(): Promise<Map<string, McpServerConnection>> {
    for (const entry of this.entries.values()) {
      await this.startEntry(entry, "boot");
    }
    return this.opts.servers;
  }

  // Apply controller-supplied env for `mcp`. If the spec hasn't been spawned
  // yet (still inside the 5s soft-wait), the env is buffered and picked up
  // by startAll. If already spawned, the child is restarted with the new
  // merged env.
  async applyControllerEnv(
    mcp: string,
    env: Record<string, string>,
    source: "twilio-tunnel-row" | "operator-entered" | "none",
    reason = "creds-update",
  ): Promise<{ applied: boolean; restarted: boolean }> {
    const entry = this.entries.get(mcp);
    if (!entry) return { applied: false, restarted: false };

    // Skip restart when the controller has nothing to add. `source: "none"`
    // with empty env means "no row for this MCP — fall back to dir/.env"
    // per docs/MCP-PROTOCOL.md. Restarting a running child for an empty
    // payload would kill it and produce no behavioural change. Same when
    // the env is identical to what we already merged on a prior call.
    const isEmptyNone = source === "none" && Object.keys(env).length === 0;
    const sameAsPrev = envEquals(entry.controllerEnv, env);
    if (isEmptyNone || sameAsPrev) {
      return { applied: true, restarted: false };
    }

    entry.controllerEnv = env;
    entry.status.credsLastUpdated = nowMs();
    entry.status.credsSource = source === "none" ? entry.status.credsSource : "controller";
    if (entry.child) {
      await this.restartEntry(entry, reason);
      return { applied: true, restarted: true };
    }
    return { applied: true, restarted: false };
  }

  async restart(name: string, reason = "manual"): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry) return false;
    await this.restartEntry(entry, reason);
    return true;
  }

  // Controller-config (W-E2) hooks. The roster coordinator needs to add a
  // single entry, start it, replace its spec, and remove it — operations
  // that the boot path (register + startAll) doesn't expose individually.

  hasEntry(name: string): boolean {
    return this.entries.has(name);
  }

  // Add ONE spec post-boot. Idempotent: a duplicate name is silently skipped
  // (matches register()'s behavior). Caller must call startOne() to spawn.
  registerOne(spec: SupervisedSpec): void {
    if (this.entries.has(spec.name)) return;
    this.entries.set(spec.name, {
      spec,
      controllerEnv: {},
      status: {
        name: spec.name,
        process: "stopped",
        credsSource: spec.env ? "dir/.env" : "none",
        restartCount: 0,
        toolsCount: 0,
      },
    });
  }

  // Start a single registered entry. Used by the roster coordinator after
  // registerOne() — startAll() is for the boot pass.
  async startOne(name: string, reason = "controller-config"): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry) return false;
    await this.startEntry(entry, reason);
    return true;
  }

  // Replace a registered spec in place. Triggers a restart if the entry was
  // running. Used by the roster coordinator on a config-update delta where
  // the upstream URL / command / auth shape changed.
  async replaceSpec(name: string, spec: SupervisedSpec, reason = "config-update"): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry) return false;
    entry.spec = spec;
    if (entry.connection || entry.child) {
      await this.restartEntry(entry, reason);
    }
    return true;
  }

  // Stop and forget a registered entry. Used by the roster coordinator on a
  // config-remove delta. Returns false if no entry by that name.
  async unregister(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry) return false;
    await this.stopEntry(entry);
    this.entries.delete(name);
    return true;
  }

  // Iterate the live status records. Snapshot — caller must not mutate.
  statusList(): McpStatus[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.status }));
  }

  connectionsMap(): Map<string, McpServerConnection> {
    return this.opts.servers;
  }

  // Aggregate the envKeys hint for a spec by querying the running child's
  // /envkeys endpoint. Used by boot's creds-request build. For non-Type-1
  // (stdio / http external), there's no envKeys endpoint — return [].
  async fetchEnvKeys(name: string): Promise<string[]> {
    const entry = this.entries.get(name);
    if (!entry) return [];
    const spec = entry.spec;
    if (spec.transport !== "http") return [];
    const endpoint = (spec as { endpoint?: string }).endpoint;
    if (!endpoint) return [];
    try {
      const url = new URL(endpoint);
      url.pathname = "/envkeys";
      const res = await fetch(url.toString());
      if (!res.ok) return [];
      const body = await res.json() as { envKeys?: unknown };
      const keys: string[] = Array.isArray(body.envKeys)
        ? body.envKeys.filter((k): k is string => typeof k === "string")
        : [];
      return keys;
    } catch {
      return [];
    }
  }

  async stopAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      await this.stopEntry(entry);
    }
  }

  setToolsCount(name: string, count: number): void {
    const entry = this.entries.get(name);
    if (entry) entry.status.toolsCount = count;
  }

  // ─── private ────────────────────────────────────────────────────────────

  private async startEntry(entry: Entry, reason: string): Promise<void> {
    const spec = entry.spec;
    const isSpawn = isType1Spawn(spec) || isDropinSpec(spec);
    if (isSpawn) {
      await this.spawnChild(entry);
    }
    // W-E3 / W-E4: resolve 3rd-party MCP auth shape into outbound headers.
    // Only HTTP-family transports — stdio entries pass env to the child
    // process via the existing per-spec env path. yaml entries leave
    // spec.auth undefined and the helper is skipped.
    if (spec.transport === "http" && (spec as { auth?: unknown }).auth !== undefined) {
      await this.resolveSpecHeaders(entry);
    }
    try {
      entry.connection = await connectServer(entry.spec);
      this.opts.servers.set(spec.name, entry.connection);
      entry.status.process = "running";
      entry.status.lastRestartReason = reason;
    } catch (err) {
      entry.status.process = "permanently-failed";
      this.opts.log.error({ name: spec.name, err: err as Error }, `failed to connect to MCP child`);
      throw err;
    }
  }

  // Translate the entry's auth shape + controllerEnv into spec.headers,
  // which servers/http.ts passes through StreamableHTTPClientTransport's
  // requestInit.headers. Logs but does NOT throw on missing-key / mint-fail
  // — the upstream's 401 is the operator-facing signal that creds need
  // attention, faster than a connect-time abort.
  private async resolveSpecHeaders(entry: Entry): Promise<void> {
    const spec = entry.spec as { auth?: unknown; headers?: Record<string, string> };
    const auth = spec.auth as import("./tunnel/frames.js").McpAuthSpec | undefined;
    if (!auth) return;
    if (isSyncResolvable(auth)) {
      const result = resolveAuthHeaders(auth, entry.controllerEnv);
      this.applyResolvedHeaders(entry, result.headers);
      if (result.missingEnvKeys.length > 0) {
        this.opts.log.warn(
          { name: entry.spec.name, missingEnvKeys: result.missingEnvKeys, authKind: auth.kind },
          `3rd-party MCP missing creds — connecting without auth, expect 401 from upstream`,
        );
      }
      return;
    }
    if (auth.kind === "oauth2-client-credentials") {
      // W-E4: mint a JWT against the controller-supplied tokenUrl /
      // clientId / clientSecret and stamp Authorization: Bearer onto the
      // spec. The provider does <60s pre-expiry refresh on every
      // accessToken() call, so a reconnect-driven re-resolve picks up a
      // fresh JWT for free. Mid-session 401s recover via supervisor.restart
      // (mint-at-connect, restart-on-401 — chosen over a fetch-override
      // wrapper to avoid coupling to SDK transport internals).
      const result = await resolveOAuthBearer(auth, entry.controllerEnv, this.oauthCache);
      this.applyResolvedHeaders(entry, result.headers);
      if (result.missingEnvKeys.length > 0) {
        this.opts.log.warn(
          { name: entry.spec.name, missingEnvKeys: result.missingEnvKeys, authKind: auth.kind },
          `3rd-party MCP OAuth2 missing creds — connecting without auth, expect 401 from upstream`,
        );
      } else if (result.error) {
        this.opts.log.warn(
          { name: entry.spec.name, err: result.error, authKind: auth.kind },
          `3rd-party MCP OAuth2 token mint failed — connecting without auth, expect 401 from upstream`,
        );
      }
    }
  }

  // Replace the resolver's prior output on every call. A creds-update that
  // shrinks the auth (e.g. operator clears the bearer envKey) MUST clear
  // the previously-set Authorization header, not merge over it.
  private applyResolvedHeaders(entry: Entry, headers: Record<string, string>): void {
    const spec = entry.spec as { headers?: Record<string, string> };
    if (Object.keys(headers).length === 0) {
      delete spec.headers;
      return;
    }
    spec.headers = headers;
  }

  private async restartEntry(entry: Entry, reason: string): Promise<void> {
    entry.status.process = "restarting";
    entry.status.lastRestartReason = reason;
    entry.status.restartCount += 1;
    await this.stopEntry(entry);
    await this.startEntry(entry, reason);
    await this.opts.onRestart?.(entry.spec.name);
  }

  private async stopEntry(entry: Entry): Promise<void> {
    if (entry.connection) {
      try { await entry.connection.close(); } catch { /* swallow */ }
      entry.connection = undefined;
      this.opts.servers.delete(entry.spec.name);
    }
    if (entry.child) {
      const proc = entry.child;
      const port = (entry.spec as { __port?: number }).__port;
      if (proc.exitCode == null && proc.signalCode == null) {
        proc.kill("SIGTERM");
        await new Promise<void>((res) => {
          const t = setTimeout(() => { proc.kill("SIGKILL"); res(); }, 2000);
          proc.once("exit", () => { clearTimeout(t); res(); });
        });
      }
      entry.child = undefined;
      if (typeof port === "number") this.reservedPorts.delete(port);
      // Restore the spec to its pre-spawn shape so isType1Spawn() classifies
      // it correctly on the next startEntry. spawnChild() mutates `endpoint`
      // and `__port` at boot; without clearing them here, a creds-driven
      // restart would skip respawn (isType1Spawn returns false when endpoint
      // is set) and try to connect to the dead port → ECONNREFUSED.
      // Gated on `__port` presence: only spawn entries get __port set, so
      // this leaves Type 2 http entries' author-supplied endpoint untouched.
      if (typeof port === "number") {
        const mutSpec = entry.spec as { endpoint?: string; __port?: number };
        delete mutSpec.endpoint;
        delete mutSpec.__port;
      }
    }
    entry.status.process = "stopped";
  }

  private async spawnChild(entry: Entry): Promise<void> {
    const spec = entry.spec;
    const port = await this.findAvailablePort(this.opts.basePort);
    this.reservedPorts.add(port);

    const dir = (spec as { dir: string }).dir;
    const dropin = isDropinSpec(spec);
    const childArgs = dropin ? [TSX_BIN, dropinRunnerPath()] : [TSX_BIN, resolve(dir, "server.ts")];
    const sources: Record<string, EnvSource> = {};
    const env = this.mergeEnv(entry, sources, { PORT: String(port) });
    if (dropin) {
      env.DROPIN_DIR = dir;
      env.DROPIN_NAME = spec.name;
    }
    sources.PORT = "process.env";

    this.opts.log.info({ name: spec.name, dir, port, dropin }, `spawning MCP child`);

    const proc = spawn(process.execPath, childArgs, {
      cwd: dir,
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    proc.on("error", (error) => this.opts.log.error({ name: spec.name, err: error }, `child spawn error`));
    proc.on("exit", (code, signal) => {
      this.opts.log.info({ name: spec.name, code, signal }, `child exited`);
    });

    try {
      await waitForPort(port, this.opts.readyTimeoutMs);
    } catch (error) {
      proc.kill("SIGTERM");
      throw new Error(`MCP child "${spec.name}" did not become ready on port ${port} within ${this.opts.readyTimeoutMs}ms: ${(error as Error).message}`);
    }

    (spec as { endpoint?: string }).endpoint = `http://127.0.0.1:${port}/mcp`;
    (spec as { __port?: number }).__port = port;
    entry.child = proc;
    this.opts.onSpawn?.({ name: spec.name, envSources: sources });
  }

  // Build the env passed to the child. Layered per CLAUDE.md "highest-risk
  // piece" rule, plus the controller-supplied layer at the top:
  //   process.env  ⊕  spec.env (yaml inline + dir/.env)  ⊕  controllerEnv
  // controllerEnv wins last. Records each var's source so onSpawn can log
  // the W-B3 deprecation tracker.
  private mergeEnv(
    entry: Entry,
    sources: Record<string, EnvSource>,
    extras: Record<string, string>,
  ): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") {
        out[key] = value;
        sources[key] = "process.env";
      }
    }
    if (entry.spec.env) {
      for (const [key, value] of Object.entries(entry.spec.env)) {
        out[key] = value;
        // The yaml-inline vs dir/.env distinction is lost by the time
        // config.ts merges them. Tag as dir/.env when the spec came from
        // a folder with a .env file present; otherwise yaml inline.
        sources[key] = "dir/.env";
      }
    }
    for (const [key, value] of Object.entries(entry.controllerEnv)) {
      out[key] = value;
      sources[key] = "controller";
    }
    Object.assign(out, extras);
    return out;
  }

  private async findAvailablePort(from: number): Promise<number> {
    for (let p = from; p < from + 1000; p++) {
      if (this.reservedPorts.has(p)) continue;
      if (await canBind(p)) return p;
    }
    throw new Error(`no free port found above ${from}`);
  }
}

function nowMs(): number {
  return Date.now();
}

function envEquals(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) if (a[k] !== b[k]) return false;
  return true;
}

function canBind(port: number): Promise<boolean> {
  return new Promise((res) => {
    const srv = createServer();
    srv.once("error", () => res(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => res(true)));
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveReady, rejectReady) => {
    const tryOnce = (): void => {
      const sock = createConnection({ host: "127.0.0.1", port });
      sock.once("connect", () => {
        sock.destroy();
        resolveReady();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() >= deadline) {
          rejectReady(new Error(`timeout waiting for port ${port}`));
          return;
        }
        setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}
