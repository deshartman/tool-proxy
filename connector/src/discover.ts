import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { connectServer } from "./servers/connect.js";
import { envOptional } from "./env.js";

// `tool-proxy discover` — non-interactive: connects to every MCP server in
// the YAML, calls tools/list on each, prints the result, then exits. Useful
// for "what would I expose?" without booting the tunnel.
export async function runDiscover(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`usage: tool-proxy discover [--config <path>]

Reads the connector YAML, connects to each mcp_servers[] entry, calls
tools/list, and prints the discovered tools per server.`);
    return;
  }

  const configPath = values.config ?? envOptional("CONNECTOR_CONFIG");
  if (!configPath) throw new Error("CONNECTOR_CONFIG env var or --config <path> is required");
  const config = loadConfig(configPath);

  let total = 0;
  for (const spec of config.mcp_servers) {
    process.stdout.write(`\n== ${spec.name} (${spec.transport}) ==\n`);
    let conn;
    try {
      conn = await connectServer(spec);
    } catch (error) {
      console.error(`  connect failed: ${(error as Error).message}`);
      continue;
    }
    try {
      const tools = await conn.listTools();
      for (const tool of tools) {
        process.stdout.write(`  - ${tool.name}: ${tool.description}\n`);
      }
      total += tools.length;
    } catch (error) {
      console.error(`  tools/list failed: ${(error as Error).message}`);
    } finally {
      await conn.close().catch(() => undefined);
    }
  }
  process.stdout.write(`\nDiscovered ${total} tool(s) across ${config.mcp_servers.length} server(s).\n`);
}
