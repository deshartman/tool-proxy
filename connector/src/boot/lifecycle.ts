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
import { wrapWithMessageTap } from "../servers/message-tap.js";
import { redactTapPayload } from "../policy/redact.js";
import { buildManifest } from "../manifest/build.js";
import { diffManifest, isEmptyDelta } from "../manifest/diff.js";
import { validateManifestSchemas } from "../manifest/validate.js";
import { TunnelClient } from "../tunnel/client.js";
import { formatHandshakeFailure } from "../tunnel/format-log.js";
import { Dispatcher } from "../dispatcher.js";
import type { ToolManifest } from "../tunnel/frames.js";
import { Inspector, startInspector, rebindInspector } from "../inspector/server.js";
import { startHealthServer, type HealthState } from "../health/server.js";
import { createNetworkAccessRoutes } from "../inspector/network-access-routes.js";
import { handleOauthToken } from "../inspector/oauth-token-route.js";
import { handleOutboundCalls } from "../inspector/outbound-calls-route.js";
import { handleMemoryEvents } from "../inspector/memory-events-route.js";
import { createIdentityRoutes } from "../inspector/identity-routes.js";
import { deriveJwtSigningKey } from "../auth/jwt.js";
import { createLogger } from "../logger.js";
import { WebhookRegistry } from "../tunnel/webhook-registry.js";
import { ReconnectController } from "../tunnel/reconnect.js";
import { createFrameRouter } from "../tunnel/frame-router.js";
import { CredsCoordinator } from "../tunnel/creds-coordinator.js";
import { ControllerApiCoordinator } from "../tunnel/controller-api-coordinator.js";
import { McpConfigCoordinator } from "../tunnel/mcp-config-coordinator.js";
import { LocalMcpsCoordinator } from "../tunnel/local-mcps-coordinator.js";
import { ApprovalCoordinator } from "../tunnel/approval-coordinator.js";
import { NotificationForwarder } from "../tunnel/notification-forwarder.js";
import { McpSupervisor, type SupervisedSpec } from "../mcp-supervisor.js";
import { discoverBundled, discoverDropins, type DropinSpec } from "../dropin.js";
import { resolveAuthFromRow, type AuthResolution } from "./auth.js";
import { requireEnv } from "./require-env.js";
import { announceDiscoveredDropins as announceDropinsLoop } from "./announce-dropins.js";
import { ConfigStore, type ControllerRow } from "../config-store/index.js";
import { initSodium } from "../config-store/seal.js";
import { resolveMasterKey } from "../config-store/master-key.js";
import { createTunnelRoutes } from "../inspector/tunnel-routes.js";
import { envOptional, envString, envNumber } from "../env.js";

const log = createLogger("connector");
// Adapter for downstream callbacks that take `(msg: string) => void`.
const logLine = log.info.bind(log);

export async function boot(): Promise<void> {
  await bootFromDb();
}

// bootFromEnv() was deleted with the env-mode removal (see fix/env-mode-removal
// branch). Tunnel identity + creds now live exclusively in the sealed config
// store, managed via the inspector Configure Tunnel UI. bootFromDb is the sole
// boot path — the name is now a slight misnomer (DB-TO-FILE swapped Postgres
// for a sealed JSON file on the state volume), kept because the lifecycle-tdz
// test and several comments key on it and the shape of the function did not
// change: it reads one controller record and returns early when there is none.




