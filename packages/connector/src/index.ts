import "dotenv/config";
import { loadConfig } from "./config.js";
import { connectAll, type McpServerConnection } from "./servers/index.js";
import { buildManifest } from "./manifest/build.js";
import { diffManifest, isEmptyDelta } from "./manifest/diff.js";
import { TunnelClient } from "./tunnel/client.js";
import { Dispatcher } from "./dispatcher.js";
import type { ToolManifest } from "./tunnel/frames.js";

async function main() {
  const configPath = process.env.CONNECTOR_CONFIG;
  if (!configPath) throw new Error("CONNECTOR_CONFIG env var is required");
  const version = process.env.CONNECTOR_VERSION ?? "dev";
  const authToken = process.env.TUNNEL_AUTH_TOKEN;

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

  // 3. Open tunnel and register.
  const tunnel = new TunnelClient(config.tunnel.controller_url, authToken);
  tunnel.onerror = (e) => log(`tunnel error: ${e.message}`);
  tunnel.onclose = () => {
    log(`tunnel closed — exiting`);
    process.exit(1);
  };
  await tunnel.connect();
  log(`tunnel connected to ${config.tunnel.controller_url}`);

  tunnel.send({ type: "register", manifest });
  log(`register frame sent`);

  // 4. Wire dispatcher.
  const dispatcher = new Dispatcher({
    config,
    servers,
    getManifest: () => manifest,
    tunnel,
    log,
  });
  dispatcher.attach();

  // 5. Heartbeat.
  const heartbeatTimer = setInterval(() => {
    tunnel.send({ type: "heartbeat", ts: Date.now() });
  }, config.policy.heartbeat_interval_ms);

  // 6. Discovery poll — push manifest-delta if local servers' tools change.
  const discoveryTimer = setInterval(() => {
    void refreshManifestAndPushDelta();
  }, config.policy.discovery_interval_ms);

  // 7. SIGHUP — reload YAML, rebuild manifest, push delta.
  process.on("SIGHUP", () => {
    void onSighup();
  });

  // 8. Graceful shutdown.
  const shutdown = (signal: string) => {
    log(`received ${signal} — shutting down`);
    clearInterval(heartbeatTimer);
    clearInterval(discoveryTimer);
    tunnel.close(`signal:${signal}`);
    void closeServers(servers).then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  async function refreshManifestAndPushDelta(): Promise<void> {
    try {
      const next = await buildManifest(config, servers, version);
      const delta = diffManifest(manifest, next);
      manifest = next;
      if (!isEmptyDelta(delta)) {
        tunnel.send({ type: "manifest-delta", delta });
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
      // Mutate the config in place for fields the running connector observes.
      // (Allow-list and policy can change live; mcp_servers cannot.)
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
