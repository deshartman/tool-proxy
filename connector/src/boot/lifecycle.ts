// Top-level boot orchestrator — the PROCESS shell (MULTI-PLATFORM-MCP Phase 6).
//
//   1. Open the sealed config store, load yaml, scan bundled + drop-in MCPs.
//   2. Start the process services: health server, inspector, machine API.
//   3. Start one TunnelWorkspace per controller entry (boot/workspace.ts).
//      Zero entries is a valid state — the inspector renders "Add controller"
//      and the first submit starts the first workspace.
//   4. Install SIGHUP / SIGTERM / SIGINT once, fanning out to every workspace.
//
// Everything per-tunnel — TunnelClient, reconnect, coordinators, supervisor,
// children — lives in a workspace. What stays here is process-wide by nature
// (§5.2): signals, the health server, the inspector, the port allocator, the
// shared scan, and the machine API's credential → workspace routing.

import { loadConfig, type McpServerSpec } from "../config.js";
import { Inspector, startInspector, rebindInspector } from "../inspector/server.js";
import { startHealthServer, workspacesHealth, type HealthState } from "../health/server.js";
import { createNetworkAccessRoutes } from "../inspector/network-access-routes.js";
import { handleOauthToken } from "../inspector/oauth-token-route.js";
import { handleOutboundCalls } from "../inspector/outbound-calls-route.js";
import { handleMemoryEvents } from "../inspector/memory-events-route.js";
import { createIdentityRoutes } from "../inspector/identity-routes.js";
import { deriveJwtSigningKey } from "../auth/jwt.js";
import { createLogger } from "../logger.js";
import { discoverBundled, discoverDropins } from "../dropin.js";
import { PortAllocator } from "../port-allocator.js";
import { requireEnv } from "./require-env.js";
import { ConfigStore, type ControllerRow } from "../config-store/index.js";
import { initSodium } from "../config-store/seal.js";
import { resolveMasterKey } from "../config-store/master-key.js";
import { createTunnelRoutes } from "../inspector/tunnel-routes.js";
import { envOptional, envString, envNumber } from "../env.js";
import { TunnelWorkspace, type WorkspaceShared } from "./workspace.js";
import { removeWorkspaceStorage } from "./workspace-storage.js";
import { createMachineApiRouting } from "./machine-api-routing.js";
import { DiscoveryCache } from "./discovery-cache.js";

const log = createLogger("connector");

export async function boot(): Promise<void> {
  await bootFromDb();
}

