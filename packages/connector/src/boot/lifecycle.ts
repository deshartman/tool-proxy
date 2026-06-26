// Top-level boot orchestrator. Steps:
//   1. Load yaml + state, resolve auth posture, start the inspector.
//   2. Spawn Type 1 children, connect to all local MCP servers in parallel.
//   3. Build the initial manifest, wire toolDispatch into the inspector.
//   4. Open the first tunnel; on close, the ReconnectController drives redials.
//   5. Install SIGHUP / SIGTERM / SIGINT handlers.
//
// Mutable state that has to be shared across reconnects (the live `tunnel`
// reference, `manifest`, the persisted `state` object) lives here as locals
// and is closed over by the small set of functions that need it. The
// auto-reconnect counters / timer / lastDelay are owned by
// ReconnectController; the inbound-frame dispatch table lives in
// tunnel/frame-router.ts so the register-ack error-code branches are a
// sub-table rather than nested ifs in a closure.

import { loadConfig, authorOf, type McpServerSpec } from "../config.js";
import type { McpServerConnection } from "../servers/index.js";
import { buildManifest, dropinSpecsToMap } from "../manifest/build.js";
import { diffManifest, isEmptyDelta } from "../manifest/diff.js";
import { validateManifestSchemas } from "../manifest/validate.js";
import { TunnelClient } from "../tunnel/client.js";
import { Dispatcher } from "../dispatcher.js";
import type { ToolManifest } from "../tunnel/frames.js";
import { Inspector, startInspector } from "../inspector/server.js";
import { readState, defaultStatePath, type ConnectorState } from "../state.js";
import { createLogger } from "../logger.js";
import { WebhookRegistry } from "../tunnel/webhook-registry.js";
import { ReconnectController } from "../tunnel/reconnect.js";
import { createFrameRouter } from "../tunnel/frame-router.js";
import { CredsCoordinator } from "../tunnel/creds-coordinator.js";
import { McpConfigCoordinator } from "../tunnel/mcp-config-coordinator.js";
import { LocalMcpsCoordinator } from "../tunnel/local-mcps-coordinator.js";
import { ApprovalCoordinator } from "../tunnel/approval-coordinator.js";
import { NotificationForwarder } from "../tunnel/notification-forwarder.js";
import { McpSupervisor, type SupervisedSpec } from "../mcp-supervisor.js";
import { discoverDropins, isDropinSpec, type DropinSpec } from "../dropin.js";
import { resolveAuth } from "./auth.js";
import { requireEnv } from "./require-env.js";
import { envOptional, envString, envNumber } from "../env.js";
import { resolve as resolvePath } from "node:path";

const log = createLogger("connector");
// Adapter for downstream callbacks that take `(msg: string) => void`.
const logLine = log.info.bind(log);

