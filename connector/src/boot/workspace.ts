// One tunnel workspace (MULTI-PLATFORM-MCP Phase 6, §5.1–§5.4).
//
// A workspace is everything that used to be "the" tunnel in bootFromDb: one
// controller entry's TunnelClient, ReconnectController, timers, coordinators,
// WebhookRegistry, Dispatcher and McpSupervisor with its own children. The
// process holds one per `controllers[]` entry, keyed by the entry's id, and
// two workspaces share NOTHING mutable — that is the point of D14. Each
// coordinator keeps today's keys (MCP name, request id), because there is no
// (controllerId, mcp) key anywhere for a lookup to get wrong.
//
// What IS shared, read-only, comes in through `WorkspaceShared`: the parsed
// yaml config, the drop-in/bundled scan, the config store, the inspector, the
// port allocator. Specs from the scan are CLONED per workspace on the way in:
// the supervisor mutates a spec at spawn (`endpoint`, `__port`), so a shared
// spec object would let one workspace's child overwrite another's port.
//
// The pre-Phase-6 TDZ discipline (tests/boot/lifecycle-tdz.test.ts) existed
// because the empty-store boot path returned early while closures wired above
// it could still fire. A workspace is constructed only once its controller
// entry exists, so that whole failure class is gone: every binding below is a
// class field initialised in the constructor, before any closure can run.

import { authorOf, type ConnectorConfig, type McpServerSpec } from "../config.js";
import { PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION, FRAME_SCHEMA_MISMATCH_CLOSE, parseVersion, isSupportedPeer } from "@gtmi/toolproxy-protocol";
import { negotiateNaming } from "../tunnel/naming.js";
import type { McpServerConnection } from "../servers/index.js";
import { wrapWithMessageTap } from "../servers/message-tap.js";
import { redactTapPayload } from "../policy/redact.js";
import { buildManifest } from "../manifest/build.js";
import { diffManifest, withServerLifecycle, isEmptyDelta } from "../manifest/diff.js";
import { validateManifestSchemas } from "../manifest/validate.js";
import { TunnelClient } from "../tunnel/client.js";
import { formatHandshakeFailure } from "../tunnel/format-log.js";
import { Dispatcher } from "../dispatcher.js";
import type { ToolManifest } from "../tunnel/frames.js";
import type { Inspector, WorkspaceView } from "../inspector/server.js";
import { createLogger, type Logger } from "../logger.js";
import { WebhookRegistry } from "../tunnel/webhook-registry.js";
import { ReconnectController, isStickyClose } from "../tunnel/reconnect.js";
import { createFrameRouter } from "../tunnel/frame-router.js";
import { CredsCoordinator } from "../tunnel/creds-coordinator.js";
import { ControllerApiCoordinator } from "../tunnel/controller-api-coordinator.js";
import { McpConfigCoordinator } from "../tunnel/mcp-config-coordinator.js";
import { LocalMcpsCoordinator } from "../tunnel/local-mcps-coordinator.js";
import { ApprovalCoordinator } from "../tunnel/approval-coordinator.js";
import { NotificationForwarder } from "../tunnel/notification-forwarder.js";
import { McpSupervisor, type McpStatus, type SupervisedSpec } from "../mcp-supervisor.js";
import { discoverDropins, type DropinSpec } from "../dropin.js";
import type { PortAllocator } from "../port-allocator.js";
import { resolveAuthFromRow, type AuthResolution } from "./auth.js";
import { announceDiscoveredDropins as announceDropinsLoop, describeGated, type GatedDescriptor } from "./announce-dropins.js";
import type { ConfigStore, ControllerRow } from "../config-store/index.js";
import { ensureMcpStateDir } from "./workspace-storage.js";

// The highest tunnel-protocol major this connector will SPEAK. A session's
// major is min(this, the controller's advertised max), decided at register-ack.
//
// 2 since the 2.x cutover (MULTI-PLATFORM-MCP Phase 2b step 4), made after the
// live 1.x ⇄ 2.x matrix passed, including a mixed fleet of both on one org. A
// 1.x controller still negotiates this down to 1. Deliberately a code constant,
// not an env var: switching what every connector sends on the wire is a
// release decision reviewed in a commit, not a knob an operator flips.
export const SPEAK_MAJOR: 1 | 2 = 2;
// What `register.tunnelProtocol` carries. One value for the frame and the
// rejection message, so the two can never name different versions.
export const OUR_TUNNEL_PROTOCOL = SPEAK_MAJOR >= 2 ? LATEST_PROTOCOL_VERSION : PROTOCOL_VERSION;

