// Top-level boot orchestrator. Replaces the 644-line main() that used to
// live in index.ts. Steps:
//   1. Load yaml + state, resolve auth posture, start the inspector.
//   2. Spawn Type 1 children, connect to all local MCP servers in parallel.
//   3. Build the initial manifest, wire toolDispatch into the inspector.
//   4. Open the first tunnel; on close, the ReconnectController drives redials.
//   5. Install SIGHUP / SIGTERM / SIGINT handlers.
//
// Mutable state that has to be shared across reconnects (the live `tunnel`
// reference, `manifest`, the persisted `state` object) lives here as locals
// and is closed over by the small set of functions that need it. The
// auto-reconnect counters / timer / lastDelay used to be sprinkled across
// module-scope and main()-scope; they're now owned by ReconnectController.
// The inbound-frame dispatch table moved out to tunnel/frame-router.ts so
// the register-ack error-code branches are a sub-table rather than nested
// ifs in a closure.

import { loadConfig, type McpServerSpec } from "../config.js";
import { connectAll, type McpServerConnection } from "../servers/index.js";
import { buildManifest } from "../manifest/build.js";
import { diffManifest, isEmptyDelta } from "../manifest/diff.js";
import { TunnelClient } from "../tunnel/client.js";
import { Dispatcher } from "../dispatcher.js";
import type { ToolManifest } from "../tunnel/frames.js";
import { Inspector, startInspector } from "../inspector/server.js";
import { spawnType1Children, shutdownChildren, type SpawnedChild } from "../spawner.js";
import { readState, defaultStatePath, type ConnectorState } from "../state.js";
import { createLogger } from "../logger.js";
import { WebhookRegistry } from "../tunnel/webhook-registry.js";
import { ReconnectController } from "../tunnel/reconnect.js";
import { createFrameRouter } from "../tunnel/frame-router.js";
import { resolveAuth } from "./auth.js";

const log = createLogger("connector");
// Adapter for downstream callbacks that take `(msg: string) => void`.
const logLine = log.info.bind(log);

