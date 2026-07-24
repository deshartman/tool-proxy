import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

    // Scaffold .env next to the yaml, copying the shipped .env.example (so
    // a customer running `mcp-connector init` inside the container gets a
    // real template to edit next to their mounted connector.yaml). Skip
    // if .env already exists — we don't overwrite the customer's edits.
    const envPath = resolve(dirname(outputPath), ".env");
    const envCreated = scaffoldEnv(envPath);

    console.log(`\nWrote ${outputPath}`);
    if (envCreated) console.log(`Wrote ${envPath} (from bundled .env.example)`);
    else console.log(`Skipped ${envPath} (already exists — not overwritten)`);
    console.log(`\nNext steps:`);
    console.log(`  1. Edit ${envPath} and set at least:`);
    console.log(`       CONTROLLER_URL=${controllerUrl}`);
    console.log(`       TUNNEL_AUTH_TOKEN=${randomBytes(32).toString("base64url")}`);
    console.log(`  2. For each Type 1 entry, add tools/*.ts under its dir.`);
    const startCmd = flags.output === "connector.yaml"
      ? "mcp-connector start"
      : `mcp-connector start --config ${flags.output}`;
    console.log(`  3. Start: ${startCmd}`);
  } finally {
    rl.close();
  }
}

// Resolve the shipped .env.example. Two locations, tried in order:
//   1. `../.env.example` (sibling of `dist/`) — the ship location. Where
//      `connector/.env.example` sits after postbuild, and where
//      `/app/connector/.env.example` sits in the runtime image.
//   2. `../../.env.example` (repo root) — the source-of-truth. Dev
//      pre-postbuild only; a customer running inside the OCI image would
//      never hit this because the image doesn't carry the repo root above
//      `/app/connector/`.
// The fallback exists so tests can run without a preceding `npm run build`.
export function findShippedEnvExample(
  moduleUrl: string = import.meta.url
): string | null {
  const here = fileURLToPath(moduleUrl);
  const shipLocation = resolve(dirname(here), "..", ".env.example");
  if (existsSync(shipLocation)) return shipLocation;
  const sourceLocation = resolve(dirname(here), "..", "..", ".env.example");
  if (existsSync(sourceLocation)) return sourceLocation;
  return null;
}

export function scaffoldEnv(
  destPath: string,
  moduleUrl: string = import.meta.url
): boolean {
  if (existsSync(destPath)) return false;
  const src = findShippedEnvExample(moduleUrl);
  if (!src) {
    console.warn(
      "  (warning: could not locate bundled .env.example — skipped scaffolding .env)"
    );
    return false;
  }
  const contents = readFileSync(src, "utf8");
  writeFileSync(destPath, contents, "utf8");
  return true;
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
  for (const server of servers) {
    lines.push(`  - name: ${quoteIfNeeded(server.name)}`);
    if (server.kind === "type1") {
      lines.push(
        `    transport: http`,
        `    dir: ${quoteIfNeeded(toRelative(server.dir!, yamlDir))}`
      );
    } else if (server.kind === "type2-http") {
      lines.push(
        `    transport: http`,
        `    endpoint: ${quoteIfNeeded(server.endpoint!)}`
      );
      if (server.dir) lines.push(`    dir: ${quoteIfNeeded(toRelative(server.dir, yamlDir))}`);
    } else {
      lines.push(`    transport: stdio`, `    command:`);
      for (const part of server.command!) lines.push(`      - ${quoteIfNeeded(part)}`);
      if (server.dir) lines.push(`    dir: ${quoteIfNeeded(toRelative(server.dir, yamlDir))}`);
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

function quoteIfNeeded(value: string): string {
  // Allow ${...} interpolation tokens through bare. Other values get
  // double-quoted if they contain anything YAML would mis-parse.
  if (/^\$\{[^}]+\}$/.test(value)) return value;
  if (/^[A-Za-z0-9_./:\-+@]+$/.test(value) && !/^[-?:&*!|>%@`#]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
