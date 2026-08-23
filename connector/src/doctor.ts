// `mcp-connector doctor` — preflight checks. One command answers "is this
// environment configured correctly?" for both dev-before-first-boot and
// prod-after-image-pull. No side effects: does NOT dial the controller with
// the real bearer, does NOT spawn MCPs, does NOT mint anything.
//
// Design: split into `runChecks(env, opts)` (pure function returning
// results) and `runDoctor(argv)` (CLI wrapper that prints + sets exit code).
// This lets tests exercise the check logic without touching stdout or
// process.exit.

import { parseArgs } from "node:util";
import { access, readFile, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createServer } from "node:net";
import { envOptional } from "./env.js";
import { loadConfig } from "./config.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  remediation?: string;
}

export interface DoctorOptions {
  // Skip network I/O (DNS, TCP dials). Useful for hermetic tests.
  skipNetwork?: boolean;
  // Override where we probe for state files / key files. Tests pass this;
  // production runs use process.cwd() defaults.
  cwd?: string;
}

// Public entry — runs every applicable check and returns an ordered array.
// Order matters: mode-agnostic checks first (an unset `.env` is a bigger
// problem than a missing `CONNECTOR_KEY_FILE`), then mode-specific.
export async function runChecks(
  env: NodeJS.ProcessEnv,
  opts: DoctorOptions = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(await checkNodeVersion());
  results.push(await checkEnvFile(opts.cwd ?? process.cwd()));
  results.push(await checkConnectorYaml(env, opts.cwd ?? process.cwd()));
  results.push(await checkInspectorPort(env));
  results.push(await checkMcpTree(env, opts.cwd ?? process.cwd()));
  results.push(await checkKeyFile(env));
  results.push(await checkPostgresUrl(env, opts.skipNetwork));

  return results;
}

// ---- individual checks (each returns a single CheckResult) ----

async function checkNodeVersion(): Promise<CheckResult> {
  const [major] = process.versions.node.split(".").map(Number);
  if (major >= 22) {
    return { name: "node-version", status: "ok", message: `node ${process.versions.node}` };
  }
  return {
    name: "node-version",
    status: "fail",
    message: `node ${process.versions.node} < 22`,
    remediation: "upgrade to Node 22 LTS or newer",
  };
}

async function checkEnvFile(cwd: string): Promise<CheckResult> {
  const path = resolvePath(cwd, ".env");
  try {
    await access(path, fsConstants.R_OK);
    return { name: "env-file", status: "ok", message: path };
  } catch {
    return {
      name: "env-file",
      status: "warn",
      message: `${path} not found`,
      remediation: "cp .env.example .env  (or set the env vars another way)",
    };
  }
}

async function checkConnectorYaml(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<CheckResult> {
  const configPath = envOptional("CONNECTOR_CONFIG", env)
    ?? resolvePath(cwd, "connector.yaml");
  try {
    // loadConfig parses + validates + interpolates env vars. We swallow
    // spec-level errors here and re-raise as fail results so the doctor
    // completes the rest of the checks instead of tripping on the yaml.
    const config = loadConfig(configPath);
    return {
      name: "connector-yaml",
      status: "ok",
      message: `${configPath} (${config.mcp_servers.length} mcp_server entries)`,
    };
  } catch (error) {
    return {
      name: "connector-yaml",
      status: "fail",
      message: `${configPath}: ${(error as Error).message}`,
      remediation: "fix the yaml (see connector.yaml.example for a reference)",
    };
  }
}

async function checkInspectorPort(env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const raw = envOptional("INSPECTOR_PORT", env) ?? "9090";
  const port = Number(raw);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    return {
      name: "inspector-port",
      status: "fail",
      message: `INSPECTOR_PORT=${raw} is not a valid port`,
    };
  }
  if (port === 0) {
    return {
      name: "inspector-port",
      status: "warn",
      message: "INSPECTOR_PORT=0 disables the inspector (and webhook ingress for any MCP using createWebhookEndpoint)",
    };
  }
  // Bind-probe to 127.0.0.1: same address the inspector actually binds to.
  const available = await probePort(port);
  if (available) return { name: "inspector-port", status: "ok", message: `:${port} free` };
  return {
    name: "inspector-port",
    status: "fail",
    message: `:${port} already in use`,
    remediation: `set INSPECTOR_PORT to a free port (or --inspector-port on start)`,
  };
}

