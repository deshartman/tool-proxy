import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomBytes } from "node:crypto";
import { connectServer, type DiscoveredTool } from "./servers/index.js";
import type { McpServerSpec } from "./config.js";

// `mcp-connector init` — discovery-driven YAML scaffolder.
// Prompts for the few customer-authored fields, dials each MCP server to
// run tools/list as confirmation, then writes connector.yaml. The auth
// token stays in env (the YAML uses ${TUNNEL_AUTH_TOKEN:-}); init prints
// the .env snippet to paste rather than touching .env itself.

interface InitFlags {
  output: string;
  force: boolean;
}

export async function runInit(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      output: { type: "string", short: "o" },
      force: { type: "boolean", short: "f" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`usage: mcp-connector init [--output <path>] [--force]

Interactive wizard. Prompts for tunnel.controller_url, tunnel.connector_id,
and one or more mcp_servers[]. Connects to each server, runs tools/list,
prints the discovered tools as confirmation, then writes the YAML.

  -o, --output <path>   destination YAML path (default ./connector.yaml)
  -f, --force           overwrite an existing file`);
    return;
  }
  const flags: InitFlags = {
    output: values.output ?? "connector.yaml",
    force: !!values.force,
  };
  const outputPath = resolve(flags.output);
  if (existsSync(outputPath) && !flags.force) {
    throw new Error(`refusing to overwrite ${outputPath} (pass --force to overwrite)`);
  }

  const rl = createInterface({ input, output });
  try {
    const controllerUrl = await ask(rl, "Controller URL", "wss://your-controller.example.com/tunnel");
    const connectorId = await askRequired(rl, "Connector ID (e.g. conn_xxxxxxxx)");

    const servers: McpServerSpec[] = [];
    let i = 0;
    do {
      const isFirst = i === 0;
      const useDefault = isFirst
        ? await yesno(rl, "Add the bundled sample MCP server (http://localhost:7100/mcp)?", true)
        : false;
      if (useDefault) {
        servers.push({
          name: "sample",
          transport: "http",
          endpoint: "http://localhost:7100/mcp",
          timeout_ms: 5000,
        });
      } else {
        servers.push(await promptMcpServer(rl, i + 1));
      }
      i += 1;
    } while (await yesno(rl, "Add another MCP server?", false));

    const discovery = await discoverAll(servers);
    const yamlText = renderYaml(controllerUrl, connectorId, servers);
    writeFileSync(outputPath, yamlText, "utf8");

    console.log(`\nWrote ${outputPath}`);
    console.log("\nDiscovered tools:");
    for (const r of discovery) {
      if (r.error) {
        console.log(`  ${r.name}: ⚠ ${r.error}`);
      } else {
        console.log(`  ${r.name}: ${r.tools.map((t) => t.name).join(", ") || "(none)"}`);
      }
    }

    console.log(`\nNext steps:`);
    console.log(`  1. Set TUNNEL_AUTH_TOKEN in your .env (or unset if your controller doesn't require one):`);
    console.log(`       TUNNEL_AUTH_TOKEN=${randomBytes(32).toString("base64url")}`);
    console.log(`  2. Run: node packages/connector/dist/index.js start --config ${flags.output}`);
  } finally {
    rl.close();
  }
}

async function ask(rl: ReturnType<typeof createInterface>, label: string, fallback: string): Promise<string> {
  const ans = (await rl.question(`${label} [${fallback}]: `)).trim();
  return ans || fallback;
}

async function askRequired(rl: ReturnType<typeof createInterface>, label: string): Promise<string> {
  // Loop until non-empty so users can't hit Enter through the wizard with an
  // unset connector_id and silently get rejected by the controller later.
  while (true) {
    const ans = (await rl.question(`${label}: `)).trim();
    if (ans) return ans;
    console.log("  (required)");
  }
}

