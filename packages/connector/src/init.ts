import { existsSync, writeFileSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomBytes } from "node:crypto";

// `mcp-connector init` — interactive wizard to write the connector-level
// connector.yaml.
//
// Asks for tunnel.controller_url, tunnel.name, then walks the user
// through adding mcp_servers entries:
//   Type 1 — customer-authored. Folder under mcp/local/<name>/ that holds
//            tools/*.ts + server.ts. Renders as `transport: http` + `dir:`,
//            no endpoint (the connector spawns it + auto-assigns a port).
//   Type 2 — connect to an existing MCP server. Either http with endpoint
//            or stdio with a command. Optional dir for the entry's .env.
//   Type 3 — bundled, Twilio-authored, pre-installed in this image. Set
//            `bundled: <name>` against a name in BUNDLED_MCPS; supply only
//            an .env under mcp/bundled/<name>/. Not surfaced in this wizard
//            yet — edit the yaml directly (see connector.yaml.example).
//
// The yaml uses ${VAR} interpolation against process.env, so init prints a
// .env snippet to paste and never writes secrets to the yaml.

interface InitFlags {
  output: string;
  force: boolean;
}

interface ServerEntry {
  name: string;
  // "type1" gets rendered as http+dir (no endpoint).
  // "type2-http" gets rendered as http+endpoint.
  // "type2-stdio" gets rendered as stdio+command (+ optional dir).
  kind: "type1" | "type2-http" | "type2-stdio";
  dir?: string;          // absolute when collected; written as a path relative to the yaml's directory
  endpoint?: string;
  command?: string[];
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

Interactive wizard. Prompts for tunnel fields and one or more mcp_servers,
then writes the YAML.

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
    const controllerUrl = await ask(rl, "Controller URL (HTTPS root)", "https://your-controller.example.com");
    const name = await askRequired(rl, "Connector name (must be unique on the controller)");

    const servers: ServerEntry[] = [];
    let i = 0;
    do {
      const entry = await promptServer(rl, i + 1);
      if (entry) {
        servers.push(entry);
        i += 1;
      }
    } while (await yesno(rl, "Add another MCP server?", false));

    const yamlText = renderYaml(controllerUrl, name, servers, dirname(outputPath));
    writeFileSync(outputPath, yamlText, "utf8");

    console.log(`\nWrote ${outputPath}`);
    console.log(`\nNext steps:`);
    console.log(`  1. In your .env (next to the yaml), set:`);
    console.log(`       CONTROLLER_URL=${controllerUrl}`);
    console.log(`       TUNNEL_AUTH_TOKEN=${randomBytes(32).toString("base64url")}`);
    console.log(`  2. For each Type 1 entry, add tools/*.ts + server.ts under its dir.`);
    console.log(`  3. Start: node packages/connector/dist/index.js start --config ${flags.output}`);
  } finally {
    rl.close();
  }
}

async function ask(rl: ReturnType<typeof createInterface>, label: string, fallback: string): Promise<string> {
  const ans = (await rl.question(`${label} [${fallback}]: `)).trim();
  return ans || fallback;
}

async function askRequired(rl: ReturnType<typeof createInterface>, label: string): Promise<string> {
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

async function promptServer(rl: ReturnType<typeof createInterface>, n: number): Promise<ServerEntry | null> {
  console.log(`\nMCP server #${n}:`);
  console.log(`  1) Type 1 — customer-authored (drop tools/*.ts in a folder; we spawn it)`);
  console.log(`  2) Type 2 — connect to an existing MCP via HTTP`);
  console.log(`  3) Type 2 — connect to an existing MCP via stdio (e.g. an npm-installed server)`);
  const choice = (await ask(rl, "  choice (1/2/3)", "1")).trim();

  if (choice === "1") {
    const name = await askRequired(rl, "  name (used by the controller; appears as a tool prefix)");
    const dir = resolve(await ask(rl, "  dir (folder for tools/ + server.ts)", `mcp/local/${name}`));
    return { name, kind: "type1", dir };
  }
  if (choice === "2") {
    const name = await askRequired(rl, "  name");
    const endpoint = await askRequired(rl, "  endpoint URL (e.g. https://example.com/mcp)");
    const dir = (await ask(rl, "  dir for per-MCP .env (blank to skip)", "")).trim();
    return {
      name,
      kind: "type2-http",
      endpoint,
      dir: dir ? resolve(dir) : undefined,
    };
  }
  if (choice === "3") {
    const name = await askRequired(rl, "  name");
    const cmdLine = await askRequired(rl, "  command (e.g. 'npx --yes some-mcp-server')");
    const dir = (await ask(rl, "  dir for per-MCP .env (blank to skip)", "")).trim();
    return {
      name,
      kind: "type2-stdio",
      command: cmdLine.split(/\s+/).filter(Boolean),
      dir: dir ? resolve(dir) : undefined,
    };
  }
  console.log("  (skipped — unrecognized choice)");
  return null;
}

function renderYaml(
  controllerUrl: string,
  name: string,
  servers: ServerEntry[],
  yamlDir: string
): string {
  const lines: string[] = [];
  lines.push("# Generated by `mcp-connector init`. Edit by hand if you want.");
  lines.push("# Tunnel secrets come from the .env next to this file via ${VAR}.");
  lines.push(
    "",
    "tunnel:",
    `  controller_url: ${quoteIfNeeded(controllerUrl)}`,
    `  name: ${quoteIfNeeded(name)}`,
    `  auth_token: \${TUNNEL_AUTH_TOKEN:-}`,
    `  environment: dev`,
    "",
    "mcp_servers:"
  );
  for (const s of servers) {
    lines.push(`  - name: ${quoteIfNeeded(s.name)}`);
    if (s.kind === "type1") {
      lines.push(
        `    transport: http`,
        `    dir: ${quoteIfNeeded(toRelative(s.dir!, yamlDir))}`
      );
    } else if (s.kind === "type2-http") {
      lines.push(
        `    transport: http`,
        `    endpoint: ${quoteIfNeeded(s.endpoint!)}`
      );
      if (s.dir) lines.push(`    dir: ${quoteIfNeeded(toRelative(s.dir, yamlDir))}`);
    } else {
      lines.push(`    transport: stdio`, `    command:`);
      for (const part of s.command!) lines.push(`      - ${quoteIfNeeded(part)}`);
      if (s.dir) lines.push(`    dir: ${quoteIfNeeded(toRelative(s.dir, yamlDir))}`);
    }
  }
  lines.push(
    "",
    "policy:",
    "  fail_mode: fail_fast",
    "  log_tool_args: redacted",
    "  max_concurrent_calls: 64",
    "  discovery_interval_ms: 30000",
    "  heartbeat_interval_ms: 1500",
    "  tool_timeout_ms: 5000",
    ""
  );
  return lines.join("\n");
}

// Render a path as "./foo/bar" / "../foo/bar" relative to the yaml dir so
// the file moves cleanly with the project. Falls back to absolute if the
// target is on a different volume / outside the tree.
function toRelative(target: string, base: string): string {
  const r = relative(base, target);
  if (!r) return ".";
  if (r.startsWith("..")) return r;
  return `./${r}`;
}

function quoteIfNeeded(v: string): string {
  // Allow ${...} interpolation tokens through bare. Other values get
  // double-quoted if they contain anything YAML would mis-parse.
  if (/^\$\{[^}]+\}$/.test(v)) return v;
  if (/^[A-Za-z0-9_./:\-+@]+$/.test(v) && !/^[-?:&*!|>%@`#]/.test(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