async function checkMcpTree(env: NodeJS.ProcessEnv, cwd: string): Promise<CheckResult> {
  // We don't hard-fail on an empty tree — a customer whose connector talks
  // only to Type 2 (controller-pushed) MCPs legitimately has no drop-in dir
  // at all.
  //
  // Probe the paths the scanner actually reads, honouring the same env vars it
  // does. These previously pointed at ./mcp/local and ./mcp/bundled, which have
  // not existed since the customer-repo carve-out — so this check reported "no
  // MCP drop-in directory found" on a tree full of working MCPs.
  const candidates = [
    envOptional("MCP_DROPIN_DIR", env) ?? resolvePath(cwd, "customer-mcps"),
    envOptional("MCP_BUNDLED_DIR", env) ?? resolvePath(cwd, "bundled-mcps"),
    "/var/lib/mcp-connector/customer-mcps",
  ].filter((path, index, all) => all.indexOf(path) === index);
  const readable: string[] = [];
  for (const path of candidates) {
    try {
      const s = await stat(path);
      if (s.isDirectory()) readable.push(path);
    } catch {
      // absent — fine
    }
  }
  if (readable.length === 0) {
    return {
      name: "mcp-tree",
      status: "warn",
      message: "no MCP drop-in directory found",
      remediation: "customer MCPs live under ./customer-mcps/ (dev) or /var/lib/mcp-connector/customer-mcps/ (prod)",
    };
  }
  return { name: "mcp-tree", status: "ok", message: readable.join(", ") };
}

async function checkKeyFile(env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const path = envOptional("CONNECTOR_KEY_FILE", env);
  if (!path) {
    return {
      name: "connector-key-file",
      status: "fail",
      message: "CONNECTOR_KEY_FILE is required in db mode",
      remediation: `head -c 32 /dev/urandom > ./secrets/connector.key && export CONNECTOR_KEY_FILE=$PWD/secrets/connector.key`,
    };
  }
  try {
    const contents = await readFile(path);
    if (contents.length !== 32) {
      return {
        name: "connector-key-file",
        status: "fail",
        message: `${path} is ${contents.length} bytes, not 32`,
        remediation: "the key must be exactly 32 raw bytes (libsodium secretbox key)",
      };
    }
    return { name: "connector-key-file", status: "ok", message: `${path} (32 bytes)` };
  } catch (error) {
    return {
      name: "connector-key-file",
      status: "fail",
      message: `${path}: ${(error as Error).message}`,
    };
  }
}

async function checkPostgresUrl(
  env: NodeJS.ProcessEnv,
  skipNetwork = false,
): Promise<CheckResult> {
  const url = envOptional("POSTGRES_URL", env);
  if (!url) {
    return {
      name: "postgres-url",
      status: "fail",
      message: "POSTGRES_URL is required in db mode",
      remediation: "point at a Postgres 14+ instance (or run docker-compose.prod.yml which brings one up)",
    };
  }
  if (skipNetwork) return { name: "postgres-url", status: "ok", message: `${redact(url)} (reachability check skipped)` };
  // Two-stage on purpose. The TCP dial fails fast and cheaply when nothing is
  // listening; the auth probe then catches the case a dial cannot see — right
  // host and port, wrong credentials or missing database. That case used to
  // report `ok` here, so `doctor && start` green-lit a boot that then died on
  // `password authentication failed`, which is precisely the failure doctor
  // exists to pre-empt. `pg` is already a connector dependency and is imported
  // dynamically so it stays off the boot path.
  const parsed = safeParseUrl(url);
  if (!parsed) {
    return {
      name: "postgres-url",
      status: "fail",
      message: `POSTGRES_URL=${redact(url)} is not a valid URL`,
    };
  }
  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : 5432;
  const reachable = await tcpProbe(host, port, 2_000);
  if (!reachable) {
    return {
      name: "postgres-url",
      status: "warn",
      message: `${host}:${port} not reachable — schema may not exist yet`,
      remediation: "if this is a fresh install, run the connector once to seed the schema",
    };
  }
  return await authProbe(url, host, port);
}