async function yesno(rl: ReturnType<typeof createInterface>, label: string, def: boolean): Promise<boolean> {
  const hint = def ? "Y/n" : "y/N";
  const ans = (await rl.question(`${label} [${hint}]: `)).trim().toLowerCase();
  if (!ans) return def;
  return ans === "y" || ans === "yes";
}

async function promptMcpServer(rl: ReturnType<typeof createInterface>, n: number): Promise<McpServerSpec> {
  console.log(`\nMCP server #${n}:`);
  const name = await askRequired(rl, "  name");
  const transport = (await ask(rl, "  transport (http|stdio)", "http")).toLowerCase();
  if (transport === "stdio") {
    const cmdLine = await askRequired(rl, "  command (space-separated, e.g. 'node server.js')");
    return {
      name,
      transport: "stdio",
      command: cmdLine.split(/\s+/).filter(Boolean),
      timeout_ms: 5000,
    };
  }
  if (transport !== "http") {
    throw new Error(`unsupported transport: ${transport}`);
  }
  const endpoint = await askRequired(rl, "  endpoint URL (e.g. http://localhost:7100/mcp)");
  return { name, transport: "http", endpoint, timeout_ms: 5000 };
}

interface DiscoveryRow {
  name: string;
  tools: DiscoveredTool[];
  error?: string;
}

async function discoverAll(servers: McpServerSpec[]): Promise<DiscoveryRow[]> {
  const results: DiscoveryRow[] = [];
  for (const spec of servers) {
    try {
      const conn = await connectServer(spec);
      try {
        const tools = await conn.listTools();
        results.push({ name: spec.name, tools });
      } finally {
        await conn.close().catch(() => undefined);
      }
    } catch (e) {
      results.push({ name: spec.name, tools: [], error: (e as Error).message });
    }
  }
  return results;
}

function renderYaml(controllerUrl: string, connectorId: string, servers: McpServerSpec[]): string {
  const lines: string[] = [];
  lines.push("# Generated by `mcp-connector init`. Edit by hand if you want.");
  lines.push("# tunnel.auth_token is interpolated from TUNNEL_AUTH_TOKEN in your .env.");
  lines.push("");
  lines.push("tunnel:");
  lines.push(`  controller_url: ${quoteIfNeeded(controllerUrl)}`);
  lines.push(`  connector_id: ${quoteIfNeeded(connectorId)}`);
  lines.push(`  environment: dev`);
  lines.push(`  auth_token: \${TUNNEL_AUTH_TOKEN:-}`);
  lines.push("");
  lines.push("mcp_servers:");
  for (const s of servers) {
    lines.push(`  - name: ${quoteIfNeeded(s.name)}`);
    lines.push(`    transport: ${s.transport}`);
    if (s.transport === "http") {
      lines.push(`    endpoint: ${quoteIfNeeded(s.endpoint)}`);
    } else {
      lines.push(`    command:`);
      for (const part of s.command) lines.push(`      - ${quoteIfNeeded(part)}`);
    }
    lines.push(`    timeout_ms: ${s.timeout_ms}`);
  }
  lines.push("");
  // Defaults from MCP-TUNNEL.md "Configuration surface"; same values the Zod
  // schema applies, restated so the YAML is self-describing.
  lines.push("policy:");
  lines.push("  fail_mode: fail_fast");
  lines.push("  log_tool_args: redacted");
  lines.push("  max_concurrent_calls: 64");
  lines.push("  discovery_interval_ms: 30000");
  lines.push("  heartbeat_interval_ms: 1500");
  lines.push("  tool_timeout_ms: 5000");
  lines.push("");
  return lines.join("\n");
}

function quoteIfNeeded(v: string): string {
  // Bare values are fine if they don't contain YAML-special chars or start
  // with one. Be conservative: anything with whitespace, colons, or shell
  // chars gets double-quoted with backslash-escaped backslashes/quotes.
  if (/^[A-Za-z0-9_./:\-+@]+$/.test(v) && !/^[-?:&*!|>%@`#]/.test(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