export async function boot(): Promise<void> {
  const envConfigPath = process.env.CONNECTOR_CONFIG;
  if (!envConfigPath) throw new Error("CONNECTOR_CONFIG env var is required");
  // Captured into a typed `string` const so the inner async closures don't
  // need non-null assertions — TS narrowing of `process.env.X` doesn't
  // survive across the closure boundary even after a guard.
  const configPath: string = envConfigPath;
  const version = process.env.CONNECTOR_VERSION ?? "dev";
  // Set INSPECTOR_PORT=0 to disable; defaults to 9090.
  const inspectorPort = process.env.INSPECTOR_PORT === "0"
    ? 0
    : Number(process.env.INSPECTOR_PORT ?? 9090);

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
  const webhooks = new WebhookRegistry({
    sendFrame: (frame) => {
      if (tunnel?.state !== "open") return false;
      tunnel.send(frame);
      return true;
    },
  });

  // 1. Inspector starts FIRST — before any Type 1 children spawn. Children
  // that consume the SDK's createWebhookEndpoint() open a stream against
  // 127.0.0.1:INSPECTOR_PORT immediately on boot; the inspector has to be
  // listening by then or the first allocation hits ECONNREFUSED.
  const inspector = inspectorPort > 0
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
  // lastDelay / registrationRejected — all the state the old main() carried
  // as a tangle of `let`s. The fire callback closes over `reconnect()` below.
  const reconnectCtl = new ReconnectController({
    getPolicy: () => config.policy.reconnect,
    onFire: () => { void reconnect(`auto attempt ${reconnectCtl.attemptCount()}`); },
    onReconnecting: (info) => inspector?.setReconnecting(info),
    log,
  });

  if (inspector) {
    inspector.onReconnect = () => { void reconnect("inspector requested"); };
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

  // 2a. Spawn Type 1 children (http transport + dir + no endpoint). Mutates
  // the spec list to fill in `endpoint` so the dispatch path below sees a
  // uniform shape. Bundled children that immediately call createWebhookEndpoint
  // succeed because the inspector is already listening above.
  const spawned: SpawnedChild[] = await spawnType1Children(config.mcp_servers, { log: logLine });
  if (spawned.length > 0) {
    const summary = spawned.map((c) => c.name + "=" + c.port).join(", ");
    log.info({ count: spawned.length, children: summary }, `spawned Type 1 children`);
  }

  // 2b. Connect to all local MCP servers in parallel. Fail fast if any are
  // unreachable.
  log.info(`connecting to ${config.mcp_servers.length} local MCP server(s)`);
  const servers = await connectAll(config.mcp_servers);
  log.info({ servers: [...servers.keys()] }, `connected to local servers`);

  // 3. Build initial manifest and push it into the inspector (already running).
  let manifest: ToolManifest = await buildManifest(config, servers, version, configPath);
  log.info({ tools: countTools(manifest) }, `built manifest`);
  inspector?.setManifest(manifest);

  // Wire operator-driven tool invocation from the inspector UI into the same
  // servers map the dispatcher uses for controller-driven calls. Same callTool
  // path; same per-tool timeout.
  if (inspector) {
    inspector.toolDispatch = async (serverName, toolName, args) => {
      const server = servers.get(serverName);
      if (!server) throw new Error(`no local MCP server '${serverName}'`);
      return server.callTool(toolName, args, {
        timeoutMs: config.policy.tool_timeout_ms,
      });
    };
  }

  await connectTunnel("initial");

  // SIGHUP — reload YAML, rebuild manifest, push delta.
  process.on("SIGHUP", () => { void onSighup(); });

  // Graceful shutdown.
  const shutdown = (signal: string) => {
    shuttingDown = true;
    log.info({ signal }, `shutting down`);
    reconnectCtl.cancel();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (discoveryTimer) clearInterval(discoveryTimer);
    tunnel?.close(`signal:${signal}`);
    void shutdownChildren(spawned, logLine);
    void closeServers(servers).then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // ─── connect / reconnect ────────────────────────────────────────────────
  async function connectTunnel(reason: string): Promise<void> {
    inspector?.setState("connecting");
    log.info({ reason, url: tunnelDialUrl }, `tunnel dialing`);
    const t = new TunnelClient(tunnelDialUrl, auth.authToken, config.tunnel.name, auth.authProvider);
    t.onerror = (e) => log.error({ err: e }, `tunnel error`);
    if (inspector) {
      t.onstate = (s) => inspector.setState(s);
      t.ontap = (tap) => inspector.recordTap(tap);
    }
    t.onclose = () => {
      log.info(`tunnel closed`);
      webhooks.onTunnelClose();
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
      await t.connect();
    } catch (e) {
      log.error({ err: e as Error }, `tunnel connect failed`);
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

    tunnel = t;
    log.info({ url: tunnelDialUrl }, `tunnel connected`);
    inspector?.setHeader({ tunnelOpenSinceAt: new Date().toISOString() });

    t.onframe = createFrameRouter({
      webhooks,
      state,
      statePath,
      inspector,
      reconnect: reconnectCtl,
      log,
      connectorName: config.tunnel.name,
    });

    t.send({
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
      tunnel: t,
      log: dispatcherLog.info.bind(dispatcherLog),
    }).attach();

    startTimers();
  }

  async function reconnect(reason: string): Promise<void> {
    if (reconnecting) return;
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
      tunnel?.close("reconnect");
      tunnel = undefined;

      // Re-read YAML so policy edits land on the next dial. mcp_servers
      // changes still require a full process restart (the connections to
      // local MCP servers were established at boot).
      try {
        const next = loadConfig(configPath);
        if (sameMcpServers(config.mcp_servers, next.mcp_servers)) {
          Object.assign(config, { policy: next.policy });
          log.info(`reconnect: YAML reloaded`);
        } else {
          log.warn(`reconnect: mcp_servers list changed in YAML — restart required to pick that up; using prior list`);
        }
      } catch (e) {
        log.warn({ err: e as Error }, `reconnect: YAML reload failed — using last-known config`);
      }

      // Rebuild manifest against the (possibly updated) config. Updates
      // inspector view too.
      manifest = await buildManifest(config, servers, version, configPath);
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
      const next = await buildManifest(config, servers, version, configPath);
      const delta = diffManifest(manifest, next);
      manifest = next;
      inspector?.setManifest(next);
      if (!isEmptyDelta(delta)) {
        tunnel?.send({ type: "manifest-delta", delta });
        log.info(
          { added: delta.added.length, removed: delta.removed.length, changed: delta.changed.length },
          `pushed manifest-delta`,
        );
      }
    } catch (e) {
      log.error({ err: e as Error }, `discovery refresh failed`);
    }
  }

  async function onSighup(): Promise<void> {
    try {
      const next = loadConfig(configPath);
      if (!sameMcpServers(config.mcp_servers, next.mcp_servers)) {
        log.warn(`SIGHUP: mcp_servers list changed — restart required for live reconnect; ignoring this reload`);
        return;
      }
      Object.assign(config, { policy: next.policy });
      log.info(`SIGHUP: config reloaded`);
      await refreshManifestAndPushDelta();
    } catch (e) {
      log.error({ err: e as Error }, `SIGHUP reload failed`);
    }
  }
}

function countTools(m: ToolManifest): number {
  return m.servers.reduce((n, s) => n + s.tools.length, 0);
}

function sameMcpServers(a: McpServerSpec[], b: McpServerSpec[]): boolean {
  if (a.length !== b.length) return false;
  // Compare every field that affects how we'd spawn or connect to the entry.
  // The reconnect path uses this to decide whether YAML changes are safe to
  // apply live; anything beyond `policy` requires a process restart.
  return a.every((s, i) => {
    const t = b[i];
    if (s.name !== t.name || s.transport !== t.transport) return false;
    if (s.transport === "http" && t.transport === "http") {
      if (s.endpoint !== t.endpoint) return false;
    }
    if (s.transport === "stdio" && t.transport === "stdio") {
      if (s.command.length !== t.command.length) return false;
      if (s.command.some((c, j) => c !== t.command[j])) return false;
      // `bundled` carries the user-facing Type 3 identifier even after we've
      // resolved it to a synthetic stdio spec. Compared so an edit from
      // `bundled: a` to `bundled: b` is detected even if both happen to
      // resolve to identical commands (or both resolve via dev override).
      if (s.bundled !== t.bundled) return false;
    }
    if (s.dir !== t.dir) return false;
    return sameStringMap(s.env, t.env);
  });
}

function sameStringMap(a?: Record<string, string>, b?: Record<string, string>): boolean {
  const ka = a ? Object.keys(a) : [];
  const kb = b ? Object.keys(b) : [];
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a?.[k] === b?.[k]);
}

async function closeServers(servers: Map<string, McpServerConnection>): Promise<void> {
  await Promise.all([...servers.values()].map((s) => s.close().catch(() => undefined)));
}
