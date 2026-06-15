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
import { readState, writeState, clearRegistrationToken, defaultStatePath, type ConnectorState } from "./state.js";
import { createLogger } from "./logger.js";
import { OAuthClientCredentialsProvider } from "./auth/oauth-provider.js";

const log = createLogger("connector");
// Adapter for downstream callbacks that take `(msg: string) => void`.
// Spawner and Dispatcher were designed around a plain string callback;
// .bind() gives them a Pino-info function with that exact shape.
const logLine = log.info.bind(log);

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
  // Two postures, env-driven dispatch: OAuth2 client_credentials (preferred
  // when OAUTH_CLIENT_ID is set) or the static ts_<...> bearer. Mutually
  // exclusive — operator picks one per controller-side row. Either path
  // must produce a bearer; refusing to boot here matches the symmetry with
  // ${CONNECTOR_NAME} (both required, both fail fast at boot rather than
  // silently dialing and getting rejected mid-handshake).
  const oauthClientId = process.env.OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.OAUTH_CLIENT_SECRET;
  const oauthTokenUrl = process.env.OAUTH_TOKEN_URL;
  const authProvider = oauthClientId
    ? new OAuthClientCredentialsProvider(
        oauthClientId,
        requireOauthEnv("OAUTH_CLIENT_SECRET", oauthClientSecret),
        requireOauthEnv("OAUTH_TOKEN_URL", oauthTokenUrl),
      )
    : undefined;
  if (!authProvider && !authToken) {
    throw new Error(
      "tunnel auth missing. Set TUNNEL_AUTH_TOKEN (static bearer) or OAUTH_CLIENT_ID + OAUTH_CLIENT_SECRET + OAUTH_TOKEN_URL (OAuth2). See packages/connector/.env.example.",
    );
  }
  const authStatus = authProvider
    ? `oauth2 (clientId=${oauthClientId})`
    : `set (len=${authToken!.length})`;

  // Identity: read the persisted registrationToken (if any). On first connect
  // it's absent and we send `name` only — the controller mints a row and
  // returns a token in the register-ack, which we persist for next boot.
  const statePath = defaultStatePath();
  const state: ConnectorState = readState(statePath);
  const identityStatus = state.registrationToken
    ? `reconnect (token len=${state.registrationToken.length})`
    : `first-connect (name="${config.tunnel.name}")`;
  log.info(
    { name: config.tunnel.name, environment: config.tunnel.environment, authToken: authStatus, identity: identityStatus },
    `config loaded`
  );

  // 1a. Spawn Type 1 children (http transport + dir + no endpoint). Mutates
  // the spec list to fill in `endpoint` so the dispatch path below sees a
  // uniform shape.
  const spawned: SpawnedChild[] = await spawnType1Children(config.mcp_servers, { log: logLine });
  if (spawned.length > 0) {
    const summary = spawned.map((c) => c.name + "=" + c.port).join(", ");
    log.info({ count: spawned.length, children: summary }, `spawned Type 1 children`);
  }

  // 1b. Connect to all local MCP servers in parallel. Fail fast if any are unreachable.
  log.info(`connecting to ${config.mcp_servers.length} local MCP server(s)`);
  const servers = await connectAll(config.mcp_servers);
  log.info({ servers: [...servers.keys()] }, `connected to local servers`);

  // 2. Build initial manifest.
  let manifest: ToolManifest = await buildManifest(config, servers, version, configPath);
  log.info({ tools: countTools(manifest) }, `built manifest`);

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
    inspector.setIdentity(
      state.registrationToken
        ? { kind: "bound", tokenLen: state.registrationToken.length }
        : { kind: "first-connect" }
    );
    startInspector(inspectorPort, inspector);
  }

  await connectTunnel("initial");

  // SIGHUP — reload YAML, rebuild manifest, push delta.
  process.on("SIGHUP", () => { void onSighup(); });

  // Graceful shutdown.
  const shutdown = (signal: string) => {
    shuttingDown = true;
    log.info({ signal }, `shutting down`);
    cancelAutoReconnect();
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
    const t = new TunnelClient(tunnelDialUrl, authToken, config.tunnel.name, authProvider);
    t.onerror = (e) => log.error({ err: e }, `tunnel error`);
    if (inspector) {
      t.onstate = (s) => inspector.setState(s);
      t.ontap = (tap) => inspector.recordTap(tap);
    }
    t.onclose = () => {
      log.info(`tunnel closed`);
      stopTimers();
      // SIGTERM/SIGINT closes the tunnel intentionally — that path sets
      // shuttingDown so we bail. The manual /reconnect path also closes
      // intentionally, but TunnelClient.close() suppresses onclose for those
      // (sets this.closed=true, so handleClose returns early), so we don't
      // need to gate on `reconnecting` here. We *do* want to fire auto-reconnect
      // when a dial that was kicked off by reconnect() then fails or drops —
      // that's the controller-restart recovery path.
      if (shuttingDown) return;
      if (!config.policy.reconnect.enabled) return;
      // A controller-side rejection (e.g. unknown_registration_token) means
      // retrying with the same identity will fail identically forever. Stay
      // in 'closed' until the operator clicks Reconnect (which clears the
      // flag) or restarts the connector with a fresh state file.
      if (registrationRejected) {
        log.warn(`auto-reconnect suppressed: controller rejected the registration — clear .connector-state.json and click Reconnect`);
        return;
      }
      scheduleAutoReconnect();
    };

    try {
      await t.connect();
    } catch (e) {
      log.error({ err: e as Error }, `tunnel connect failed`);
      inspector?.setState("closed");
      // A handshake failure (e.g. WS 502 because the controller is briefly
      // unreachable, or ngrok cycling) is the same recoverable state as a
      // mid-session close — schedule the same auto-reconnect path with the
      // same gates. Without this, a transient 502 leaves the connector
      // stranded in 'closed' until manual intervention. The onclose path
      // never fires for a connection that never reached OPEN, so this is
      // the only place we can hook the recovery.
      //
      // Don't gate on `reconnecting`: this catch *fires inside* an in-flight
      // reconnect attempt, so reconnecting=true is normal here. Skipping the
      // schedule would leave us stuck after a single 502 from a controller
      // that's still mid-restart. `reconnect()` itself guards re-entry.
      if (shuttingDown) return;
      if (!config.policy.reconnect.enabled) return;
      if (registrationRejected) {
        log.warn(`auto-reconnect suppressed: controller rejected the registration — clear .connector-state.json and click Reconnect`);
        return;
      }
      scheduleAutoReconnect();
      return;
    }

    tunnel = t;
    log.info({ url: tunnelDialUrl }, `tunnel connected`);

    // Listen for register-ack to capture a freshly-minted registrationToken
    // on first connect. Mounted before sending register so we don't miss the
    // ack racing back. The ontap subscription on the tunnel client also
    // surfaces this to the inspector — this listener only persists the token.
    t.onframe = (frame) => {
      if (frame.type === "register-ack") {
        if (frame.error) {
          // unknown_registration_token: our persisted token no longer maps to
          // a row controller-side (DB reset, row deleted, fresh volume). The
          // recovery used to require the operator to delete .connector-state.json
          // by hand and click Reconnect — instead, we clear the token ourselves
          // and let auto-reconnect retry with no token, which the controller
          // treats as a first-connect and mints a fresh row. registrationRejected
          // stays false so onclose schedules the next attempt.
          if (frame.error.code === "unknown_registration_token") {
            log.warn(
              { code: frame.error.code },
              `controller no longer recognizes our registrationToken — clearing local state to re-mint on next attempt`
            );
            state.registrationToken = undefined;
            try {
              clearRegistrationToken(statePath);
            } catch (e) {
              log.error({ err: e as Error }, `failed to clear connector-state.json — next attempt may still present a stale token`);
            }
            inspector?.setIdentity({ kind: "cleared" });
            return;
          }
          // name_taken: a different connector row already owns CONNECTOR_NAME.
          // Self-healing isn't safe — silently retrying could mask a config
          // mistake. Stay sticky and log an action-oriented message so the
          // operator knows exactly what to do.
          if (frame.error.code === "name_taken") {
            log.error(
              { code: frame.error.code, name: config.tunnel.name },
              `name "${config.tunnel.name}" is already bound to another connector row — delete that row controller-side, or change CONNECTOR_NAME and restart. auto-reconnect suppressed.`
            );
            registrationRejected = true;
            inspector?.setIdentity({ kind: "rejected", reason: "name_taken", message: `name "${config.tunnel.name}" already bound to another connector row` });
            return;
          }
          log.error({ code: frame.error.code, message: frame.error.message }, `register-ack rejected`);
          registrationRejected = true;
          inspector?.setIdentity({ kind: "rejected", reason: frame.error.code, message: frame.error.message });
          return;
        }
        // Successful register-ack means we're healthy — clear any
        // accumulated reconnect-attempt count so the next blip restarts
        // the backoff at the bottom of the curve.
        registrationRejected = false;
        if (reconnectAttempt > 0) {
          log.info({ priorAttempts: reconnectAttempt }, `tunnel healthy — reset reconnect attempts`);
          reconnectAttempt = 0;
        }
        resetReconnectDelay();
        if (frame.registrationToken && frame.registrationToken !== state.registrationToken) {
          state.registrationToken = frame.registrationToken;
          try {
            writeState(state, statePath);
            log.info({ statePath }, `register-ack ok — persisted registrationToken`);
          } catch (e) {
            log.error({ err: e as Error }, `register-ack: failed to persist token`);
          }
        } else if (frame.accepted) {
          log.info({ connectorId: frame.connectorId ?? "?" }, `register-ack ok — bound to existing record`);
        }
        inspector?.setIdentity({ kind: "bound", tokenLen: state.registrationToken?.length ?? 0 });
      }
    };

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
      cancelAutoReconnect();
      // The operator clicking Reconnect is the signal that they've fixed
      // whatever caused the rejection (typically: cleared .connector-state.json
      // so we re-mint, or re-provisioned the controller row). Clear the
      // suppression so the new attempt can land — and so the next blip
      // resumes the auto-reconnect loop.
      registrationRejected = false;
      log.info({ reason }, `reconnect requested`);
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
          log.info(`reconnect: YAML reloaded`);
        } else {
          log.warn(`reconnect: mcp_servers list changed in YAML — restart required to pick that up; using prior list`);
        }
      } catch (e) {
        log.warn({ err: e as Error }, `reconnect: YAML reload failed — using last-known config`);
      }

      // Rebuild manifest against the (possibly updated) config. Updates
      // inspector view too.
      manifest = await buildManifest(config, servers, version, configPath!);
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
    // Idempotent: a failed dial typically triggers both ws 'error' (caught
    // in connectTunnel) and ws 'close' (routed through onclose) — both call
    // here. The first one wins; the second is a no-op so we don't
    // double-increment reconnectAttempt or stomp the timer.
    if (reconnectTimer) return;
    const policy = config.policy.reconnect;
    reconnectAttempt += 1;
    if (policy.max_attempts > 0 && reconnectAttempt > policy.max_attempts) {
      log.warn({ maxAttempts: policy.max_attempts }, `auto-reconnect: gave up; inspector stays in 'closed' until manual reconnect`);
      reconnectAttempt = 0;
      return;
    }
    const delayMs = nextReconnectDelay(reconnectAttempt, policy);
    log.info({ attempt: reconnectAttempt, delayMs }, `auto-reconnect scheduled`);
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
      const next = await buildManifest(config, servers, version, configPath!);
      const delta = diffManifest(manifest, next);
      manifest = next;
      inspector?.setManifest(next);
      if (!isEmptyDelta(delta)) {
        tunnel?.send({ type: "manifest-delta", delta });
        log.info(
          { added: delta.added.length, removed: delta.removed.length, changed: delta.changed.length },
          `pushed manifest-delta`
        );
      }
    } catch (e) {
      log.error({ err: e as Error }, `discovery refresh failed`);
    }
  }

  async function onSighup(): Promise<void> {
    try {
      const next = loadConfig(configPath!);
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

function requireOauthEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} is required when OAUTH_CLIENT_ID is set. See packages/connector/.env.example for the OAuth2 posture.`,
    );
  }
  return value;
}

// Compute the delay before the next auto-reconnect attempt.
//
// Strategy: decorrelated jitter (AWS pattern). Each delay is drawn from
//   uniform(initial_backoff_ms, lastDelay * 3), capped at max_backoff_ms.
// This produces a spread that climbs without synchronizing across many
// connectors recovering from the same outage, with a known floor and ceiling.
// `lastDelay` is module-level state so the curve resumes where it left off
// across attempts; `resetReconnectDelay()` is called from the success path
// (alongside reconnectAttempt = 0) so the next blip restarts at the floor.
let lastDelay = 0;

function nextReconnectDelay(_attempt: number, policy: ReconnectPolicyConfig): number {
  if (lastDelay === 0) lastDelay = policy.initial_backoff_ms;
  const upper = Math.max(policy.initial_backoff_ms, lastDelay * 3);
  const span = upper - policy.initial_backoff_ms;
  const draw = policy.initial_backoff_ms + Math.floor(Math.random() * (span + 1));
  const next = Math.min(policy.max_backoff_ms, draw);
  lastDelay = next;
  return next;
}

function resetReconnectDelay(): void {
  lastDelay = 0;
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

dispatch().catch((e) => {
  log.fatal({ err: e as Error }, `connector startup failed`);
  process.exit(1);
});