/** Process-level services every workspace reads. Nothing here is per-tunnel. */
export interface WorkspaceShared {
  /** Parsed yaml. Its `policy` is reloaded in place on SIGHUP / reconnect. */
  config: ConnectorConfig;
  version: string;
  store: ConfigStore;
  inspector: Inspector | undefined;
  ports: PortAllocator;
  readyTimeoutMs: number;
  /** Boot-time scan results. Cloned per workspace — see the header. */
  bundled: readonly DropinSpec[];
  dropins: readonly DropinSpec[];
  yamlNames: Set<string>;
  /** Re-read connector.yaml for a reconnect; returns the policy-only reload outcome. */
  reloadConfig: () => void;
}

// Deep-copy a spec so this workspace's supervisor can mutate it at spawn.
// Specs are plain JSON (strings, arrays, string maps, boolean markers).
function cloneSpec<T extends SupervisedSpec>(spec: T): T {
  return structuredClone(spec);
}

export class TunnelWorkspace {
  readonly id: string;
  private row: ControllerRow;
  private auth: AuthResolution;

  private readonly log: Logger;
  private readonly view: WorkspaceView | undefined;

  private readonly servers = new Map<string, McpServerConnection>();
  private readonly notifications: NotificationForwarder;
  readonly supervisor: McpSupervisor;
  private readonly webhooks: WebhookRegistry;
  private readonly mcpConfig: McpConfigCoordinator;
  private readonly approval: ApprovalCoordinator;
  private readonly localMcps: LocalMcpsCoordinator;
  private readonly reconnectCtl: ReconnectController;

  private readonly bundled: DropinSpec[];
  private readonly dropinSpecsByName: Map<string, DropinSpec>;
  // Phase 2c (D3): every MCP this connector runs itself is GATED — shipped
  // available but inactive, enabled per shim by the controller operator.
  // Bundled, customer drop-in and yaml alike; only controller-pushed (Type 2)
  // MCPs stay outside, because pushing one is already the operator's consent.
  // This map is the one answer to "is it gated, and how is it described on
  // mcp-discovered". dropinSpecsByName keeps its separate jobs (author
  // classification in buildManifest, lookupSpec) and is NOT the gate.
  private readonly gatedSpecsByName = new Map<string, GatedDescriptor>();

  private tunnel: TunnelClient | undefined;
  // v1.4 — fresh per dial (see connect()); undefined between tunnels so the
  // controller-call routes answer tunnel_unavailable rather than writing to a
  // dead socket.
  private controllerApi: ControllerApiCoordinator | undefined;
  private manifest: ToolManifest | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private discoveryTimer: NodeJS.Timeout | undefined;
  private reconnecting = false;
  private stopped = false;

