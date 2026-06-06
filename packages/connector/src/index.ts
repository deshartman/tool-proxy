import "dotenv/config";
import { parseArgs } from "node:util";
import { loadConfig, type McpServerSpec, type ReconnectPolicyConfig } from "./config.js";
import { connectAll, type McpServerConnection } from "./servers/index.js";
import { buildManifest } from "./manifest/build.js";
import { diffManifest, isEmptyDelta } from "./manifest/diff.js";
import { TunnelClient } from "./tunnel/client.js";
import { Dispatcher } from "./dispatcher.js";
import type { ToolManifest } from "./tunnel/frames.js";
import { Inspector, startInspector } from "./inspector/server.js";
import { runDiscover } from "./discover.js";
import { runInit } from "./init.js";
import { spawnType1Children, shutdownChildren, type SpawnedChild } from "./spawner.js";
import { readState, writeState, defaultStatePath, type ConnectorState } from "./state.js";

const USAGE = `usage: mcp-connector <command> [options]

commands:
  start                   run the connector (default). Auto-registers with the controller on first connect.
  init                    interactive wizard to write connector.yaml
  discover                connect to MCP servers and print tools/list
  version                 print the connector version

start options:
  --config <path>         override CONNECTOR_CONFIG
  --inspector-port <n>    override INSPECTOR_PORT (0 disables)
  --no-inspector          shorthand for --inspector-port 0
  -h, --help              show this help`;

async function dispatch(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "start";
  const rest = command === argv[0] ? argv.slice(1) : argv;

  switch (command) {
    case "start":
      applyStartFlags(rest);
      await main();
      return;
    case "version":
      console.log(process.env.CONNECTOR_VERSION ?? "dev");
      return;
    case "discover":
      await runDiscover(rest);
      return;
    case "init":
      await runInit(rest);
      return;
    case "help":
    case "-h":
    case "--help":
      console.log(USAGE);
      return;
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      process.exit(2);
  }
}

function applyStartFlags(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      "inspector-port": { type: "string" },
      "no-inspector": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) { console.log(USAGE); process.exit(0); }
  if (values.config) process.env.CONNECTOR_CONFIG = values.config;
  if (values["no-inspector"]) process.env.INSPECTOR_PORT = "0";
  if (values["inspector-port"]) process.env.INSPECTOR_PORT = values["inspector-port"];
}

