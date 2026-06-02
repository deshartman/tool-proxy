import "dotenv/config";
import { loadConfig } from "./config.js";
import { connectAll, type McpServerConnection } from "./servers/index.js";
import { buildManifest } from "./manifest/build.js";
import { diffManifest, isEmptyDelta } from "./manifest/diff.js";
import { TunnelClient } from "./tunnel/client.js";
import { Dispatcher } from "./dispatcher.js";
import type { ToolManifest } from "./tunnel/frames.js";
import { Inspector, startInspector } from "./inspector/server.js";

async function main() {
  const configPath = process.env.CONNECTOR_CONFIG;
  if (!configPath) throw new Error("CONNECTOR_CONFIG env var is required");
  const version = process.env.CONNECTOR_VERSION ?? "dev";
  const authToken = process.env.TUNNEL_AUTH_TOKEN;
  // Set INSPECTOR_PORT=0 to disable; defaults to 9090.
  const inspectorPort = process.env.INSPECTOR_PORT === "0"
    ? 0
    : Number(process.env.INSPECTOR_PORT ?? 9090);

  const config = loadConfig(configPath);
  log(`config loaded: connector_id=${config.tunnel.connector_id} environment=${config.tunnel.environment}`);

  if (config.allow_list === undefined) {
    log(`WARNING: allow_list omitted from config — every tool will be advertised with allowed=false`);
  }

  // 1. Connect to all local MCP servers in parallel. Fail fast if any are unreachable.
  log(`connecting to ${config.mcp_servers.length} local MCP server(s)...`);
  const servers = await connectAll(config.mcp_servers);
  log(`connected to local servers: ${[...servers.keys()].join(", ")}`);

  // 2. Build initial manifest.
  let manifest: ToolManifest = await buildManifest(config, servers, version);
  log(`built manifest with ${countTools(manifest)} tool(s)`);

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

  if (inspector) {
    inspector.onReconnect = () => { void reconnect("inspector requested"); };
    startInspector(inspectorPort, inspector);
  }

  await connectTunnel("initial");

  // SIGHUP — reload YAML, rebuild manifest, push delta.
  process.on("SIGHUP", () => { void onSighup(); });

  // Graceful shutdown.
  const shutdown = (signal: string) => {
    log(`received ${signal} — shutting down`);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (discoveryTimer) clearInterval(discoveryTimer);
    tunnel?.close(`signal:${signal}`);
    void closeServers(servers).then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // ─── connect / reconnect ────────────────────────────────────────────────
  async function connectTunnel(reason: string): Promise<void> {
    inspector?.setState("connecting");
    log(`tunnel ${reason}: dialing ${config.tunnel.controller_url}`);
    const t = new TunnelClient(config.tunnel.controller_url, authToken);
    t.onerror = (e) => log(`tunnel error: ${e.message}`);
    if (inspector) {
      t.onstate = (s) => inspector.setState(s);
      t.ontap = (tap) => inspector.recordTap(tap);
    }
    t.onclose = () => {
      log(`tunnel closed`);
      stopTimers();
      // Don't auto-redial — wait for the user to hit reconnect (or SIGHUP).
      // Inspector keeps showing the last manifest + frame log; state goes
      // 'closed' so the UI surfaces it.
    };

    try {
      await t.connect();
    } catch (e) {
      log(`tunnel connect failed: ${(e as Error).message}`);
      inspector?.setState("closed");
      return;
    }

    tunnel = t;
    log(`tunnel connected to ${config.tunnel.controller_url}`);
    t.send({ type: "register", manifest });
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
      log(`reconnect requested: ${reason}`);
      stopTimers();
      tunnel?.close("reconnect");
      tunnel = undefined;
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
      Object.assign(config, { allow_list: next.allow_list, policy: next.policy });
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

function sameMcpServers(
  a: { name: string; transport: string }[],
  b: { name: string; transport: string }[]
): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => s.name === b[i].name && s.transport === b[i].transport);
}

async function closeServers(servers: Map<string, McpServerConnection>): Promise<void> {
  await Promise.all([...servers.values()].map((s) => s.close().catch(() => undefined)));
}

function log(msg: string): void {
  console.log(`[connector] ${msg}`);
}

main().catch((e) => {
  console.error("connector startup failed:", e);
  process.exit(1);
});