  constructor(row: ControllerRow, private readonly shared: WorkspaceShared) {
    this.id = row.id;
    this.row = row;
    this.auth = resolveAuthFromRow(row);
    // Every log line a workspace emits carries its entry id, so two tenants'
    // tunnels are distinguishable in one process's log stream.
    this.log = createLogger("connector").child({ ws: row.id });
    const { config, inspector } = shared;

    this.view = inspector?.addWorkspace(row.id, { controllerUrl: row.controllerUrl, state: "connecting" });

    this.bundled = shared.bundled.map(cloneSpec);
    const dropins = shared.dropins.map(cloneSpec);
    const yamlSpecs = config.mcp_servers.map(cloneSpec);
    this.dropinSpecsByName = new Map(dropins.map((spec) => [spec.name, spec]));
    for (const spec of this.bundled) this.gatedSpecsByName.set(spec.name, describeGated(spec, "bundled"));
    for (const spec of dropins) this.gatedSpecsByName.set(spec.name, describeGated(spec, "dropin"));
    for (const spec of yamlSpecs) this.gatedSpecsByName.set(spec.name, describeGated(spec, "yaml"));

    this.webhooks = new WebhookRegistry({
      sendFrame: (frame) => {
        if (this.tunnel?.state !== "open") return false;
        this.tunnel.send(frame);
        return true;
      },
      onDispatched: () => this.view?.publishWebhookSnapshot(),
      isMcpEnabled: (mcp) => this.isMcpEnabled(mcp),
      log: this.log,
    });
    if (this.view) this.view.setWebhooks(this.webhooks);

    this.notifications = new NotificationForwarder(this.log);

    this.supervisor = new McpSupervisor({
      log: this.log,
      servers: this.servers,
      ports: shared.ports,
      readyTimeoutMs: shared.readyTimeoutMs,
      // The child's write contract: one directory per (workspace, MCP).
      stateDirFor: (mcp) => ensureMcpStateDir(row.id, mcp),
      onSpawn: ({ name, envSources }) => {
        const dirEnvKeys = Object.entries(envSources).filter(([, src]) => src === "dir/.env").map(([k]) => k);
        const controllerEnvKeys = Object.entries(envSources).filter(([, src]) => src === "controller").map(([k]) => k);
        this.log.info({ name, controller: controllerEnvKeys, dirDotEnv: dirEnvKeys }, `mcp spawn env-sources`);
      },
      onRestart: async (name) => {
        this.log.info({ name }, `mcp restart complete — refreshing manifest`);
        await this.refreshManifestAndPushDelta();
      },
      onConnect: (name, connection) => {
        // Tap every request/response + notification so the inspector's MCP
        // Status → message-history pane has something to show. Re-`set`s the
        // shared `servers` map entry (the supervisor just stored the raw
        // connection one line earlier) so the dispatcher, manifest builder and
        // the inspector's own tool-runner all read the tapped version.
        const view = this.view;
        const tapped = view
          ? wrapWithMessageTap(name, connection, (tap) =>
              view.recordMcpMessage(redactTapPayload(tap, config.policy.log_tool_args)))
          : connection;
        this.notifications.attachToConnection(name, tapped);
        this.servers.set(name, tapped);
      },
    });
    this.supervisor.register([...yamlSpecs, ...this.bundled, ...dropins]);

    this.mcpConfig = new McpConfigCoordinator({
      send: () => this.log.warn(`mcp-config send before tunnel bind — dropping frame`),
      supervisor: this.supervisor,
      log: this.log,
    });

    this.approval = new ApprovalCoordinator({
      send: () => this.log.warn(`approval send before tunnel bind — dropping frame`),
      supervisor: this.supervisor,
      log: this.log,
      onManifestChange: () => this.refreshManifestAndPushDelta(),
    });

    this.localMcps = new LocalMcpsCoordinator({
      send: () => this.log.warn(`local-mcps send before tunnel bind — dropping frame`),
      supervisor: this.supervisor,
      log: this.log,
      yamlNames: shared.yamlNames,
      onApplied: () => this.refreshManifestAndPushDelta(),
      onMcpAdded: (name) => this.onMcpAdded(name),
    });

    this.reconnectCtl = new ReconnectController({
      getPolicy: () => config.policy.reconnect,
      onFire: () => { void this.reconnect(`auto attempt ${this.reconnectCtl.attemptCount()}`); },
      onReconnecting: (info) => this.view?.setReconnecting(info),
      log: this.log,
    });

    this.wireView();
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────

  /** Spawn this workspace's children, build the manifest, dial the tunnel. */
  async start(): Promise<void> {
    const { config } = this.shared;
    this.log.info(`connecting to ${this.supervisor.statusList().length} local MCP server(s)`);
    await this.supervisor.startAll();
    this.log.info({ servers: [...this.servers.keys()] }, `connected to local servers`);
    this.manifest = await this.build();
    validateManifestSchemas(this.manifest, config);
    for (const server of this.manifest.servers) this.supervisor.setToolsCount(server.name, server.tools.length);
    this.view?.setManifest(this.manifest);
    this.publishStatuses();

    const registrationToken = this.row.registrationToken ?? undefined;
    this.log.info(
      {
        name: this.row.connectorName,
        environment: this.row.environment,
        authToken: this.auth.status,
        identity: registrationToken
          ? `reconnect (token len=${registrationToken.length})`
          : `first-connect (name="${this.row.connectorName}")`,
      },
      `config loaded`,
    );
    this.view?.setIdentity(registrationToken ? { kind: "bound", tokenLen: registrationToken.length } : { kind: "first-connect" });
    this.view?.setHeader({
      connectorName: this.row.connectorName,
      environment: this.row.environment ?? undefined,
      version: this.shared.version,
    });

    if (this.stopped) return;
    await this.connect("initial");
  }

  /**
   * Close the tunnel and stop every child. Used by SIGTERM (all workspaces, in
   * parallel) and by removing a controller entry (that workspace only). Never
   * throws for a child — supervisor.stopAll has the 2s SIGKILL fallback.
   */
  async stop(reason: string): Promise<void> {
    this.stopped = true;
    this.reconnectCtl.cancel();
    this.stopTimers();
    this.tunnel?.close(reason);
    this.tunnel = undefined;
    await this.supervisor.stopAll();
  }

  /** Remove this workspace's inspector view. Call after stop() on removal. */
  detachView(): void {
    this.shared.inspector?.removeWorkspace(this.id);
  }

  /**
   * Re-read this entry from the store (the operator just rotated a secret,
   * changed the URL, or forced re-registration) and redial.
   */
  async cycle(reason: string): Promise<void> {
    const fresh = await this.shared.store.getControllerById(this.id);
    if (fresh) this.adoptRow(fresh);
    await this.reconnect(reason, { manual: true });
  }

  /** Children this workspace was asked to run that are still coming up. */
  childrenPending(): string[] {
    return this.supervisor.statusList()
      .filter((st) => st.process === "restarting" || st.process === "stopped")
      .map((st) => st.name);
  }

  isTunnelOpen(): boolean {
    return this.tunnel?.state === "open";
  }

  /** For the machine API: this workspace's live coordinator, or undefined between tunnels. */
  controllerApiCoordinator(): ControllerApiCoordinator | undefined {
    return this.controllerApi;
  }

  /** SIGHUP: the shared config's policy was reloaded; push whatever changed. */
  async onConfigReloaded(): Promise<void> {
    await this.refreshManifestAndPushDelta();
  }

  statuses(): McpStatus[] {
    return this.supervisor.statusList();
  }

  // ─── connect / reconnect ────────────────────────────────────────────────

  private adoptRow(row: ControllerRow): void {
    this.row = row;
    this.auth = resolveAuthFromRow(row);
    this.view?.setControllerUrl(row.controllerUrl);
  }

  private async connect(reason: string): Promise<void> {
    if (this.stopped) return;
    const { config, store, inspector } = this.shared;
    const row = this.row;
    const auth = this.auth;
    const dialUrl = row.controllerUrl;
    // Always read the CURRENT registration token from the row — it is
    // authoritative on every dial.
    const currentToken = row.registrationToken ?? undefined;
    this.view?.setState("connecting");
    this.log.info({ reason, url: dialUrl }, `tunnel dialing`);
    const pendingTunnel = new TunnelClient(dialUrl, auth.authToken, row.connectorName, auth.authProvider);
    pendingTunnel.onerror = (error) => this.log.error({ err: error }, `tunnel error`);
    // Log-only validation against @gtmi/toolproxy-protocol (Phase 1). The
    // frame is still handled; this just makes schema drift visible. Paths
    // only — never field values.
    pendingTunnel.onschemaviolation = (info) =>
      this.log.warn(info, `inbound frame does not match the tunnel protocol schema (log-only, frame still handled)`);
    const view = this.view;
    if (view) {
      pendingTunnel.onstate = (tunnelState) => view.setState(tunnelState);
      pendingTunnel.ontap = (tap) => view.recordTap(tap);
    }
    pendingTunnel.onclose = (info) => {
      this.log.info({ code: info.code, reason: info.reason }, `tunnel closed`);
      // A controller that ENFORCES schema validation closes with 4422 when it
      // refuses a frame. Sticky: reconnecting would re-send the same frame and
      // be refused again, in a storm. Every OTHER close code keeps the existing
      // rules — notably 4401 unknown_registration_token, which must stay
      // self-healing (it is the register-ack path, not this one).
      if (isStickyClose(info.code, FRAME_SCHEMA_MISMATCH_CLOSE)) {
        this.reconnectCtl.markRejected();
        this.log.error(
          { code: info.code, reason: info.reason },
          `controller refused a frame that does not match its tunnel-protocol schema — not reconnecting; this is a version mismatch between connector and controller`,
        );
      }
      this.webhooks.onTunnelClose();
      // v1.4: reject every in-flight controller-call immediately — a blocked
      // customer-facing HTTP call should fail fast, not silently resume on the
      // next reconnect — then drop the reference so the loopback route's
      // tunnel_unavailable check sees "no tunnel" rather than a coordinator
      // bound to a dead socket.
      this.controllerApi?.onTunnelClose();
      this.controllerApi = undefined;
      this.notifications.unbind();
      this.stopTimers();
      if (this.stopped) return;
      this.scheduleReconnectUnlessRejected();
    };

    try {
      await pendingTunnel.connect();
    } catch (error) {
      // Recoverable handshake failure — WARN + message only, no stack.
      this.log.warn(formatHandshakeFailure(error, dialUrl), `tunnel connect failed — auto-reconnect scheduled`);
      this.view?.setState("closed");
      if (this.stopped) return;
      this.scheduleReconnectUnlessRejected();
      return;
    }
    if (this.stopped) { pendingTunnel.close("stopped"); return; }

    this.tunnel = pendingTunnel;
    this.log.info({ url: dialUrl }, `tunnel connected`);
    this.view?.setHeader({ tunnelOpenSinceAt: new Date().toISOString() });

    // Re-built per tunnel: the pending map is IPC, and a reply from a stale
    // tunnel landing on a fresh one would be wrong.
    const creds = new CredsCoordinator({ send: (frame) => pendingTunnel.send(frame), supervisor: this.supervisor, log: this.log });
    // v1.4 — fresh per dial, same lifetime as `creds` (not `webhooks`): a
    // pending call whose tunnel drops mid-flight should fail fast rather than
    // resume across reconnect.
    this.controllerApi = new ControllerApiCoordinator({ send: (frame) => pendingTunnel.send(frame), log: this.log });

    this.mcpConfig.bind({
      send: (frame) => pendingTunnel.send(frame),
      requestCreds: (name, mcpId, envKeys) => creds.reload(name, "customer", envKeys, mcpId),
    });
    this.localMcps.bind({ send: (frame) => pendingTunnel.send(frame) });
    this.approval.bind({ send: (frame) => pendingTunnel.send(frame) });
    // §9.1 — upstream list_changed re-lists the manifest and pushes a
    // manifest-delta (not a raw mcp-notification).
    this.notifications.bind({ onListChanged: () => void this.refreshManifestAndPushDelta() });

    const tokenRef = { current: currentToken };
    const rowId = row.id;
    // One shimId per process, carried by every workspace's register (D13: the
    // platform sees N ordinary tunnels and never learns they share a shim).
    const shimId = store.getShimId();

    const baseRouter = createFrameRouter({
      webhooks: this.webhooks,
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
      onPeerProtocol: (range) => {
        // Parse against the controller's newest minor: a newer minor of our
        // major is tolerated (unknown fields stripped), anything else strict.
        const peer = parseVersion(range.max);
        if (peer) pendingTunnel.peerProtocol = peer;
        if (peer && !isSupportedPeer(peer)) {
          this.log.warn({ ours: PROTOCOL_VERSION, theirs: range }, `controller tunnel-protocol range is outside every major this connector can parse`);
        }
        // Phase 2b — the session's major is min(our ceiling, their max). Only
        // when BOTH are 2 does the session switch to qualified names; a 1.x
        // controller (or a ceiling of 1) keeps the bare form. Decided once,
        // here, because the register frame had to be sent before we knew.
        pendingTunnel.wireNaming = negotiateNaming(SPEAK_MAJOR, peer, shimId);
        if (pendingTunnel.wireNaming.major >= 2) {
          this.log.info({ shimId, theirs: range }, `tunnel protocol 2.x negotiated — tool names are qualified`);
        }
      },
      inspector: view,
      reconnect: this.reconnectCtl,
      log: this.log,
      connectorName: row.connectorName,
      ourTunnelProtocol: OUR_TUNNEL_PROTOCOL,
    });
    pendingTunnel.onframe = (frame) => {
      if (frame.type === "creds-response") { creds.handleResponse(frame); return; }
      if (frame.type === "creds-update") { creds.handleUpdate(frame); return; }
      if (frame.type === "mcp-config-snapshot") { void this.mcpConfig.handleSnapshot(frame); return; }
      if (frame.type === "mcp-config-delta") { void this.mcpConfig.handleDelta(frame); return; }
      if (frame.type === "local-mcps-rescan") { void this.localMcps.rescanFromController(); return; }
      if (frame.type === "mcp-enable") { void this.approval.handleEnable(frame); return; }
      if (frame.type === "mcp-disable") { void this.approval.handleDisable(frame); return; }
      if (frame.type === "controller-call-response") { this.controllerApi?.handleResponse(frame); return; }
      if (frame.type === "register-ack" && !frame.error) {
        // frame-router persists the token via onTokenMinted (wired above).
        baseRouter(frame);
        void this.requestCredsForAllMcps(creds);
        this.mcpConfig.armSnapshotWait();
        void this.announceDiscovered();
        return;
      }
      // Errors + everything else flow through the base router. The
      // unknown_registration_token path clears the token via onTokenCleared.
      baseRouter(frame);
    };

    if (view) view.mcpActions = this.buildMcpActions(creds);

    pendingTunnel.send({
      type: "register",
      manifest: this.manifest!,
      name: row.connectorName,
      // Advertise what we can SPEAK. shimId goes out only when we speak 2.x;
      // 1.0.1 controllers tolerate it, but a 1.0.0 controller's strict parse
      // would not, so a 1.x-only connector never sends it.
      tunnelProtocol: OUR_TUNNEL_PROTOCOL,
      ...(SPEAK_MAJOR >= 2 ? { shimId } : {}),
      ...(currentToken ? { registrationToken: currentToken } : {}),
    });
    this.log.info(`register frame sent`);

    const dispatcherLog = createLogger("dispatcher").child({ ws: this.id });
    new Dispatcher({
      config,
      servers: this.servers,
      getManifest: () => this.manifest!,
      tunnel: pendingTunnel,
      log: dispatcherLog.info.bind(dispatcherLog),
      isRestarting: (name) => this.supervisor.isRestarting(name),
      isServerEnabled: (name) => this.isMcpEnabled(name),
      // Read on every call: register-ack may upgrade it to qualified naming
      // after the dispatcher already exists.
      get naming() { return pendingTunnel.wireNaming; },
    }).attach();

    this.startTimers();
  }

  private scheduleReconnectUnlessRejected(): void {
    if (!this.shared.config.policy.reconnect.enabled) return;
    if (this.reconnectCtl.isRejected()) {
      this.log.warn(`auto-reconnect suppressed: controller rejected the registration — clear the registration and click Reconnect`);
      return;
    }
    this.reconnectCtl.schedule();
  }

  async reconnect(reason: string, opts?: { manual?: boolean }): Promise<void> {
    if (this.stopped) return;
    if (this.reconnecting && !opts?.manual) return;
    if (this.reconnecting && opts?.manual) {
      this.log.info({ reason }, `manual reconnect overriding in-flight attempt`);
    }
    this.reconnecting = true;
    try {
      this.reconnectCtl.cancel();
      this.reconnectCtl.clearRejected();
      this.log.info({ reason }, `reconnect requested`);
      this.stopTimers();
      this.tunnel?.close("reconnect");
      this.tunnel = undefined;

      // Refresh the entry (credentials may have been rotated).
      const fresh = await this.shared.store.getControllerById(this.id);
      if (!fresh) {
        this.log.warn(`reconnect: controller entry is gone — cannot dial`);
        this.view?.setState("closed");
        return;
      }
      this.adoptRow(fresh);
      this.shared.reloadConfig();

      this.manifest = await this.build();
      this.view?.setManifest(this.manifest);
      await this.connect("reconnect");
    } finally {
      this.reconnecting = false;
    }
  }

  // ─── manifest ───────────────────────────────────────────────────────────

  private build(): Promise<ToolManifest> {
    return buildManifest(
      this.shared.config,
      this.servers,
      this.shared.version,
      (name) => this.supervisor.fetchEnvKeys(name),
      (name) => this.approval.isApproved(name),
      this.gatedSpecsByName,
      [...this.bundled, ...this.dropinSpecsByName.values()],
    );
  }

  private async refreshManifestAndPushDelta(): Promise<void> {
    if (!this.manifest) return; // start() has not built the first one yet
    try {
      const nextManifest = await this.build();
      // Server lifecycle (addedServers/removedServers) rides only on a 2.x
      // session; a 1.x controller's strict parse would reject it.
      const delta = withServerLifecycle(
        diffManifest(this.manifest, nextManifest),
        this.manifest,
        nextManifest,
        this.tunnel?.wireNaming.major ?? 1,
      );
      this.manifest = nextManifest;
      this.view?.setManifest(nextManifest);
      for (const server of nextManifest.servers) this.supervisor.setToolsCount(server.name, server.tools.length);
      this.publishStatuses();
      if (!isEmptyDelta(delta)) {
        this.tunnel?.send({ type: "manifest-delta", delta });
        this.log.info(
          { added: delta.added.length, removed: delta.removed.length, changed: delta.changed.length },
          `pushed manifest-delta`,
        );
      }
    } catch (error) {
      this.log.error({ err: error as Error }, `discovery refresh failed`);
    }
  }

  private startTimers(): void {
    if (this.heartbeatTimer || this.discoveryTimer) return;
    const { policy } = this.shared.config;
    this.heartbeatTimer = setInterval(() => {
      this.tunnel?.send({ type: "heartbeat", ts: Date.now() });
    }, policy.heartbeat_interval_ms);
    this.discoveryTimer = setInterval(() => {
      void this.refreshManifestAndPushDelta();
    }, policy.discovery_interval_ms);
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
    if (this.discoveryTimer) { clearInterval(this.discoveryTimer); this.discoveryTimer = undefined; }
  }

  private publishStatuses(): void {
    this.view?.setMcpStatuses(this.supervisor.statusList());
  }

  // ─── gate, creds, discovery ─────────────────────────────────────────────

  // The approval gate, one predicate for every entry point: tunnel dispatch,
  // controller-call, webhook delivery and the inspector's tool runner
  // (buildManifest applies the same rule through isApproved +
  // gatedSpecsByName).
  isMcpEnabled(name: string): boolean {
    return this.approval.isEnabled(name, (n) => this.gatedSpecsByName.has(n));
  }

  // Symmetric with buildManifest's additionalSpecs threading — bundled +
  // dropin discovered specs must resolve so agentic-memory returns
  // author=twilio, matching what the manifest reports. Otherwise the
  // controller returns author_mismatch on creds-request.
  private lookupSpec(name: string): McpServerSpec | undefined {
    return (
      this.shared.config.mcp_servers.find((s) => s.name === name) ??
      this.bundled.find((s) => s.name === name) ??
      this.dropinSpecsByName.get(name)
    );
  }

  private credsRequestFor(name: string): { mcp: string; mcpId?: string; author: string; envKeys: string[] } | undefined {
    const spec = this.lookupSpec(name);
    const author = spec ? authorOf(spec) : "customer";
    if (!this.servers.has(name)) return undefined;
    const mcpId = this.mcpConfig.mcpIdFor(name);
    return { mcp: name, ...(mcpId ? { mcpId } : {}), author, envKeys: [] };
  }

  private async requestCredsForAllMcps(creds: CredsCoordinator): Promise<void> {
    const requests = await Promise.all(
      [...this.servers.keys()].map(async (name) => {
        const spec = this.lookupSpec(name);
        const author = spec ? authorOf(spec) : "customer";
        const envKeys = await this.supervisor.fetchEnvKeys(name);
        const mcpId = this.mcpConfig.mcpIdFor(name);
        return { mcp: name, ...(mcpId ? { mcpId } : {}), author, envKeys };
      }),
    );
    this.log.info({ count: requests.length }, `sending creds-request frames`);
    await creds.requestAllAtBoot(requests);
    this.publishStatuses();
  }

  private async announceDiscovered(): Promise<void> {
    const result = await announceDropinsLoop({
      gated: [...this.gatedSpecsByName.values()],
      approval: this.approval,
      supervisor: this.supervisor,
      servers: this.servers,
      log: this.log,
    });
    if (result.totalDropins > 0) this.log.info(result, `mcp-discovered fan-out complete`);
  }

  private async onMcpAdded(name: string): Promise<void> {
    const status = this.supervisor.statusList().find((s) => s.name === name);
    // Rescan only ever adds customer drop-ins (it scans MCP_DROPIN_DIR).
    // `source === "local"` is the supervisor's word for "scanned folder".
    if (status?.source === "local") {
      for (const spec of discoverDropins({ yamlNames: this.shared.yamlNames })) {
        if (!this.dropinSpecsByName.has(spec.name)) this.dropinSpecsByName.set(spec.name, spec);
        this.gatedSpecsByName.set(spec.name, describeGated(spec, "dropin"));
      }
      const gated = this.gatedSpecsByName.get(name);
      try {
        const envKeys = await this.supervisor.fetchEnvKeys(name);
        const conn = this.servers.get(name);
        const tools = conn ? await conn.listTools() : [];
        this.approval.emitDiscovered({
          mcp: name,
          envKeys,
          tools: tools.map((t) => ({ name: t.name, description: t.description })),
          author: gated?.author ?? "customer",
          source: gated?.source ?? "dropin",
          ...(gated?.kind ? { kind: gated.kind } : {}),
        });
      } catch (err) {
        this.log.warn({ name, err: err as Error }, `mcp-discovered emission for newly-added drop-in failed`);
      }
      return;
    }
    try {
      await this.view?.mcpActions?.reloadCreds(name);
    } catch (err) {
      this.log.warn({ name, err: err as Error }, `creds-request for newly-added drop-in failed — will retry on next reconnect`);
    }
  }

  // ─── inspector wiring ───────────────────────────────────────────────────

  // Actions that work with or without a live tunnel. The tunnel-dependent
  // ones (reloadCreds, callControllerApi) are replaced per dial by
  // buildMcpActions; until the first dial they refuse cleanly.
  private wireView(): void {
    const view = this.view;
    if (!view) return;
    view.onReconnect = () => { void this.reconnect("inspector requested", { manual: true }); };
    view.toolDispatch = async (serverName, toolName, args) => {
      const server = this.servers.get(serverName);
      if (!server) throw new Error(`no local MCP server '${serverName}'`);
      if (!this.isMcpEnabled(serverName)) {
        throw new Error(`MCP '${serverName}' is awaiting controller approval — tool calls are blocked`);
      }
      return server.callTool(toolName, args, { timeoutMs: this.shared.config.policy.tool_timeout_ms });
    };
    view.mcpActions = this.buildMcpActions(undefined);
  }

  private buildMcpActions(creds: CredsCoordinator | undefined): NonNullable<WorkspaceView["mcpActions"]> {
    const view = this.view;
    return {
      reloadCreds: async (name: string) => {
        if (!creds) throw new Error("no tunnel connected");
        const reqInfo = this.credsRequestFor(name);
        if (!reqInfo) throw new Error(`unknown MCP "${name}"`);
        await creds.reload(reqInfo.mcp, reqInfo.author, reqInfo.envKeys, reqInfo.mcpId);
      },
      restart: async (name: string) => {
        view?.clearMcpMessages(name);
        const ok = await this.supervisor.restart(name, "manual");
        if (!ok) throw new Error(`unknown MCP "${name}"`);
      },
      // F7: the inspector resolves a child's bearer token to (workspace, mcp)
      // by asking every workspace's supervisor — see Inspector.resolveWebhookToken.
      resolveMcpByWebhookToken: (token: string) => this.supervisor.resolveMcpByWebhookToken(token),
      rescanLocal: async () => {
        const ack = await this.localMcps.rescan();
        return { added: ack.added, removed: ack.removed, unchanged: ack.unchanged, errors: ack.errors };
      },
      applySessionCreds: async (name: string, env: Record<string, string>) => {
        const result = await this.supervisor.applySessionEnv(name, env, { mode: "merge" });
        if (!result.applied) throw new Error(`unknown MCP "${name}"`);
        return { expiresAt: result.expiresAt };
      },
      clearSessionCreds: async (name: string) => {
        await this.supervisor.clearSessionEnv(name, "session-creds-cleared-by-operator");
      },
      fetchEnvKeys: async (name: string) => this.supervisor.fetchEnvKeys(name),
      // v1.4: code-trust gate for the /internal/controller-api/call loopback
      // route — is `name` Twilio-authored bundled code (never a customer drop-in)?
      isAuthorTwilio: (name: string) => this.supervisor.isAuthorTwilio(name),
      // v1.4: invoke a named controller-side action on behalf of `mcp`, on
      // THIS workspace's tunnel. The inspector route has already resolved the
      // caller's token to this workspace and checked isAuthorTwilio.
      callControllerApi: async (mcp: string, action: string, params: unknown, timeoutMs?: number) => {
        // Approval gate. An MCP the controller can't reach by tool call must
        // not act on the controller either.
        if (!this.isMcpEnabled(mcp)) {
          throw Object.assign(new Error(`MCP '${mcp}' is not enabled by the controller`), { code: "mcp_not_enabled" });
        }
        const coordinator = this.controllerApi;
        if (!coordinator) {
          throw Object.assign(new Error("no tunnel connected"), { code: "tunnel_unavailable" });
        }
        return coordinator.call(mcp, this.mcpConfig.mcpIdFor(mcp), action, params, timeoutMs);
      },
    };
  }
}