// bootFromEnv() was deleted with the env-mode removal. Tunnel identity + creds
// live exclusively in the sealed config store, managed via the inspector. The
// name bootFromDb is a misnomer kept for continuity (DB-TO-FILE swapped
// Postgres for a sealed JSON file on the state volume).
async function bootFromDb(): Promise<void> {
  requireEnv();

  // WARN once for any legacy per-controller env var still present. These
  // belonged to `env` mode and are silently ignored, which makes a "why isn't
  // my rotated bearer taking effect?" ticket easy to misread. Naming each
  // stray var steers the operator to the inspector UI.
  for (const name of ["CONTROLLER_URL", "CONNECTOR_NAME", "TUNNEL_AUTH_TOKEN", "OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "OAUTH_TOKEN_URL"]) {
    if (envOptional(name)) {
      log.warn(`legacy per-controller env var '${name}' present but ignored — tunnel identity lives in the config store; remove from .env`);
    }
  }

  await initSodium();
  const masterKey = resolveMasterKey();
  const store = await ConfigStore.open(masterKey);
  const signingKey = deriveJwtSigningKey(masterKey.bytes);

  const configPath: string = envOptional("CONNECTOR_CONFIG") as string;
  const version = envString("CONNECTOR_VERSION", "dev");
  const inspectorPort = process.env.INSPECTOR_PORT === "0"
    ? 0
    : envNumber("INSPECTOR_PORT", 9090);
  // Q-A2, decided: 9100. NOT 9091 — `./scripts/start-connector.sh 9091` uses
  // that as a second INSPECTOR port for the multi-instance dev workflow, so a
  // 9091 default would collide with the documented way of running two
  // connectors. 9100 is clear of the inspector range and of MCP_BASE_PORT's
  // 7100-upward child allocation. 0 disables, matching INSPECTOR_PORT.
  const healthPort = process.env.HEALTH_PORT === "0" ? 0 : envNumber("HEALTH_PORT", 9100);

  const config = loadConfig(configPath);
  if (config.tunnel) {
    log.warn("legacy 'tunnel:' block in connector.yaml ignored — tunnel identity lives in the config store; remove it from your yaml");
  }

  // One per process. Workspaces add and remove themselves; nothing else
  // mutates this map.
  const workspaces = new Map<string, TunnelWorkspace>();
  let shuttingDown = false;

  // ── Health endpoints (§5.7) ───────────────────────────────────────────
  // /readyz aggregates across workspaces. A workspace's TUNNEL does not gate
  // readiness — under D5 one tenant's controller outage must not take the
  // proxy out of rotation for the others — EXCEPT that zero workspaces stays
  // `tunnel_not_open`, which keeps "a fresh deploy is deliberately not ready".
  const healthState = (): HealthState => workspacesHealth(true, [...workspaces.values()]);
  const healthServer = startHealthServer({
    port: healthPort,
    getState: healthState,
    log,
    // An explicit HEALTH_PORT that can't be bound means a probe would read
    // some other process's readiness — exit rather than run unobservable.
    failOnBindError: envOptional("HEALTH_PORT") !== undefined,
    onFatal: (error) => {
      log.fatal({ err: error, port: healthPort }, "HEALTH_PORT is explicitly set but already in use — another connector on this host? exiting");
      process.exit(1);
    },
  });

  // Discover MCPs from two scanners: MCP_BUNDLED_DIR (Twilio-shipped) and
  // MCP_DROPIN_DIR (customer drop-ins). Done ONCE per process — the scan
  // describes code on disk, not a tenant — and cloned into each workspace.
  const yamlNames = new Set(config.mcp_servers.map((s) => s.name));
  const bundled = discoverBundled({ yamlNames });
  const dropins = discoverDropins({ yamlNames: new Set([...yamlNames, ...bundled.map((b) => b.name)]) });
  if (bundled.length > 0) {
    log.info({ bundled: bundled.map((b) => b.name) }, `discovered bundled MCPs from ${envOptional("MCP_BUNDLED_DIR") ?? "default dir"}`);
  }
  if (dropins.length > 0) {
    log.info({ dropins: dropins.map((d) => d.name) }, `discovered drop-in MCPs from ${envOptional("MCP_DROPIN_DIR") ?? "default dir"}`);
  }

  const inspector = inspectorPort > 0 ? new Inspector() : undefined;

  const shared: WorkspaceShared = {
    config,
    version,
    store,
    inspector,
    // One allocator for every workspace's supervisor (§5.3): probe-then-reserve
    // is atomic across all of them, so concurrent spawns never collide.
    ports: new PortAllocator(),
    // MCP_READINESS_TIMEOUT_MS lets operators raise the port-readiness wait
    // beyond the default 15s on slower hardware or with many drop-ins.
    readyTimeoutMs: envNumber("MCP_READINESS_TIMEOUT_MS", 15000),
    bundled,
    dropins,
    yamlNames,
    reloadConfig: () => reloadPolicy("reconnect"),
    discovery: undefined as DiscoveryCache | undefined,
  };
  // Lazy spawn (§5.3): gated children start on mcp-enable; mcp-discovered
  // describes them from this process-wide cache. Shares the allocator so a
  // discovery spawn never collides with a workspace's child.
  shared.discovery = new DiscoveryCache({ ports: shared.ports, readyTimeoutMs: shared.readyTimeoutMs, log });

  // Reload connector.yaml's `policy` in place. mcp_servers changes need a
  // restart (live MCP reconnect is out of scope) and are refused with a warn.
  function reloadPolicy(trigger: string): boolean {
    try {
      const next = loadConfig(configPath);
      if (!sameMcpServers(config.mcp_servers, next.mcp_servers)) {
        log.warn(`${trigger}: mcp_servers list changed in YAML — restart required to pick that up; using prior list`);
        return false;
      }
      Object.assign(config, { policy: next.policy });
      log.info(`${trigger}: YAML reloaded`);
      return true;
    } catch (error) {
      log.warn({ err: error as Error }, `${trigger}: YAML reload failed — using last-known config`);
      return false;
    }
  }

  async function startWorkspace(row: ControllerRow): Promise<TunnelWorkspace> {
    const existing = workspaces.get(row.id);
    if (existing) return existing;
    const ws = new TunnelWorkspace(row, shared);
    workspaces.set(row.id, ws);
    log.info({ ws: row.id, controllerUrl: row.controllerUrl }, `workspace starting`);
    await ws.start();
    return ws;
  }

  // Removing a controller entry stops its children and deletes its storage
  // directory (D15). Its id is never reused, so nothing can inherit it.
  async function removeWorkspace(id: string): Promise<void> {
    const ws = workspaces.get(id);
    if (ws) {
      workspaces.delete(id);
      await ws.stop("controller-removed");
      ws.detachView();
    }
    removeWorkspaceStorage(id);
    log.info({ ws: id }, `workspace removed`);
  }

  // ── Machine API: credential → workspace (§5.6) ────────────────────────
  const machineApi = createMachineApiRouting({
    store,
    signingKey,
    coordinatorOf: (id) => workspaces.get(id)?.controllerApiCoordinator(),
    log,
  });

  if (inspector) {
    // CONNECTOR-NETWORK-EXPOSURE — if a prior boot already had an API
    // client added, bind non-loopback directly on this boot too.
    const networkAccessState = await store.getNetworkAccessState();
    const httpServer = startInspector(inspectorPort, inspector, { networkAccessEnabled: networkAccessState.enabled });
    inspector.wireNetworkAccessRoutes(createNetworkAccessRoutes({
      configStore: store,
      rebindNonLoopback: () => rebindInspector(httpServer, inspectorPort, log),
    }));
    // Machine API — self-issued client_credentials grant. Signing key is
    // derived from the master key (no separate secret to mint/lose); 1h
    // expiry matches the tunnel's own OAuth2 JWT convention.
    inspector.wireOauthToken((req, res) => handleOauthToken(req, res, {
      configStore: store,
      signingKey,
      expiresInSec: 3600,
    }));
    // The three /v1/* routes share the credential → workspace routing above.
    // getVerifierConfig reads the store fresh per request so a live operator
    // change needs no restart; getCoordinator reads the live workspace map so
    // it always reflects that workspace's current tunnel (or undefined).
    const machineDeps = { getVerifierConfig: machineApi.getVerifierConfig, getCoordinator: machineApi.getCoordinator };
    inspector.wireOutboundCalls((req, res) => handleOutboundCalls(req, res, machineDeps));
    inspector.wireMemoryEvents((req, res) => handleMemoryEvents(req, res, machineDeps));
    inspector.wireIdentityRoutes(createIdentityRoutes(machineDeps));

    // Tunnel routes. Adding a controller starts a workspace; editing one
    // cycles it; removing one stops it. `id` omitted is the single-controller
    // shorthand (the only workspace).
    inspector.wireTunnelRoutes(createTunnelRoutes({
      configStore: store,
      dialTunnel: async (r) => { await startWorkspace(r); },
      cycleTunnel: async (reason, id) => {
        const target = id ? workspaces.get(id) : workspaces.size === 1 ? [...workspaces.values()][0] : undefined;
        if (!target) throw new Error(id ? `no running workspace for controller ${id}` : "no single workspace to cycle — name one");
        await target.cycle(reason);
      },
      removeTunnel: removeWorkspace,
    }));
  }

  // ── Start one workspace per controller entry ──────────────────────────
  // In parallel: each owns its own children, and the shared PortAllocator
  // keeps their spawns from colliding. One workspace failing to start must
  // not take the others down (continue-on-fail, same as per-MCP).
  const rows = await store.listControllers();
  if (rows.length === 0) {
    log.info(`no controller configured; waiting for inspector configuration at http://127.0.0.1:${inspectorPort}/`);
  }
  await Promise.all(rows.map((row) => startWorkspace(row).catch((err) => {
    log.error({ ws: row.id, err: err as Error }, `workspace failed to start — other workspaces continue`);
  })));

  // SIGHUP — reload YAML policy, then every workspace re-lists and pushes
  // whatever changed.
  process.on("SIGHUP", () => {
    if (!reloadPolicy("SIGHUP")) return;
    for (const ws of workspaces.values()) void ws.onConfigReloaded();
  });

  // Graceful shutdown: every workspace in parallel, each with the existing
  // 2s SIGKILL fallback per child. The exit code stays meaningful (0 clean,
  // 1 if any workspace's stop failed) because Fargate and K8s use it to
  // decide retry behaviour.
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal, workspaces: workspaces.size }, `shutting down`);
    // Stop answering probes immediately. An orchestrator draining this task
    // should see the endpoint go away rather than keep getting a 200 from a
    // process that is tearing its children down.
    healthServer?.close();
    const results = await Promise.allSettled([...workspaces.values()].map((ws) => ws.stop(`signal:${signal}`)));
    let exitCode = 0;
    for (const r of results) {
      if (r.status === "rejected") {
        log.error({ err: r.reason }, `workspace stop failed during shutdown`);
        exitCode = 1;
      }
    }
    try {
      await store.close();
    } catch (error) {
      log.warn({ err: error }, `config store close failed`);
    }
    process.exit(exitCode);
  };
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
}