// Connect for real, so wrong credentials or a missing database are caught here
// rather than as a FATAL at boot. Anything we can't classify is a `warn`, not a
// `fail` — doctor must not block a boot over an unrecognized libpq error.
async function authProbe(url: string, host: string, port: number): Promise<CheckResult> {
  let pg: typeof import("pg");
  try {
    pg = await import("pg");
  } catch {
    return { name: "postgres-url", status: "ok", message: `${host}:${port} reachable (auth check unavailable)` };
  }
  const client = new pg.default.Client({ connectionString: url, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    await client.end();
    return { name: "postgres-url", status: "ok", message: `${host}:${port} reachable, credentials accepted` };
  } catch (err) {
    try {
      await client.end();
    } catch {
      // already failed to connect; nothing to close
    }
    const code = (err as { code?: string }).code;
    const detail = err instanceof Error ? err.message : String(err);
    if (code === "28P01" || code === "28000") {
      return {
        name: "postgres-url",
        status: "fail",
        message: `${host}:${port} rejected the credentials in POSTGRES_URL`,
        remediation:
          "fix the user/password in POSTGRES_URL — or, for local dev, `unset POSTGRES_URL` and let scripts/start-connector.sh supply the default",
      };
    }
    if (code === "3D000") {
      return {
        name: "postgres-url",
        status: "fail",
        message: `${host}:${port} has no such database (${redact(url)})`,
        remediation:
          "create the database, or `unset POSTGRES_URL` for local dev so scripts/start-connector.sh picks the compose default",
      };
    }
    return {
      name: "postgres-url",
      status: "warn",
      message: `${host}:${port} reachable but the connection failed: ${detail}`,
    };
  }
}

// ---- helpers ----

function safeParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function redact(url: string): string {
  // Postgres URLs typically embed the password; strip it for log output.
  return url.replace(/(:\/\/[^:]+:)[^@]+@/, "$1***@");
}

async function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const net = await import("node:net");
  return new Promise<boolean>((resolveP) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolveP(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function probePort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolveP) => {
    const server = createServer();
    server.once("error", () => resolveP(false));
    server.once("listening", () => {
      server.close(() => resolveP(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

// ---- CLI wrapper ----

const USAGE = `usage: mcp-connector doctor [--json] [--skip-network]

Runs preflight checks against your .env, connector.yaml, and configured mode
(env or db). Exit code: 0 all-ok, 1 any fail, 2 any warn no fail.

Options:
  --json           machine-readable output (line-delimited JSON)
  --skip-network   skip TCP reachability probes (offline dev)
  -h, --help       show this help`;

export async function runDoctor(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
      "skip-network": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const results = await runChecks(process.env, { skipNetwork: values["skip-network"] });

  if (values.json) {
    for (const r of results) process.stdout.write(`${JSON.stringify(r)}\n`);
  } else {
    printHuman(results);
  }

  const anyFail = results.some((r) => r.status === "fail");
  const anyWarn = results.some((r) => r.status === "warn");
  if (anyFail) return 1;
  if (anyWarn) return 2;
  return 0;
}

function printHuman(results: CheckResult[]): void {
  const symbols: Record<CheckStatus, string> = { ok: "  ok ", warn: " warn", fail: " FAIL" };
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const pad = r.name.padEnd(width, " ");
    process.stdout.write(`[${symbols[r.status]}] ${pad}  ${r.message}\n`);
    if (r.remediation && r.status !== "ok") {
      process.stdout.write(`         ${" ".repeat(width)}  → ${r.remediation}\n`);
    }
  }
  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;
  const oks = results.filter((r) => r.status === "ok").length;
  process.stdout.write(`\n${oks} ok, ${warns} warn, ${fails} fail\n`);
}