export async function boot(): Promise<void> {
  // Preflight: every required env var checked in one pass before yaml load
  // or auth resolution. Throws a consolidated error naming all missing
  // pieces so an admin fixes them in one .env edit, not boot-fix-reboot
  // across three scattered errors.
  requireEnv();

  // requireEnv guarantees CONNECTOR_CONFIG is set; the local const exists
  // because TS narrowing of `process.env.X` doesn't survive across the
  // inner async closures even after a guard.
  const configPath: string = envOptional("CONNECTOR_CONFIG") as string;
  const version = envString("CONNECTOR_VERSION", "dev");
  // INSPECTOR_PORT=0 disables (the --no-inspector flag also sets this).
  // Empty/unset → 9090 default; non-numeric throws via envNumber.
  const inspectorPort = process.env.INSPECTOR_PORT === "0"
    ? 0
    : envNumber("INSPECTOR_PORT", 9090);

  const config = loadConfig(configPath);
  const auth = resolveAuth(config.tunnel.auth_token);

  // Identity: read the persisted registrationToken (if any). On first connect
  // it's absent and we send `name` only — the controller mints a row and
  // returns a token in the register-ack, which we persist for next boot.
  const statePath = defaultStatePath();
  const state: ConnectorState = readState(statePath);
  const identityStatus = state.registrationToken
    ? `reconnect (token len=${state.registrationToken.length})`
    : `first-connect (name="${config.tunnel.name}")`;
  log.info(
    { name: config.tunnel.name, environment: config.tunnel.environment, authToken: auth.status, identity: identityStatus },
    `config loaded`,
  );

  // The yaml carries `controller_url` (HTTPS root, used for the register API
  // and shown in the inspector). TunnelClient upgrades https:// → wss:// and
  // appends the /mcp-tunnel path before dialling.
  const tunnelDialUrl = config.tunnel.controller_url;

  // Live mutable references — replaced on each reconnect.
  let tunnel: TunnelClient | undefined;

  // Webhook ingress (see .claude/plans/STATUS-CALLBACK-MCP.md). One registry
  // for the whole connector lifetime — survives tunnel cycles. The send hook
  // reaches into the live `tunnel` ref above (closed-over binding); on reopen
  // we call reallocateAll so SDK consumers don't have to re-subscribe across
  // reconnects.
  // Forward declaration: the registry's onDispatched closure needs to reach
  // the inspector, but the inspector is constructed below this block (and
  // the inspector itself takes `webhooks` as a constructor arg, so we can't
  // simply flip the order). The `let` binding is captured by reference; the
  // closure resolves `inspector` lazily on each call, after the assignment
  // below has run.
  let inspector: Inspector | undefined;

  const webhooks = new WebhookRegistry({
    sendFrame: (frame) => {
      if (tunnel?.state !== "open") return false;
      tunnel.send(frame);
      return true;
    },
    onDispatched: () => inspector?.publishWebhookSnapshot(),
  });

  // 1. Inspector starts FIRST — before any Type 1 children spawn. Children
  // that consume the SDK's createWebhookEndpoint() open a stream against
  // 127.0.0.1:INSPECTOR_PORT immediately on boot; the inspector has to be
  // listening by then or the first allocation hits ECONNREFUSED.
  inspector = inspectorPort > 0
    ? new Inspector({
        controllerUrl: config.tunnel.controller_url,
        state: "connecting",
        webhooks,
      })
    : undefined;

  let heartbeatTimer: NodeJS.Timeout | undefined;
  let discoveryTimer: NodeJS.Timeout | undefined;
  let reconnecting = false;
  let shuttingDown = false;

  // Auto-reconnect controller. Owns reconnectAttempt / reconnectTimer /
  // lastDelay / registrationRejected. The fire callback closes over
  // `reconnect()` below.
  const reconnectCtl = new ReconnectController({
    getPolicy: () => config.policy.reconnect,
    onFire: () => { void reconnect(`auto attempt ${reconnectCtl.attemptCount()}`); },
    onReconnecting: (info) => inspector?.setReconnecting(info),
    log,
  });

  if (inspector) {
    inspector.onReconnect = () => { void reconnect("inspector requested", { manual: true }); };
    inspector.setIdentity(
      state.registrationToken
        ? { kind: "bound", tokenLen: state.registrationToken.length }
        : { kind: "first-connect" },
    );
    // Boot-time facts: yaml-driven name + environment, plus the connector
    // build version. Never change during process lifetime. ID + timestamps
    // stamp later (register-ack, tunnel-open).
    inspector.setHeader({
      connectorName: config.tunnel.name,
      environment: config.tunnel.environment,
      version,
    });
    startInspector(inspectorPort, inspector);
  }

  // 2a. Discover MCP_DROPIN_DIR folders that aren't already named in the
  // yaml. Drop-ins coexist with hand-written Type 1 entries: the yaml
  // entry wins for the same folder name, and a folder with server.ts
  // present is treated as today's hand-written Type 1.
  const yamlNames = new Set(config.mcp_servers.map((s) => s.name));
  const dropins = discoverDropins({ yamlNames });
  if (dropins.length > 0) {
    log.info(
      { dropins: dropins.map((d) => d.name) },
      `discovered drop-in MCPs from ${envOptional("MCP_DROPIN_DIR") ?? "default dir"}`,
    );
  }
  const allSpecs: SupervisedSpec[] = [...config.mcp_servers, ...dropins];

  // v1.3 — drop-in name set, threaded through every buildManifest call so
  // the gate predicate knows which entries to consult `isApproved` for.
  // Mutated by L2 rescan (added drop-ins join the set; removed drop-ins
  // leave). Keeping the map separate from the supervisor's internal entry
  // map preserves the buildManifest layering — the manifest builder doesn't
  // peek at supervisor internals.
  const dropinSpecsByName = new Map<string, DropinSpec>(dropins.map((spec) => [spec.name, spec]));

  // 2b. Supervisor owns child lifecycle. The shared `servers` map is
  // mutated by every spawn / restart so the dispatcher (wired below) and
  // inspector pick up new connections without re-attach.
  const servers = new Map<string, McpServerConnection>();

  // v1.2 (Workstream D) — server→client notification forwarder. Constructed
  // ONCE per connector process; the supervisor's `onConnect` hook attaches
  // a listener to every freshly-established MCP connection. Per-tunnel
  // rebind (the wire `send` callback) goes through `bind()` inside
  // `connectTunnel`. Notifications fired during a brief tunnel-down period
  // are dropped — they're advisory by spec.
  const notifications = new NotificationForwarder(log);

  const supervisor = new McpSupervisor({
    log,
    servers,
    onSpawn: ({ name, envSources }) => {
      const dirEnvKeys = Object.entries(envSources).filter(([, src]) => src === "dir/.env").map(([k]) => k);
      const controllerEnvKeys = Object.entries(envSources).filter(([, src]) => src === "controller").map(([k]) => k);
      log.info(
        { name, controller: controllerEnvKeys, dirDotEnv: dirEnvKeys },
        `mcp spawn env-sources`,
      );
    },
    onRestart: async (name) => {
      log.info({ name }, `mcp restart complete — refreshing manifest`);
      await refreshManifestAndPushDelta();
    },
    onConnect: (name, connection) => {
      notifications.attachToConnection(name, connection);
    },
  });
  supervisor.register(allSpecs);

  // Controller-driven 3rd-party MCP roster (W-E2). Constructed ONCE per
  // connector process — outlives WS reconnects so its in-memory roster
  // tracks the supervisor's lifetime, not the tunnel's. Per-tunnel rebind
  // (the wire `send` callback) goes through `mcpConfig.bind()` inside
  // `connectTunnel`. See the LIFETIME comment on McpConfigCoordinator for
  // the bug this prevents (2026-06-21 manual repro).
  //
  // Initial `send` is a no-op until the first tunnel binds — any frame
  // emitted before that would be a bug (we never invoke handleSnapshot /
  // handleDelta before a tunnel exists).
  const mcpConfig = new McpConfigCoordinator({
    send: () => log.warn(`mcp-config send before tunnel bind — dropping frame`),
    supervisor,
    log,
  });

  // v1.3 — Customer drop-in approval gate. Same lifetime contract as
  // McpConfigCoordinator + LocalMcpsCoordinator: constructed ONCE per
  // process, rebound per-tunnel via bind({send}). The approved set lives
  // in RAM only — the controller is the durable authority and replays
  // mcp-enable for every approved MCP after every register-ack. Don't
  // refactor it back to per-tunnel construction (would cause manifest
  // tools to vanish briefly on every reconnect until the replay landed).
  const approval = new ApprovalCoordinator({
    send: () => log.warn(`approval send before tunnel bind — dropping frame`),
    supervisor,
    log,
    onManifestChange: () => refreshManifestAndPushDelta(),
  });

  // Controller-triggered local-MCP rescan (W-L2 of MCP-LOADING-LOCAL).
  // Same lifetime story as McpConfigCoordinator — constructed ONCE per
  // process, rebound per-tunnel via bind() so its single-flight guard
  // survives WS reconnect. The onApplied hook refreshes the manifest +
  // pushes a delta so the controller sees the new tools without waiting
  // for the next discovery interval; onMcpAdded fans out a creds-request
  // for the freshly-spawned MCP (rescan-added MCPs miss the boot-time
  // creds fan-out).
  const localMcps = new LocalMcpsCoordinator({
    send: () => log.warn(`local-mcps send before tunnel bind — dropping frame`),
    supervisor,
    log,
    yamlNames,
    onApplied: () => refreshManifestAndPushDelta(),
    onMcpAdded: async (name) => {
      // v1.3 — rescan-added drop-ins are now gated. Update the
      // dropinSpecsByName map (so the manifest gate sees them) and emit an
      // mcp-discovered frame so the controller can render the new MCP in
      // its Pending lane. Yaml-listed Type 1 hand-written drop-ins (legacy
      // escape hatch — folder + server.ts + yaml entry) keep the existing
      // creds-request flow because they aren't `__dropin: true` specs.
      const status = supervisor.statusList().find((s) => s.name === name);
      const isCustomerDropin = status?.source === "local";
      if (isCustomerDropin) {
        // Re-discover so we have the freshly-spawned spec to register in
        // the gate map. The L2 rescan registered it on the supervisor side
        // already; here we just keep dropinSpecsByName in sync.
        const fresh = discoverDropins({ yamlNames });
        for (const spec of fresh) dropinSpecsByName.set(spec.name, spec);

        try {
          const envKeys = await supervisor.fetchEnvKeys(name);
          const conn = servers.get(name);
          const tools = conn ? await conn.listTools() : [];
          approval.emitDiscovered({
            mcp: name,
            envKeys,
            tools: tools.map((t) => ({ name: t.name, description: t.description })),
          });
        } catch (err) {
          log.warn({ name, err: err as Error }, `mcp-discovered emission for newly-added drop-in failed`);
        }
        return;
      }
      // Non-drop-in (legacy yaml-listed Type 1 hand-written) — keep the
      // creds-request flow as today.
      try {
        await inspector?.mcpActions?.reloadCreds(name);
      } catch (err) {
        log.warn({ name, err: err as Error }, `creds-request for newly-added drop-in failed — will retry on next reconnect`);
      }
    },
  });

  log.info(`connecting to ${allSpecs.length} local MCP server(s)`);
  await supervisor.startAll();
  log.info({ servers: [...servers.keys()] }, `connected to local servers`);
  inspector?.setMcpStatuses(supervisor.statusList());

  // 3. Build initial manifest and push it into the inspector (already running).
  // The supervisor list is the source of truth for what's running — it
  // includes the yaml entries plus any drop-ins discovered above.
  // v1.3: drop-in entries are gated by the approval coordinator. Until the
  // controller sends `mcp-enable` (operator approval click OR replay-on-
  // register-ack), the descriptor is omitted entirely.
  let manifest: ToolManifest = await buildManifest(
    config,
    servers,
    version,
    configPath,
    (name) => supervisor.fetchEnvKeys(name),
    (name) => approval.isApproved(name),
    dropinSpecsByName,
  );
  // Manifest-time advisory: one log.warn per shipped MCP whose tools lack
  // outputSchema. Tools without a schema are still callable — the controller
  // surfaces them by name only (no field-projection), and that's a fine
  // resting state for many MCPs. The warning is the prompt to add a schema
  // when an author wants {{ hydrate:server.tool.field }} to work.
  // See .claude/plans/OUTPUT-SCHEMA.md.
  validateManifestSchemas(manifest, config);
  log.info({ tools: countTools(manifest) }, `built manifest`);
  for (const server of manifest.servers) supervisor.setToolsCount(server.name, server.tools.length);
  inspector?.setManifest(manifest);
  inspector?.setMcpStatuses(supervisor.statusList());

  // Wire operator-driven tool invocation from the inspector UI into the same
  // servers map the dispatcher uses for controller-driven calls. Same callTool
  // path; same per-tool timeout.
  //
  // v1.3 trust-boundary fix: unapproved drop-ins must NOT be callable through
  // the inspector. Without this gate the loopback UI would be a backdoor
  // around the controller's approval gesture — a customer admin (whoever
  // dropped the folder) could call the tools without an operator's accept,
  // defeating the two-key model.
  if (inspector) {
    inspector.toolDispatch = async (serverName, toolName, args) => {
      const server = servers.get(serverName);
      if (!server) throw new Error(`no local MCP server '${serverName}'`);
      const isDropin = dropinSpecsByName.has(serverName);
      if (isDropin && !approval.isApproved(serverName)) {
        throw new Error(`MCP '${serverName}' is awaiting controller approval — tool calls are blocked`);
      }
      return server.callTool(toolName, args, {
        timeoutMs: config.policy.tool_timeout_ms,
      });
    };
  }

  await connectTunnel("initial");

  // SIGHUP — reload YAML, rebuild manifest, push delta.
  process.on("SIGHUP", () => { void onSighup(); });

  // Graceful shutdown.
  const shutdown = (signal: string): void => {
    shuttingDown = true;
    log.info({ signal }, `shutting down`);
    reconnectCtl.cancel();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (discoveryTimer) clearInterval(discoveryTimer);
    tunnel?.close(`signal:${signal}`);
    void supervisor.stopAll().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // ─── connect / reconnect ────────────────────────────────────────────────
  async function connectTunnel(reason: string): Promise<void> {
    inspector?.setState("connecting");
    log.info({ reason, url: tunnelDialUrl }, `tunnel dialing`);
    const pendingTunnel = new TunnelClient(tunnelDialUrl, auth.authToken, config.tunnel.name, auth.authProvider);
    pendingTunnel.onerror = (error) => log.error({ err: error }, `tunnel error`);
    if (inspector) {
      pendingTunnel.onstate = (tunnelState) => inspector.setState(tunnelState);
      pendingTunnel.ontap = (tap) => inspector.recordTap(tap);
    }
    pendingTunnel.onclose = () => {
      log.info(`tunnel closed`);
      webhooks.onTunnelClose();
      // v1.2 (Workstream D) — drop the wire callback so notifications
      // fired during the WS gap are dropped rather than crashing on a
      // closed socket. Re-bound on the next connectTunnel.
      notifications.unbind();
      stopTimers();
      // SIGTERM/SIGINT closes the tunnel intentionally — that path sets
      // shuttingDown so we bail. The manual /reconnect path also closes
      // intentionally, but TunnelClient.close() suppresses onclose for those
      // (sets this.closed=true), so we don't need to gate on `reconnecting`
      // here. We *do* want to fire auto-reconnect when a dial that was kicked
      // off by reconnect() then fails or drops — that's the controller-restart
      // recovery path.
      if (shuttingDown) return;
      if (!config.policy.reconnect.enabled) return;
      // A controller-side rejection (e.g. unknown_registration_token) means
      // retrying with the same identity will fail identically forever. Stay
      // in 'closed' until the operator clicks Reconnect or restarts with a
      // fresh state file.
      if (reconnectCtl.isRejected()) {
        log.warn(`auto-reconnect suppressed: controller rejected the registration — clear .connector-state.json and click Reconnect`);
        return;
      }
      reconnectCtl.schedule();
    };

    try {
      await pendingTunnel.connect();
    } catch (error) {
      log.error({ err: error as Error }, `tunnel connect failed`);
      inspector?.setState("closed");
      // A handshake failure (e.g. WS 502 because the controller is briefly
      // unreachable, or ngrok cycling) is the same recoverable state as a
      // mid-session close. Without this, a transient 502 leaves the connector
      // stranded in 'closed' until manual intervention. The onclose path
      // never fires for a connection that never reached OPEN, so this is the
      // only place we can hook the recovery.
      //
      // Don't gate on `reconnecting`: this catch *fires inside* an in-flight
      // reconnect attempt, so reconnecting=true is normal here. `reconnect()`
      // itself guards re-entry.
      if (shuttingDown) return;
      if (!config.policy.reconnect.enabled) return;
      if (reconnectCtl.isRejected()) {
        log.warn(`auto-reconnect suppressed: controller rejected the registration — clear .connector-state.json and click Reconnect`);
        return;
      }
      reconnectCtl.schedule();
      return;
    }

    tunnel = pendingTunnel;
    log.info({ url: tunnelDialUrl }, `tunnel connected`);
    inspector?.setHeader({ tunnelOpenSinceAt: new Date().toISOString() });

    // Per-MCP credential coordinator. Re-built per tunnel instance so a
    // pending request from a closed tunnel can't fire on a fresh one.
    const creds = new CredsCoordinator({
      send: (frame) => pendingTunnel.send(frame),
      supervisor,
      log,
    });

    // Controller-driven 3rd-party MCP roster (W-E2). The coordinator itself
    // is process-wide (constructed in outer `boot` scope); per-tunnel rebind
    // swaps only the wire `send` callback so an in-flight reconcile emits to
    // the *current* tunnel, NOT a stale one. Roster + lastAppliedGeneration
    // survive reconnect — see LIFETIME comment on McpConfigCoordinator.
    mcpConfig.bind({ send: (frame) => pendingTunnel.send(frame) });

    // Local-MCP rescan coordinator — same per-tunnel rebind shape as
    // mcpConfig. Single-flight state survives reconnect by design.
    localMcps.bind({ send: (frame) => pendingTunnel.send(frame) });

    // v1.3 — Customer drop-in approval gate. Same per-tunnel rebind:
    // approved set survives reconnect; only the wire `send` callback flips.
    approval.bind({ send: (frame) => pendingTunnel.send(frame) });

    // v1.2 (Workstream D) — bind the notification forwarder to the live
    // tunnel. Same pattern as mcpConfig.bind: process-wide listeners,
    // per-tunnel send callback. Notifications fired between unbind and
    // the next bind() are dropped (advisory frames; consumer state will
    // recover on next list call).
    notifications.bind({ send: (frame) => pendingTunnel.send(frame) });

    const baseRouter = createFrameRouter({
      webhooks,
      state,
      statePath,
      inspector,
      reconnect: reconnectCtl,
      log,
      connectorName: config.tunnel.name,
    });
    pendingTunnel.onframe = (frame) => {
      if (frame.type === "creds-response") { creds.handleResponse(frame); return; }
      if (frame.type === "creds-update") { creds.handleUpdate(frame); return; }
      if (frame.type === "mcp-config-snapshot") { void mcpConfig.handleSnapshot(frame); return; }
      if (frame.type === "mcp-config-delta") { void mcpConfig.handleDelta(frame); return; }
      if (frame.type === "local-mcps-rescan") { void localMcps.rescanFromController(); return; }
      // v1.3 — Customer drop-in approval gate. mcp-enable carries the
      // operator's approval gesture (initial click OR replay-on-register-
      // ack); mcp-disable carries the revoke gesture. Both update the
      // approval set, push a manifest-delta if shape changed, and ack.
      if (frame.type === "mcp-enable") { void approval.handleEnable(frame); return; }
      if (frame.type === "mcp-disable") { void approval.handleDisable(frame); return; }
      if (frame.type === "register-ack" && !frame.error) {
        // After register-ack success, kick off creds-request per MCP and arm
        // the mcp-config soft-wait. Don't block the router callback — fire-
        // and-forget so the rest of the frame handlers (webhook reallocate
        // etc.) keep flowing.
        baseRouter(frame);
        void requestCredsForAllMcps(creds, mcpConfig);
        mcpConfig.armSnapshotWait();
        // v1.3 — emit mcp-discovered for every drop-in NOT yet approved.
        // The connector is stateless across restarts; the controller's
        // approval table is the durable authority and replays mcp-enable
        // for previously-approved MCPs. Until that replay arrives, every
        // drop-in's tools stay omitted from the manifest by the gate.
        void announceDiscoveredDropins();
        return;
      }
      baseRouter(frame);
    };

    // Wire inspector per-MCP actions against the live coordinator + supervisor.
    if (inspector) {
      inspector.mcpActions = {
        reloadCreds: async (name: string) => {
          const reqInfo = buildCredsRequestForMcp(name, mcpConfig);
          if (!reqInfo) throw new Error(`unknown MCP "${name}"`);
          await creds.reload(reqInfo.mcp, reqInfo.author, reqInfo.envKeys, reqInfo.mcpId);
        },
        restart: async (name: string) => {
          const ok = await supervisor.restart(name, "manual");
          if (!ok) throw new Error(`unknown MCP "${name}"`);
        },
        rescanLocal: async () => {
          // W-L2: same coordinator method as the controller-triggered path,
          // minus the wire ack. Returns the summary for the inspector UI.
          const ack = await localMcps.rescan();
          return {
            added: ack.added,
            removed: ack.removed,
            unchanged: ack.unchanged,
            errors: ack.errors,
          };
        },
        // INSPECTOR-CREDS-VISIBILITY (W-S4): write-only entry point for
        // developer-pasted dev creds. The supervisor owns the values; we
        // never read them back. Returns only the expiry epoch-ms so the UI
        // can render a countdown.
        applySessionCreds: async (name: string, env: Record<string, string>) => {
          // Merge mode: the inspector form sends only the fields the
          // developer typed into, so keys already set (rendered as
          // "•••• (set)" in the UI) survive a partial submit. To drop a
          // key, the dev clicks Clear (which wipes the layer entirely).
          const result = await supervisor.applySessionEnv(name, env, { mode: "merge" });
          if (!result.applied) throw new Error(`unknown MCP "${name}"`);
          return { expiresAt: result.expiresAt };
        },
        clearSessionCreds: async (name: string) => {
          await supervisor.clearSessionEnv(name, "session-creds-cleared-by-operator");
        },
        // INSPECTOR-CREDS-VISIBILITY (W-S5): expose declared envKeys for an
        // MCP so the inspector UI knows which form fields to render. Read-
        // only — names not values. Falls back to [] for any spec the
        // supervisor can't introspect (stdio / Type 2 http external).
        fetchEnvKeys: async (name: string) => {
          return supervisor.fetchEnvKeys(name);
        },
      };
    }

    pendingTunnel.send({
      type: "register",
      manifest,
      name: config.tunnel.name,
      ...(state.registrationToken ? { registrationToken: state.registrationToken } : {}),
    });
    log.info(`register frame sent`);

    // Wire dispatcher to this tunnel instance. Dispatcher gets its own
    // 'dispatcher' child logger so its lines carry the right component tag
    // — distinct from the connector's own boot/lifecycle lines.
    const dispatcherLog = createLogger("dispatcher");
    new Dispatcher({
      config,
      servers,
      getManifest: () => manifest,
      tunnel: pendingTunnel,
      log: dispatcherLog.info.bind(dispatcherLog),
    }).attach();

    startTimers();
  }

  // Build a creds-request payload for a single MCP. Returns undefined if
  // the MCP isn't registered with the supervisor (defense; should not
  // happen for inspector-driven reloads against current manifest).
  function buildCredsRequestForMcp(
    name: string,
    mcpConfig?: McpConfigCoordinator,
  ): { mcp: string; mcpId?: string; author: string; envKeys: string[] } | undefined {
    const yamlDir = configPath ? resolvePath(configPath, "..") : process.cwd();
    const spec = config.mcp_servers.find((s) => s.name === name);
    const author = spec ? authorOf(spec, yamlDir) : "customer";
    if (!servers.has(name)) return undefined;
    const mcpId = mcpConfig?.mcpIdFor(name);
    return { mcp: name, ...(mcpId ? { mcpId } : {}), author, envKeys: [] };
  }

  // Fan out creds-request after register-ack. Aggregates envKeys per MCP
  // by hitting the synthesized /envkeys endpoint when present. mcpConfig
  // attaches mcpId for controller-roster MCPs; yaml-listed entries omit it.
  async function requestCredsForAllMcps(
    creds: CredsCoordinator,
    mcpConfig: McpConfigCoordinator,
  ): Promise<void> {
    const yamlDir = configPath ? resolvePath(configPath, "..") : process.cwd();
    const requests = await Promise.all(
      [...servers.keys()].map(async (name) => {
        const spec = config.mcp_servers.find((s) => s.name === name);
        const author = spec ? authorOf(spec, yamlDir) : "customer";
        const envKeys = await supervisor.fetchEnvKeys(name);
        const mcpId = mcpConfig.mcpIdFor(name);
        return { mcp: name, ...(mcpId ? { mcpId } : {}), author, envKeys };
      }),
    );
    log.info({ count: requests.length }, `sending creds-request frames`);
    await creds.requestAllAtBoot(requests);
    inspector?.setMcpStatuses(supervisor.statusList());
  }

  // v1.3 — emit `mcp-discovered` after register-ack for every customer
  // drop-in this session. The controller uses each frame for TWO purposes:
  // (a) look up the MCP in its approval table keyed on (connectorId, mcp)
  // and replay `mcp-enable` for previously-approved MCPs, and (b) classify
  // the MCP as Live (approved + seen this session) vs Orphaned (approved +
  // not seen this session). New MCPs land in the controller's "Pending
  // approval" lane and stay there until an operator clicks Approve.
  //
  // The fan-out announces every drop-in unconditionally — emitDiscovered is
  // idempotent on the controller side (per docs/MCP-PROTOCOL.md §"v1.3"),
  // and gating on `approval.isApproved(name)` mid-loop is unsafe: the
  // controller's mcp-enable replay arrives synchronously between this
  // function's `await`s and mutates the approved set, causing later
  // iterations to skip — leaving those drop-ins parked in the controller's
  // Orphaned lane until the next connector restart. Snapshotting the name
  // list up front is sufficient because at process boot the approved set
  // starts empty; if a future code path pre-populates it before this fans
  // out, switch this to filter the snapshot once before the loop.
  async function announceDiscoveredDropins(): Promise<void> {
    const dropinNames = [...dropinSpecsByName.keys()];
    if (dropinNames.length === 0) return;
    let announced = 0;
    for (const name of dropinNames) {
      try {
        const envKeys = await supervisor.fetchEnvKeys(name);
        const conn = servers.get(name);
        const tools = conn ? await conn.listTools() : [];
        approval.emitDiscovered({
          mcp: name,
          envKeys,
          tools: tools.map((t) => ({ name: t.name, description: t.description })),
        });
        announced += 1;
      } catch (err) {
        log.warn({ name, err: err as Error }, `mcp-discovered emission failed for drop-in`);
      }
    }
    log.info({ announced, totalDropins: dropinNames.length }, `mcp-discovered fan-out complete`);
  }

  async function reconnect(reason: string, opts?: { manual?: boolean }): Promise<void> {
    // Auto-fires that arrive while a reconnect is already in flight are
    // genuine duplicates — drop them. Manual operator clicks are NOT
    // duplicates: they're the escape hatch from a stuck dial (e.g. a
    // hung TLS handshake during a network outage), so we let them through
    // and rely on the close-then-redial below to abort the in-flight WS.
    if (reconnecting && !opts?.manual) return;
    if (reconnecting && opts?.manual) {
      log.info({ reason }, `manual reconnect overriding in-flight attempt`);
    }
    reconnecting = true;
    try {
      // A manual click or an auto-fire both come through here. Either way,
      // an attempt is now in flight — drop any pending backoff timer so we
      // don't stack a second redial on top of this one.
      reconnectCtl.cancel();
      // The operator clicking Reconnect is the signal that they've fixed
      // whatever caused the rejection (typically: cleared .connector-state.json
      // so we re-mint, or re-provisioned the controller row). Clear the
      // suppression so the new attempt can land — and so the next blip
      // resumes the auto-reconnect loop.
      reconnectCtl.clearRejected();
      log.info({ reason }, `reconnect requested`);
      stopTimers();
      // close() on a CONNECTING ws aborts the in-flight handshake — that's
      // how a manual override unblocks a hung dial.
      tunnel?.close("reconnect");
      tunnel = undefined;

      // Re-read YAML so policy edits land on the next dial. mcp_servers
      // changes still require a full process restart (the connections to
      // local MCP servers were established at boot).
      try {
        const nextConfig = loadConfig(configPath);
        if (sameMcpServers(config.mcp_servers, nextConfig.mcp_servers)) {
          Object.assign(config, { policy: nextConfig.policy });
          log.info(`reconnect: YAML reloaded`);
        } else {
          log.warn(`reconnect: mcp_servers list changed in YAML — restart required to pick that up; using prior list`);
        }
      } catch (error) {
        log.warn({ err: error as Error }, `reconnect: YAML reload failed — using last-known config`);
      }

      // Rebuild manifest against the (possibly updated) config. Updates
      // inspector view too.
      manifest = await buildManifest(
        config,
        servers,
        version,
        configPath,
        (name) => supervisor.fetchEnvKeys(name),
        (name) => approval.isApproved(name),
        dropinSpecsByName,
      );
      inspector?.setManifest(manifest);

      await connectTunnel("reconnect");
    } finally {
      reconnecting = false;
    }
  }

  function startTimers(): void {
    if (heartbeatTimer || discoveryTimer) return;
    heartbeatTimer = setInterval(() => {
      tunnel?.send({ type: "heartbeat", ts: Date.now() });
    }, config.policy.heartbeat_interval_ms);
    discoveryTimer = setInterval(() => {
      void refreshManifestAndPushDelta();
    }, config.policy.discovery_interval_ms);
  }

  function stopTimers(): void {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
    if (discoveryTimer) { clearInterval(discoveryTimer); discoveryTimer = undefined; }
  }

  async function refreshManifestAndPushDelta(): Promise<void> {
    try {
      const nextManifest = await buildManifest(
        config,
        servers,
        version,
        configPath,
        (name) => supervisor.fetchEnvKeys(name),
        (name) => approval.isApproved(name),
        dropinSpecsByName,
      );
      const delta = diffManifest(manifest, nextManifest);
      manifest = nextManifest;
      inspector?.setManifest(nextManifest);
      for (const server of nextManifest.servers) supervisor.setToolsCount(server.name, server.tools.length);
      inspector?.setMcpStatuses(supervisor.statusList());
      if (!isEmptyDelta(delta)) {
        tunnel?.send({ type: "manifest-delta", delta });
        log.info(
          { added: delta.added.length, removed: delta.removed.length, changed: delta.changed.length },
          `pushed manifest-delta`,
        );
      }
    } catch (error) {
      log.error({ err: error as Error }, `discovery refresh failed`);
    }
  }

  async function onSighup(): Promise<void> {
    try {
      const nextConfig = loadConfig(configPath);
      if (!sameMcpServers(config.mcp_servers, nextConfig.mcp_servers)) {
        log.warn(`SIGHUP: mcp_servers list changed — restart required for live reconnect; ignoring this reload`);
        return;
      }
      Object.assign(config, { policy: nextConfig.policy });
      log.info(`SIGHUP: config reloaded`);
      await refreshManifestAndPushDelta();
    } catch (error) {
      log.error({ err: error as Error }, `SIGHUP reload failed`);
    }
  }
}

function countTools(manifest: ToolManifest): number {
  return manifest.servers.reduce((sum, server) => sum + server.tools.length, 0);
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
  // `bundled` carries the user-facing Type 3 identifier even after we've
  // resolved it to a synthetic stdio spec. Compared so an edit from
  // `bundled: a` to `bundled: b` is detected even if both happen to
  // resolve to identical commands (or both resolve via dev override).
  return live.bundled === fresh.bundled;
}

function sameStringMap(live?: Record<string, string>, fresh?: Record<string, string>): boolean {
  const liveKeys = live ? Object.keys(live) : [];
  const freshKeys = fresh ? Object.keys(fresh) : [];
  if (liveKeys.length !== freshKeys.length) return false;
  return liveKeys.every((key) => live?.[key] === fresh?.[key]);
}

