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
import { readDoc, resolveStatePath } from "./config-store/store-file.js";
import { resolveMasterKey } from "./config-store/master-key.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  remediation?: string;
}

export interface DoctorOptions {
  // Skip network I/O (DNS, TCP dials). Useful for hermetic tests.
  /**
   * Inert since the config store became a local file — no check reaches the
   * network any more. Retained so `doctor --skip-network` in existing
   * runbooks and tests keeps working rather than erroring on an unknown flag.
   */
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
  results.push(await checkConfigStore(env));

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

  // The port is taken — but by WHAT? This check was written for the
  // `doctor && start` runbook, where anything holding the port is a real
  // conflict. It is also run against a RUNNING container ("is my deployment
  // healthy?"), and there the holder is the connector being checked, so a
  // plain `fail` made every healthy deploy exit 1. Observed on the live AWS
  // deploy, where it was the only non-ok line on a working connector.
  //
  // Ask the holder who it is. The inspector answers its own dashboard on `/`,
  // and nothing else in this system does — so a 200 carrying the dashboard
  // title means we are inspecting a live connector, not colliding with one.
  // A 403 counts too: that is the loopback gate refusing a non-loopback
  // caller, which only the inspector does.
  const holder = await identifyInspector(port);
  if (holder) {
    return {
      name: "inspector-port",
      status: "ok",
      message: `:${port} serving the inspector (this connector is already running)`,
    };
  }
  return {
    name: "inspector-port",
    status: "fail",
    message: `:${port} already in use by something else`,
    remediation: `set INSPECTOR_PORT to a free port (or --inspector-port on start)`,
  };
}

/**
 * Is the process holding `port` our own inspector? Deliberately narrow: a
 * generous check would mask a genuine conflict with an unrelated service, which
 * is the failure this whole check exists to catch.
 */
async function identifyInspector(port: number): Promise<boolean> {
  try {
    // 750ms, not longer. This is a loopback request to a process on the same
    // host — if it has not answered by then it is not our inspector. The budget
    // matters because a socket that ACCEPTS and never replies (a hung service,
    // or a raw TCP listener) makes fetch wait the whole timeout, and `doctor`
    // is a preflight an operator runs interactively and CI runs before boot.
    // AbortSignal.timeout covers that case; a connection-refused rejects
    // immediately and never reaches the deadline.
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(750),
      // Do not keep the socket alive. Without this, undici pools the
      // connection and the listener we just probed cannot be closed until the
      // pool times out — a hung service would leave `doctor` holding a socket
      // open against it. Caught by a test whose own `server.close()` blocked
      // waiting for exactly that connection to drain.
      headers: { connection: "close" },
    });
    // The gate refusing a non-loopback caller is itself proof of identity —
    // no other service in this system answers 403 on `/`.
    if (res.status === 403) return true;
    if (!res.ok) {
      // Drain, so the socket is released rather than left to the pool.
      await res.arrayBuffer().catch(() => undefined);
      return false;
    }
    const body = await res.text();
    return body.includes("MCP Connector Inspector");
  } catch {
    // Not HTTP, or not answering. A raw TCP listener on our port is exactly
    // the conflict this check is for.
    return false;
  }
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

// The config store is a sealed JSON file on the state volume (see
// the sealed JSON store). Three things can be wrong and all three
// are worth catching BEFORE boot rather than on the operator's first Configure
// Tunnel submit — that submit is the first write, so a permissions problem
// would otherwise surface long after the deploy looked healthy. This is the
// agentic-memory EACCES failure shape; don't let it come back.
async function checkConfigStore(env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const path = resolveStatePath(env);
  const dir = resolvePath(path, "..");

  // Absent file is a VALID state — a fresh install configures itself through
  // the inspector. What matters is that the directory is writable by THIS uid,
  // because that is who will create the file.
  let exists = true;
  try {
    await access(path, fsConstants.F_OK);
  } catch {
    exists = false;
  }

  if (!exists) {
    try {
      await access(dir, fsConstants.W_OK);
    } catch {
      return {
        name: "config-store",
        status: "fail",
        message: `${dir} is not writable by uid ${process.getuid?.() ?? "?"} — the config store cannot be created`,
        remediation:
          "chown the state volume to the connector's user (the container entrypoint does this before dropping privileges; a pre-provisioned or read-only mount does not)",
      };
    }
    return { name: "config-store", status: "ok", message: `${path} absent — will be created at boot (configure via the inspector)` };
  }

  try {
    await access(path, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    return {
      name: "config-store",
      status: "fail",
      message: `${path} exists but is not readable+writable by uid ${process.getuid?.() ?? "?"}`,
      remediation: "chown the file to the connector's user and set mode 0600",
    };
  }

  let doc;
  try {
    doc = readDoc(path);
  } catch (error) {
    return {
      name: "config-store",
      status: "fail",
      message: (error as Error).message,
      remediation: "restore from a backup, or move the file aside to start fresh (this discards the tunnel identity)",
    };
  }

  // Fingerprint mismatch is fatal at boot, so surface it here. Only checked
  // when the key itself resolves — checkKeyFile already owns that failure and
  // reporting it twice would just be noise.
  try {
    const key = resolveMasterKey(env);
    if (doc.keyFingerprint !== key.fingerprint) {
      return {
        name: "config-store",
        status: "fail",
        message: `${path} was sealed with a different master key`,
        remediation: "restore the original CONNECTOR_KEY_FILE, or move the store aside and re-add the controller via the inspector",
      };
    }
  } catch {
    return { name: "config-store", status: "warn", message: `${path} parsed; key fingerprint unverified (see connector-key-file)` };
  }

  const controllers = doc.controllers.length;
  return {
    name: "config-store",
    status: "ok",
    message: `${path} valid, key matches${controllers === 0 ? ", no controller configured yet" : ""}`,
  };
}

// ---- helpers ----




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