async function main() {
  const configPath = process.env.CONNECTOR_CONFIG;
  if (!configPath) throw new Error("CONNECTOR_CONFIG env var is required");
  const version = process.env.CONNECTOR_VERSION ?? "dev";
  // Set INSPECTOR_PORT=0 to disable; defaults to 9090.
  const inspectorPort = process.env.INSPECTOR_PORT === "0"
    ? 0
    : Number(process.env.INSPECTOR_PORT ?? 9090);

  const config = loadConfig(configPath);
  const authToken = config.tunnel.auth_token;
  const authStatus = authToken ? `set (len=${authToken.length})` : "absent";

  // Identity: read the persisted registrationToken (if any). On first connect
  // it's absent and we send `name` only — the controller mints a row and
  // returns a token in the register-ack, which we persist for next boot.
  const statePath = defaultStatePath();
  const state: ConnectorState = readState(statePath);
  const identityStatus = state.registrationToken
    ? `reconnect (token len=${state.registrationToken.length})`
    : `first-connect (name="${config.tunnel.name}")`;
  log(`config loaded: name=${config.tunnel.name} environment=${config.tunnel.environment} auth_token=${authStatus} identity=${identityStatus}`);

  // 1a. Spawn Type 1 children (http transport + dir + no endpoint). Mutates
  // the spec list to fill in `endpoint` so the dispatch path below sees a
  // uniform shape.
  const spawned: SpawnedChild[] = await spawnType1Children(config.mcp_servers, { log });
  if (spawned.length > 0) {
    const summary = spawned.map((c) => c.name + "=" + c.port).join(", ");
    log(`spawned ${spawned.length} Type 1 child(ren): ${summary}`);
  }

  // 1b. Connect to all local MCP servers in parallel. Fail fast if any are unreachable.
  log(`connecting to ${config.mcp_servers.length} local MCP server(s)...`);
  const servers = await connectAll(config.mcp_servers);
  log(`connected to local servers: ${[...servers.keys()].join(", ")}`);

  // 2. Build initial manifest.
  let manifest: ToolManifest = await buildManifest(config, servers, version);
  log(`built manifest with ${countTools(manifest)} tool(s)`);

  // The yaml carries `controller_url` (HTTPS root, used for the register API
  // and shown in the inspector). TunnelClient upgrades https:// → wss:// and
  // appends the /mcp-tunnel path in tunnel/client.ts before dialling.
  const tunnelDialUrl = config.tunnel.controller_url;

  // 3. Inspector first, so it survives tunnel cycles.
  const inspector = inspectorPort > 0
    ? new Inspector({
        controllerUrl: config.tunnel.controller_url,
        state: "connecting",
        manifest,
      })
    : undefined;

  // Live mutable references — replaced on each reconnect.
  let tunnel: TunnelClient | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let discoveryTimer: NodeJS.Timeout | undefined;
  let reconnecting = false;
  let shuttingDown = false;
  // Auto-reconnect state. reconnectAttempt is the count of consecutive
  // unsuccessful attempts since the last successful register-ack.
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  // Set when the controller actively rejects our register frame (e.g.
  // unknown_registration_token after the controller's row was deleted). The
  // close that follows is permanent until the operator intervenes — clearing
  // .connector-state.json and clicking Reconnect — so we suppress the
  // auto-reconnect loop instead of hammering the controller with a token it
  // already told us it doesn't recognize. Cleared on a successful register-ack
  // and on every manual reconnect (the operator's click is the signal that
  // they've fixed it).
  let registrationRejected = false;

  if (inspector) {
    inspector.onReconnect = () => { void reconnect("inspector requested"); };
    startInspector(inspectorPort, inspector);
  }

  await connectTunnel("initial");

  // SIGHUP — reload YAML, rebuild manifest, push delta.
  process.on("SIGHUP", () => { void onSighup(); });

  // Graceful shutdown.
  const shutdown = (signal: string) => {
    shuttingDown = true;
    log(`received ${signal} — shutting down`);
    cancelAutoReconnect();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (discoveryTimer) clearInterval(discoveryTimer);
    tunnel?.close(`signal:${signal}`);
    void shutdownChildren(spawned, log);
    void closeServers(servers).then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // ─── connect / reconnect ────────────────────────────────────────────────
  async function connectTunnel(reason: string): Promise<void> {
    inspector?.setState("connecting");
    log(`tunnel ${reason}: dialing ${tunnelDialUrl}`);
    const t = new TunnelClient(tunnelDialUrl, authToken);
    t.onerror = (e) => log(`tunnel error: ${e.message}`);
    if (inspector) {
      t.onstate = (s) => inspector.setState(s);
      t.ontap = (tap) => inspector.recordTap(tap);
    }
    t.onclose = () => {
      log(`tunnel closed`);
      stopTimers();
      // SIGTERM/SIGINT and the manual /reconnect path both close the tunnel
      // intentionally — they handle their own bookkeeping. Auto-reconnect
      // only triggers on an *unexpected* close (network blip, controller
      // restart). The inspector still goes 'closed' first; we then transition
      // it to 'reconnecting' below if the policy is enabled.
      if (shuttingDown || reconnecting) return;
      if (!config.policy.reconnect.enabled) return;
      // A controller-side rejection (e.g. unknown_registration_token) means
      // retrying with the same identity will fail identically forever. Stay
      // in 'closed' until the operator clicks Reconnect (which clears the
      // flag) or restarts the connector with a fresh state file.
      if (registrationRejected) {
        log(`auto-reconnect suppressed: controller rejected the registration — clear .connector-state.json and click Reconnect`);
        return;
      }
      scheduleAutoReconnect();
    };

    try {
      await t.connect();
    } catch (e) {
      log(`tunnel connect failed: ${(e as Error).message}`);
      inspector?.setState("closed");
      return;
    }

    tunnel = t;
    log(`tunnel connected to ${tunnelDialUrl}`);

    // Listen for register-ack to capture a freshly-minted registrationToken
    // on first connect. Mounted before sending register so we don't miss the
    // ack racing back. The ontap subscription on the tunnel client also
    // surfaces this to the inspector — this listener only persists the token.
    t.onframe = (frame) => {
      if (frame.type === "register-ack") {
        if (frame.error) {
          log(`register-ack rejected: code=${frame.error.code} message=${frame.error.message}`);
          registrationRejected = true;
          return;
        }
        // Successful register-ack means we're healthy — clear any
        // accumulated reconnect-attempt count so the next blip restarts
        // the backoff at the bottom of the curve.
        registrationRejected = false;
        if (reconnectAttempt > 0) {
          log(`tunnel healthy — resetting reconnect attempts (was ${reconnectAttempt})`);
          reconnectAttempt = 0;
        }
        if (frame.registrationToken && frame.registrationToken !== state.registrationToken) {
          state.registrationToken = frame.registrationToken;
          try {
            writeState(state, statePath);
            log(`register-ack ok — persisted registrationToken to ${statePath}`);
          } catch (e) {
            log(`register-ack: failed to persist token: ${(e as Error).message}`);
          }
        } else if (frame.accepted) {
          const idForLog = frame.connectorId ?? "?";
          log(`register-ack ok — bound to existing record ${idForLog}`);
        }
      }
    };

    t.send({
      type: "register",
      manifest,
      name: config.tunnel.name,
      ...(state.registrationToken ? { registrationToken: state.registrationToken } : {}),
    });
    log(`register frame sent`);

    // Wire dispatcher to this tunnel instance.
    new Dispatcher({
      config,
      servers,
      getManifest: () => manifest,
      tunnel: t,
      log,
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
      cancelAutoReconnect();
      // The operator clicking Reconnect is the signal that they've fixed
      // whatever caused the rejection (typically: cleared .connector-state.json
      // so we re-mint, or re-provisioned the controller row). Clear the
      // suppression so the new attempt can land — and so the next blip
      // resumes the auto-reconnect loop.
      registrationRejected = false;
      log(`reconnect requested: ${reason}`);
      stopTimers();
      tunnel?.close("reconnect");
      tunnel = undefined;

      // Re-read YAML so policy edits land on the next dial.
      // mcp_servers changes still require a full process restart (the
      // connections to local MCP servers were established at boot).
      try {
        const next = loadConfig(configPath!);
        if (sameMcpServers(config.mcp_servers, next.mcp_servers)) {
          Object.assign(config, { policy: next.policy });
          log(`reconnect: YAML reloaded`);
        } else {
          log(`reconnect: mcp_servers list changed in YAML — restart required to pick that up; using prior list`);
        }
      } catch (e) {
        log(`reconnect: YAML reload failed (${(e as Error).message}) — using last-known config`);
      }

      // Rebuild manifest against the (possibly updated) config. Updates
      // inspector view too.
      manifest = await buildManifest(config, servers, version);
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

  // ─── auto-reconnect ─────────────────────────────────────────────────────
  function scheduleAutoReconnect(): void {
    const policy = config.policy.reconnect;
    reconnectAttempt += 1;
    if (policy.max_attempts > 0 && reconnectAttempt > policy.max_attempts) {
      log(`auto-reconnect: gave up after ${policy.max_attempts} attempt(s); inspector stays in 'closed' until manual reconnect`);
      reconnectAttempt = 0;
      return;
    }
    const delayMs = nextReconnectDelay(reconnectAttempt, policy);
    log(`auto-reconnect: attempt ${reconnectAttempt} in ${delayMs}ms`);
    inspector?.setReconnecting({ attempt: reconnectAttempt, nextDelayMs: delayMs });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void reconnect(`auto attempt ${reconnectAttempt}`);
    }, delayMs);
  }

  function cancelAutoReconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  }

  async function refreshManifestAndPushDelta(): Promise<void> {
    try {
      const next = await buildManifest(config, servers, version);
      const delta = diffManifest(manifest, next);
      manifest = next;
      inspector?.setManifest(next);
      if (!isEmptyDelta(delta)) {
        tunnel?.send({ type: "manifest-delta", delta });
        log(`pushed manifest-delta: +${delta.added.length}/-${delta.removed.length}/~${delta.changed.length}`);
      }
    } catch (e) {
      log(`discovery refresh failed: ${(e as Error).message}`);
    }
  }

  async function onSighup(): Promise<void> {
    try {
      const next = loadConfig(configPath!);
      if (!sameMcpServers(config.mcp_servers, next.mcp_servers)) {
        log(`SIGHUP: mcp_servers list changed — restart required for live reconnect; ignoring this reload`);
        return;
      }
      Object.assign(config, { policy: next.policy });
      log(`SIGHUP: config reloaded`);
      await refreshManifestAndPushDelta();
    } catch (e) {
      log(`SIGHUP reload failed: ${(e as Error).message}`);
    }
  }
}

function countTools(m: ToolManifest): number {
  return m.servers.reduce((n, s) => n + s.tools.length, 0);
}

// Compute the delay before the next auto-reconnect attempt.
//
//   attempt: 1-indexed attempt count (1 = first retry after an unexpected close,
//            reset to 0 on a successful register-ack)
//   policy:  the policy.reconnect block from the yaml — initial_backoff_ms,
//            max_backoff_ms, max_attempts (the caller already applied
//            max_attempts; this fn doesn't need to re-check it)
//
// USER CONTRIBUTION POINT — the current implementation is the trivial
// baseline: a fixed delay equal to initial_backoff_ms. It works (the
// connector recovers from blips) but it's not what you'd want behind a real
// controller serving many connectors after an outage.
//
// Replace with a real backoff. Trade-offs to weigh (see plan doc for the
// long version — /Users/dhartman/.claude/plans/logical-spinning-badger.md):
//   - Pure exponential is predictable but synchronizes — bad if many
//     connectors reconnect to one controller after an outage.
//   - Full jitter (random(0, cap)) avoids thundering herds but can also
//     retry very fast on small attempt counts.
//   - Equal jitter (half + random(0, half)) keeps a floor while spreading.
//   - Decorrelated jitter (AWS) is the smoothest spread for many clients.
//
// Use policy.initial_backoff_ms and policy.max_backoff_ms as the bounds.
// Drop a one-line comment naming the strategy you picked.
function nextReconnectDelay(_attempt: number, policy: ReconnectPolicyConfig): number {
  // Strategy: fixed delay (placeholder). Replace with a backoff curve.
  return policy.initial_backoff_ms;
}

function sameMcpServers(
  a: McpServerSpec[],
  b: McpServerSpec[]
): boolean {
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

function log(msg: string): void {
  console.log(`[connector] ${msg}`);
}

dispatch().catch((e) => {
  console.error("connector startup failed:", e);
  process.exit(1);
});