function sameMcpServers(live: McpServerSpec[], fresh: McpServerSpec[]): boolean {
  if (live.length !== fresh.length) return false;
  return live.every((spec, index) => sameSpec(spec, fresh[index]));
}

// Compare every field that affects how we'd spawn or connect to the entry.
// The reconnect path uses this to decide whether YAML changes are safe to
// apply live; anything beyond `policy` requires a process restart.
function sameSpec(live: McpServerSpec, fresh: McpServerSpec): boolean {
  if (live.name !== fresh.name || live.transport !== fresh.transport) return false;
  if (live.transport === "http" && fresh.transport === "http" && !sameHttpEndpoint(live, fresh)) return false;
  if (live.transport === "stdio" && fresh.transport === "stdio" && !sameStdioInvocation(live, fresh)) return false;
  if (live.dir !== fresh.dir) return false;
  return sameStringMap(live.env, fresh.env);
}

function sameHttpEndpoint(
  live: Extract<McpServerSpec, { transport: "http" }>,
  fresh: Extract<McpServerSpec, { transport: "http" }>,
): boolean {
  // Skip endpoint comparison for Type 1 entries (yaml has `dir` and no
  // endpoint; the spawner mutates `endpoint` in at boot to point at the
  // child's auto-assigned localhost port). The freshly-loaded spec has no
  // endpoint, the live spec has http://127.0.0.1:71xx/mcp — comparing them
  // produces a false-positive "yaml changed" warning on every reconnect.
  const isType1 = !!fresh.dir && !fresh.endpoint;
  return isType1 || live.endpoint === fresh.endpoint;
}

function sameStdioInvocation(
  live: Extract<McpServerSpec, { transport: "stdio" }>,
  fresh: Extract<McpServerSpec, { transport: "stdio" }>,
): boolean {
  if (live.command.length !== fresh.command.length) return false;
  if (live.command.some((arg, index) => arg !== fresh.command[index])) return false;
  return true;
}

function sameStringMap(live?: Record<string, string>, fresh?: Record<string, string>): boolean {
  const liveKeys = live ? Object.keys(live) : [];
  const freshKeys = fresh ? Object.keys(fresh) : [];
  if (liveKeys.length !== freshKeys.length) return false;
  return liveKeys.every((key) => live?.[key] === fresh?.[key]);
}