async function bootFromDb(): Promise<void> {
  requireEnv();

  // WARN once for any legacy per-controller env var still present. These
  // belonged to `env` mode; under `db` mode they're silently ignored, which
  // makes a "why isn't my rotated bearer taking effect?" support ticket
  // very easy to misread. Naming each stray var in the log is the cheap
  // signal that steers the operator to the inspector UI. Only fires in
  // `db` mode — `bootFromEnv` REQUIRES these vars, so warning there would
  // be nonsense.
  for (const name of ["CONTROLLER_URL", "CONNECTOR_NAME", "TUNNEL_AUTH_TOKEN", "OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "OAUTH_TOKEN_URL"]) {
    if (envOptional(name)) {
      log.warn(`legacy per-controller env var '${name}' present but ignored — tunnel identity lives in Postgres; remove from .env`);
    }
  }

  await initSodium();
  const masterKey = resolveMasterKey();
  const store = await ConfigStore.open(masterKey);

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

  // WARN if legacy tunnel: block is present in yaml (db mode ignores it)
  if (config.tunnel) {
    log.warn("legacy 'tunnel:' block in connector.yaml ignored — tunnel identity lives in Postgres; remove it from your yaml");
  }

  // Live mutable references — replaced on each reconnect.
  // Hoisted above the getController() call so the dialTunnel closure (wired
  // into the inspector routes before we know whether the DB has a row) can
  // safely assign into them. Under the empty-DB boot path these stay
  // undefined until an operator submits the Configure Tunnel modal, at
  // which point dialTunnel populates them before invoking connectTunnelDb.
  // Prior to hoisting, `let auth = …` sat inside the row-exists branch and
  // the closure hit a TDZ error ("Cannot access 'auth' before initialization")
  // whenever the paste flow fired in empty-DB mode.
  let tunnel: TunnelClient | undefined;
  // v1.4 — Controller API calls. Same TDZ hoisting rationale as `tunnel`:
  // the inspector loopback route (wired into mcpActions below) reads this
  // at request time, not at route-registration time, so it must resolve
  // to `undefined` (not throw) whenever no tunnel is connected — including
  // during the empty-DB boot window before this function's row-exists
  // branch ever runs.
  let controllerApi: ControllerApiCoordinator | undefined;
  let row: ControllerRow | null = null;
  let auth: AuthResolution | undefined = undefined;
  let tunnelDialUrl: string | undefined = undefined;

  // Forward declaration: inspector constructed below, referenced by callbacks.
  let inspector: Inspector | undefined;

  // ── Health endpoints ──────────────────────────────────────────────────
  // Declared HERE, above the empty-store early return, and deliberately so:
  // an unconfigured connector must still answer /livez, or an orchestrator
  // kills the very process an operator is about to configure through the
  // Configure Tunnel modal. See the TDZ block in CLAUDE.md — any binding the
  // closure below reads has to live above that return.
  //
  // `configLoaded` flips once `loadConfig` has returned, which by this point it
  // has. It exists to distinguish "still booting" from "booted, tunnel down".
  let healthConfigLoaded = false;
  // Hoisted alias for the supervisor. `supervisor` itself is a `const` declared
  // further down, and reading a const from a closure that can fire before the
  // declaration is evaluated throws on the TDZ — the failure
  // tests/boot/lifecycle-tdz.test.ts exists to catch. Assigned right after the
  // supervisor is constructed.
  let healthSupervisor: McpSupervisor | undefined;
  const healthState = (): HealthState => ({
    configLoaded: healthConfigLoaded,
    // Read through the tunnel object, not a cached flag: `open` is the only
    // state that counts as ready, and a cached boolean would go stale on every
    // reconnect.
    tunnelOpen: tunnel?.state === "open",
    // Children still coming up. `permanently-failed` is EXCLUDED — see the
    // Q-A1 note on HealthState. `supervisor` is assigned further down, so this
    // reports an empty list until then, which is correct: before the supervisor
    // exists there are no children to wait for, and `configLoaded` is the gate
    // that keeps readiness false in that window.
    childrenPending: (healthSupervisor?.statusList() ?? [])
      .filter((st) => st.process === "restarting" || st.process === "stopped")
      .map((st) => st.name),
  });

  const healthServer = startHealthServer({ port: healthPort, getState: healthState, log });
  // Config parsed above, so readiness can stop reporting config_not_loaded and
  // start reporting the condition that is actually unmet.
  healthConfigLoaded = true;

  const webhooks = new WebhookRegistry({
    sendFrame: (frame) => {
      if (tunnel?.state !== "open") return false;
      tunnel.send(frame);
      return true;
    },
    onDispatched: () => inspector?.publishWebhookSnapshot(),
  });

  inspector = inspectorPort > 0
    ? new Inspector({
        controllerUrl: "http://127.0.0.1:0",  // placeholder, updated when row is loaded
        state: "connecting",
        webhooks,
      })
    : undefined;

  let heartbeatTimer: NodeJS.Timeout | undefined;
  let discoveryTimer: NodeJS.Timeout | undefined;
  let reconnecting = false;
  let shuttingDown = false;

  const reconnectCtl = new ReconnectController({
    getPolicy: () => config.policy.reconnect,
    onFire: () => { void reconnect(`auto attempt ${reconnectCtl.attemptCount()}`); },
    onReconnecting: (info) => inspector?.setReconnecting(info),
    log,
  });

  if (inspector) {
    inspector.onReconnect = () => { void reconnect("inspector requested", { manual: true }); };
    // CONNECTOR-NETWORK-EXPOSURE — if a prior boot already had an API
    // client added, bind non-loopback directly on this boot too (the
    // loopback-first-then-add-a-client sequence is one-time, not
    // something repeated on every restart).
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
      signingKey: deriveJwtSigningKey(masterKey.bytes),
      expiresInSec: 3600,
    }));

    // CONNECTOR-NETWORK-EXPOSURE step 9 — the one machine-API route with a
    // real dependency on ControllerApiCoordinator. Wired once here, same as
    // oauthTokenHandler above (both ABOVE the empty-DB `if (!row) return`
    // below — see CLAUDE.md "TDZ discipline inside bootFromDb"). getCoordinator
    // reads the outer hoisted `controllerApi` binding directly, so it always
    // reflects the live tunnel's coordinator (or undefined between
    // reconnects) with no rewiring needed on every dial — same pattern
    // mcpActions.callControllerApi already relies on.
    inspector.wireOutboundCalls((req, res) => handleOutboundCalls(req, res, {
      // FEDERATED-JWT-MODE §4 — read the trusted-issuer config fresh from
      // Postgres on every request so an operator setting/clearing it live
      // takes effect immediately, no restart. The self-issued HS256 key is
      // still derived once from the master key; the federated RS256 branch
      // is present only when store.getTrustedIssuerConfig() returns a row.
      getVerifierConfig: async () => ({
        selfIssuedSigningKey: deriveJwtSigningKey(masterKey.bytes),
        trustedIssuer: await store.getTrustedIssuerConfig(),
      }),
      getCoordinator: () => controllerApi,
    }));

    // MEMORY-INJECTION — POST /v1/memory/events, the machine-API sibling of
    // /v1/outbound/calls above. Same deps shape, same reasons: getVerifierConfig
    // reads the trusted-issuer config fresh from Postgres per request so a live
    // operator change needs no restart, and getCoordinator reads the outer
    // hoisted `controllerApi` binding so it always reflects the live tunnel's
    // coordinator (or undefined between reconnects). Also wired ABOVE the
    // empty-DB `if (!row) return` below — see CLAUDE.md "TDZ discipline inside
    // bootFromDb".
    inspector.wireMemoryEvents((req, res) => handleMemoryEvents(req, res, {
      getVerifierConfig: async () => ({
        selfIssuedSigningKey: deriveJwtSigningKey(masterKey.bytes),
        trustedIssuer: await store.getTrustedIssuerConfig(),
      }),
      getCoordinator: () => controllerApi,
    }));

    // MEMORY-INJECTION — POST /v1/identity/list, the resolve half of the flow
    // /v1/memory/events completes. Identical deps to both routes above, and
    // wired ABOVE the empty-DB `if (!row) return` for the same TDZ reason.
    const identityRoutes = createIdentityRoutes({
      getVerifierConfig: async () => ({
        selfIssuedSigningKey: deriveJwtSigningKey(masterKey.bytes),
        trustedIssuer: await store.getTrustedIssuerConfig(),
      }),
      getCoordinator: () => controllerApi,
    });
    inspector.wireIdentityRoutes(identityRoutes);

    // Wire tunnel routes for DB mode — allows inspector UI to configure tunnel
    inspector.wireTunnelRoutes(createTunnelRoutes({
      configStore: store,
      dialTunnel: async (r) => {
        // Update shared references with fresh values from the row
        row = r;
        auth = resolveAuthFromRow(r);
        tunnelDialUrl = r.controllerUrl;
        inspector?.setControllerUrl(r.controllerUrl);
        await connectTunnelDb("inspector-dial");
      },
      cycleTunnel: async (reason) => {
        // Re-read the row from Postgres before redialing — an inspector-
        // triggered cycleTunnel means the DB was just upserted (bearer
        // rotated, URL changed, etc.). Without this refresh, `reconnect`
        // reads the STALE `row`/`auth`/`tunnelDialUrl` from the last dial
        // and sends the OLD bearer on the WS upgrade. Symptom in the
        // wild: credential-rotated cycles present a stale bearer to the
        // controller and get 401'd even though the DB was correctly
        // rewritten with the new value. Regression pinned by
        // tests/inspector/tunnel-routes-cycle-refresh.test.ts.
        const fresh = await store.getController();
        if (fresh) {
          row = fresh;
          auth = resolveAuthFromRow(fresh);
          tunnelDialUrl = fresh.controllerUrl;
          inspector?.setControllerUrl(fresh.controllerUrl);
        }
        await reconnect(reason, { manual: true });
      },
    }));
  }

  // Discover MCPs from two scanners: MCP_BUNDLED_DIR (Twilio-shipped,
  // always on — D1 of CUSTOMER-REPO-CARVE-OUT) and MCP_DROPIN_DIR (customer
  // drop-ins). Bundled entries also exclude their own names from the
  // customer-drop-in scan so a drop-in that happens to share a bundled name
  // doesn't collide.
  const yamlNames = new Set(config.mcp_servers.map((s) => s.name));
  const bundled = discoverBundled({ yamlNames });
  const dropinYamlNames = new Set([...yamlNames, ...bundled.map((b) => b.name)]);
  const dropins = discoverDropins({ yamlNames: dropinYamlNames });
  if (bundled.length > 0) {
    log.info(
      { bundled: bundled.map((b) => b.name) },
      `discovered bundled MCPs from ${envOptional("MCP_BUNDLED_DIR") ?? "default dir"}`,
    );
  }
  if (dropins.length > 0) {
    log.info(
      { dropins: dropins.map((d) => d.name) },
      `discovered drop-in MCPs from ${envOptional("MCP_DROPIN_DIR") ?? "default dir"}`,
    );
  }
  const allSpecs: SupervisedSpec[] = [...config.mcp_servers, ...bundled, ...dropins];

  const dropinSpecsByName = new Map<string, DropinSpec>(dropins.map((spec) => [spec.name, spec]));

  const servers = new Map<string, McpServerConnection>();

  const notifications = new NotificationForwarder(log);

  const supervisor: McpSupervisor = new McpSupervisor({
    log,
    servers,
    // MCP_READINESS_TIMEOUT_MS lets operators raise the port-readiness
    // wait beyond the default 15s on slower hardware or when running
    // many drop-ins whose tsx cold-starts compound. Unset = 15000.
    readyTimeoutMs: envNumber("MCP_READINESS_TIMEOUT_MS", 15000),
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
      // Tap every request/response + notification so the inspector's MCP
      // Status → message-history pane has something to show. Re-`set`s the
      // shared `servers` map entry (the supervisor just stored the raw
      // connection one line earlier) so dispatcher.ts, manifest/build.ts,
      // and the inspector's own tool-runner all read the tapped version.
      const tapped = inspector
        ? wrapWithMessageTap(name, connection, (tap) =>
            inspector.recordMcpMessage(redactTapPayload(tap, config.policy.log_tool_args)))
        : connection;
      notifications.attachToConnection(name, tapped);
      servers.set(name, tapped);
    },
  });
  healthSupervisor = supervisor;
  supervisor.register(allSpecs);

  const mcpConfig = new McpConfigCoordinator({
    send: () => log.warn(`mcp-config send before tunnel bind — dropping frame`),
    supervisor,
    log,
  });

  const approval = new ApprovalCoordinator({
    send: () => log.warn(`approval send before tunnel bind — dropping frame`),
    supervisor,
    log,
    onManifestChange: () => refreshManifestAndPushDelta(),
  });

  const localMcps = new LocalMcpsCoordinator({
    send: () => log.warn(`local-mcps send before tunnel bind — dropping frame`),
    supervisor,
    log,
    yamlNames,
    onApplied: () => refreshManifestAndPushDelta(),
    onMcpAdded: async (name) => {
      const status = supervisor.statusList().find((s) => s.name === name);
      const isCustomerDropin = status?.source === "local";
      if (isCustomerDropin) {
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

  let manifest: ToolManifest = await buildManifest(
    config,
    servers,
    version,
    (name) => supervisor.fetchEnvKeys(name),
    (name) => approval.isApproved(name),
    dropinSpecsByName,
    [...bundled, ...dropinSpecsByName.values()],
  );
  validateManifestSchemas(manifest, config);
  log.info({ tools: countTools(manifest) }, `built manifest`);
  for (const server of manifest.servers) supervisor.setToolsCount(server.name, server.tools.length);
  inspector?.setManifest(manifest);
  inspector?.setMcpStatuses(supervisor.statusList());

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

  // Get controller row from DB
  row = await store.getController();
  if (!row) {
    log.info(`no controller row; waiting for inspector configuration at http://127.0.0.1:${inspectorPort}/`);
    // Empty-DB path — DO NOT construct TunnelClient. Inspector + MCPs stay running.
    return;
  }

  auth = resolveAuthFromRow(row);
  const registrationToken = row.registrationToken ?? undefined;
  const identityStatus = registrationToken
    ? `reconnect (token len=${registrationToken.length})`
    : `first-connect (name="${row.connectorName}")`;
  log.info(
    { name: row.connectorName, environment: row.environment, authToken: auth.status, identity: identityStatus },
    `config loaded`,
  );

  tunnelDialUrl = row.controllerUrl;
  inspector?.setControllerUrl(row.controllerUrl);

  if (inspector) {
    inspector.setIdentity(
      registrationToken
        ? { kind: "bound", tokenLen: registrationToken.length }
        : { kind: "first-connect" },
    );
    inspector.setHeader({
      connectorName: row.connectorName,
      environment: row.environment ?? undefined,
      version,
    });
  }

  await connectTunnelDb("initial");

  // SIGHUP — reload YAML, rebuild manifest, push delta.
  process.on("SIGHUP", () => { void onSighup(); });

  // Graceful shutdown. stopAll() awaits every child's SIGTERM (+ 2s SIGKILL
  // fallback), so a hung child previously left the .then(exit(0)) chain
  // dangling — process would still die via orchestrator SIGKILL, but the
  // exit code became indistinguishable from a genuine crash. try/catch
  // preserves the intended exit code (0 clean / 1 shutdown-error) which
  // Fargate + K8s use to decide retry behaviour.
  //
  // ConfigStore's pg.Pool is drained via store.close() AFTER stopAll so
  // final creds-update writes have a chance to land. A store-close failure
  // is logged but does NOT override the exit code from stopAll — a stuck
  // MCP child is a more actionable orchestrator signal than a leaked DB
  // connection.
  const shutdown = async (signal: string): Promise<void> => {
    shuttingDown = true;
    log.info({ signal }, `shutting down`);
    reconnectCtl.cancel();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (discoveryTimer) clearInterval(discoveryTimer);
    tunnel?.close(`signal:${signal}`);
    // Stop answering probes immediately. An orchestrator draining this task
    // should see the endpoint go away rather than keep getting a 200 from a
    // process that is tearing its children down.
    healthServer?.close();
    let exitCode = 0;
    try {
      await supervisor.stopAll();
    } catch (error) {
      log.error({ err: error }, `stopAll failed during shutdown`);
      exitCode = 1;
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

  // ─── connect / reconnect ────────────────────────────────────────────────
  async function connectTunnelDb(reason: string): Promise<void> {
    if (!row || !auth || !tunnelDialUrl) return;  // defensive — empty-DB path leaves these undefined
    // Always read the CURRENT registration token from the row. The
    // top-level `const registrationToken` is a snapshot from the
    // row-exists boot path; under the empty-DB paste flow it was never
    // initialized, and referencing it inside this closure previously
    // threw TDZ. `row.registrationToken` is authoritative on every dial.
    const currentToken = row.registrationToken ?? undefined;
    inspector?.setState("connecting");
    log.info({ reason, url: tunnelDialUrl }, `tunnel dialing`);
    const pendingTunnel = new TunnelClient(tunnelDialUrl, auth.authToken, row.connectorName, auth.authProvider);
    pendingTunnel.onerror = (error) => log.error({ err: error }, `tunnel error`);
    if (inspector) {
      pendingTunnel.onstate = (tunnelState) => inspector.setState(tunnelState);
      pendingTunnel.ontap = (tap) => inspector.recordTap(tap);
    }
    pendingTunnel.onclose = () => {
      log.info(`tunnel closed`);
      webhooks.onTunnelClose();
      // v1.4: reject every in-flight controller-call immediately — a
      // blocked customer-facing HTTP call should fail fast, not silently
      // resume on the next reconnect — then drop the reference so the
      // loopback route's tunnel_unavailable check sees "no tunnel" rather
      // than a coordinator bound to a dead socket.
      controllerApi?.onTunnelClose();
      controllerApi = undefined;
      notifications.unbind();
      stopTimers();
      if (shuttingDown) return;
      if (!config.policy.reconnect.enabled) return;
      if (reconnectCtl.isRejected()) {
        log.warn(`auto-reconnect suppressed: controller rejected the registration — clear DB registration and click Reconnect`);
        return;
      }
      reconnectCtl.schedule();
    };

    try {
      await pendingTunnel.connect();
    } catch (error) {
      // See env-mode connectTunnel for rationale — recoverable handshake
      // failure, WARN + message only, no stack.
      log.warn(formatHandshakeFailure(error, tunnelDialUrl), `tunnel connect failed — auto-reconnect scheduled`);
      inspector?.setState("closed");
      if (shuttingDown) return;
      if (!config.policy.reconnect.enabled) return;
      if (reconnectCtl.isRejected()) {
        log.warn(`auto-reconnect suppressed: controller rejected the registration — clear DB registration and click Reconnect`);
        return;
      }
      reconnectCtl.schedule();
      return;
    }

    tunnel = pendingTunnel;
    log.info({ url: tunnelDialUrl }, `tunnel connected`);
    inspector?.setHeader({ tunnelOpenSinceAt: new Date().toISOString() });

    const creds = new CredsCoordinator({
      send: (frame) => pendingTunnel.send(frame),
      supervisor,
      log,
    });

    // v1.4 — fresh per dial, same lifetime as `creds` (not `webhooks`): a
    // pending call whose tunnel drops mid-flight should fail fast rather
    // than resume across reconnect. Assigned to the hoisted outer binding
    // so the inspector loopback route (wired below) always reads the live
    // instance.
    controllerApi = new ControllerApiCoordinator({
      send: (frame) => pendingTunnel.send(frame),
      log,
    });

    mcpConfig.bind({
      send: (frame) => pendingTunnel.send(frame),
      requestCreds: (name, mcpId, envKeys) =>
        creds.reload(name, "customer", envKeys, mcpId),
    });

    localMcps.bind({ send: (frame) => pendingTunnel.send(frame) });
    approval.bind({ send: (frame) => pendingTunnel.send(frame) });
    // §9.1 — upstream list_changed re-lists the manifest and pushes a
    // manifest-delta (not a raw mcp-notification). refreshManifestAndPushDelta
    // is a hoisted function declaration in this scope; `void` discards its
    // promise the same way the discovery timer does.
    notifications.bind({ onListChanged: () => void refreshManifestAndPushDelta() });

    const tokenRef = { current: currentToken };
    // Capture row.id into a const so TS narrows across the callback closures.
    const rowId = row.id;
    const baseRouter = createFrameRouter({
      webhooks,
      tokenRef,
      onTokenMinted: (token) => {
        void store.updateRegistrationToken(rowId, token)
          .then(() => inspector?.publishTunnelConfigChanged())
          .catch(() => {});
      },
      onTokenCleared: () => {
        void store.clearRegistrationToken(rowId)
          .then(() => inspector?.publishTunnelConfigChanged())
          .catch(() => {});
      },
      inspector,
      reconnect: reconnectCtl,
      log,
      connectorName: row.connectorName,
    });
    pendingTunnel.onframe = (frame) => {
      if (frame.type === "creds-response") { creds.handleResponse(frame); return; }
      if (frame.type === "creds-update") { creds.handleUpdate(frame); return; }
      if (frame.type === "mcp-config-snapshot") { void mcpConfig.handleSnapshot(frame); return; }
      if (frame.type === "mcp-config-delta") { void mcpConfig.handleDelta(frame); return; }
      if (frame.type === "local-mcps-rescan") { void localMcps.rescanFromController(); return; }
      if (frame.type === "mcp-enable") { void approval.handleEnable(frame); return; }
      if (frame.type === "mcp-disable") { void approval.handleDisable(frame); return; }
      if (frame.type === "controller-call-response") { controllerApi?.handleResponse(frame); return; }
      if (frame.type === "register-ack" && !frame.error) {
        // frame-router persists the token via onTokenMinted (wired above).
        baseRouter(frame);
        void requestCredsForAllMcps(creds, mcpConfig);
        mcpConfig.armSnapshotWait();
        void announceDiscoveredDropins();
        return;
      }
      // Errors + everything else flow through the base router. The
      // unknown_registration_token path clears the token via onTokenCleared.
      baseRouter(frame);
    };

    if (inspector) {
      inspector.mcpActions = {
        reloadCreds: async (name: string) => {
          const reqInfo = buildCredsRequestForMcp(name, mcpConfig);
          if (!reqInfo) throw new Error(`unknown MCP "${name}"`);
          await creds.reload(reqInfo.mcp, reqInfo.author, reqInfo.envKeys, reqInfo.mcpId);
        },
        restart: async (name: string) => {
          inspector.clearMcpMessages(name);
          const ok = await supervisor.restart(name, "manual");
          if (!ok) throw new Error(`unknown MCP "${name}"`);
        },
        // F7: inspector's authorizeWebhookMcp calls this to verify a
        // bearer token on /internal/webhook/stream + /revoke identifies
        // the caller as owner of the requested MCP.
        resolveMcpByWebhookToken: (token: string) => supervisor.resolveMcpByWebhookToken(token),
        rescanLocal: async () => {
          const ack = await localMcps.rescan();
          return {
            added: ack.added,
            removed: ack.removed,
            unchanged: ack.unchanged,
            errors: ack.errors,
          };
        },
        applySessionCreds: async (name: string, env: Record<string, string>) => {
          const result = await supervisor.applySessionEnv(name, env, { mode: "merge" });
          if (!result.applied) throw new Error(`unknown MCP "${name}"`);
          return { expiresAt: result.expiresAt };
        },
        clearSessionCreds: async (name: string) => {
          await supervisor.clearSessionEnv(name, "session-creds-cleared-by-operator");
        },
        fetchEnvKeys: async (name: string) => {
          return supervisor.fetchEnvKeys(name);
        },
        // v1.4: code-trust gate for the /internal/controller-api/call
        // loopback route — is `name` Twilio-authored bundled code (never a
        // customer drop-in)?
        isAuthorTwilio: (name: string) => supervisor.isAuthorTwilio(name),
        // v1.4: invoke a named controller-side action on behalf of `mcp`.
        // Caller (the inspector route) has already verified `mcp` via
        // resolveMcpByWebhookToken + isAuthorTwilio before reaching here.
        // Rejects with a typed { code, message } error — "tunnel_unavailable"
        // when no tunnel is connected, otherwise whatever the coordinator/
        // controller returned (including "timeout").
        callControllerApi: async (mcp: string, action: string, params: unknown, timeoutMs?: number) => {
          if (!controllerApi) {
            throw Object.assign(new Error("no tunnel connected"), { code: "tunnel_unavailable" });
          }
          const mcpId = mcpConfig.mcpIdFor(mcp);
          return controllerApi.call(mcp, mcpId, action, params, timeoutMs);
        },
      };
    }

    pendingTunnel.send({
      type: "register",
      manifest,
      name: row.connectorName,
      ...(currentToken ? { registrationToken: currentToken } : {}),
    });
    log.info(`register frame sent`);

    const dispatcherLog = createLogger("dispatcher");
    new Dispatcher({
      config,
      servers,
      getManifest: () => manifest,
      tunnel: pendingTunnel,
      log: dispatcherLog.info.bind(dispatcherLog),
      isRestarting: (name) => supervisor.isRestarting(name),
    }).attach();

    startTimers();
  }

  // Symmetric with buildManifest's additionalSpecs threading — bundled +
  // dropin discovered specs must resolve so agentic-memory returns
  // author=twilio, matching what the manifest reports. Otherwise the
  // controller returns author_mismatch on creds-request.
  function lookupSpec(name: string): McpServerSpec | undefined {
    return (
      config.mcp_servers.find((s) => s.name === name) ??
      bundled.find((s) => s.name === name) ??
      [...dropinSpecsByName.values()].find((s) => s.name === name)
    );
  }

  function buildCredsRequestForMcp(
    name: string,
    mcpConfig?: McpConfigCoordinator,
  ): { mcp: string; mcpId?: string; author: string; envKeys: string[] } | undefined {
    const spec = lookupSpec(name);
    const author = spec ? authorOf(spec) : "customer";
    if (!servers.has(name)) return undefined;
    const mcpId = mcpConfig?.mcpIdFor(name);
    return { mcp: name, ...(mcpId ? { mcpId } : {}), author, envKeys: [] };
  }

  async function requestCredsForAllMcps(
    creds: CredsCoordinator,
    mcpConfig: McpConfigCoordinator,
  ): Promise<void> {
    const requests = await Promise.all(
      [...servers.keys()].map(async (name) => {
        const spec = lookupSpec(name);
        const author = spec ? authorOf(spec) : "customer";
        const envKeys = await supervisor.fetchEnvKeys(name);
        const mcpId = mcpConfig.mcpIdFor(name);
        return { mcp: name, ...(mcpId ? { mcpId } : {}), author, envKeys };
      }),
    );
    log.info({ count: requests.length }, `sending creds-request frames`);
    await creds.requestAllAtBoot(requests);
    inspector?.setMcpStatuses(supervisor.statusList());
  }

  async function announceDiscoveredDropins(): Promise<void> {
    const result = await announceDropinsLoop({
      dropinNames: [...dropinSpecsByName.keys()],
      approval,
      supervisor,
      servers,
      log,
    });
    if (result.totalDropins > 0) {
      log.info(result, `mcp-discovered fan-out complete`);
    }
  }

  async function reconnect(reason: string, opts?: { manual?: boolean }): Promise<void> {
    if (reconnecting && !opts?.manual) return;
    if (reconnecting && opts?.manual) {
      log.info({ reason }, `manual reconnect overriding in-flight attempt`);
    }
    reconnecting = true;
    try {
      reconnectCtl.cancel();
      reconnectCtl.clearRejected();
      log.info({ reason }, `reconnect requested`);
      stopTimers();
      tunnel?.close("reconnect");
      tunnel = undefined;

      // Refresh row from DB on reconnect (in case credentials were updated)
      row = await store.getController();
      if (!row) {
        log.warn(`reconnect: no controller row in DB — cannot dial`);
        inspector?.setState("closed");
        reconnecting = false;
        return;
      }

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

      manifest = await buildManifest(
        config,
        servers,
        version,
        (name) => supervisor.fetchEnvKeys(name),
        (name) => approval.isApproved(name),
        dropinSpecsByName,
        [...bundled, ...dropinSpecsByName.values()],
      );
      inspector?.setManifest(manifest);

      await connectTunnelDb("reconnect");
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
        (name) => supervisor.fetchEnvKeys(name),
        (name) => approval.isApproved(name),
        dropinSpecsByName,
        [...bundled, ...dropinSpecsByName.values()],
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
  return true;
}

function sameStringMap(live?: Record<string, string>, fresh?: Record<string, string>): boolean {
  const liveKeys = live ? Object.keys(live) : [];
  const freshKeys = fresh ? Object.keys(fresh) : [];
  if (liveKeys.length !== freshKeys.length) return false;
  return liveKeys.every((key) => live?.[key] === fresh?.[key]);
}

