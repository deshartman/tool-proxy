import { spawn, type ChildProcess } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { isType1Spawn, type McpServerSpec } from "./config.js";

// Resolve tsx's bin from the connector package's own node_modules so spawn
// doesn't fall back to PATH/npx network lookup. tsx is a runtime dep.
// Going via package.json sidesteps tsx's `exports` map which blocks subpath
// access to ./dist/cli.mjs directly.
const TSX_BIN = join(dirname(require.resolve("tsx/package.json")), "dist/cli.mjs");

export interface SpawnedChild {
  name: string;
  dir: string;
  port: number;
  pid: number;
  proc: ChildProcess;
}

export interface SpawnerOptions {
  basePort?: number;        // default 7100
  readyTimeoutMs?: number;  // default 5000
  log?: (msg: string) => void;
}

// Spawns every Type 1 entry in `specs` as a child process and mutates each
// spec to set its `endpoint` to the assigned localhost URL. After this
// returns, the existing connectAll() can treat Type 1 entries identically to
// Type 2 http entries.
//
// Type 2 entries (http with endpoint set, or stdio) are passed through
// untouched.
export async function spawnType1Children(
  specs: McpServerSpec[],
  opts: SpawnerOptions = {}
): Promise<SpawnedChild[]> {
  const log = opts.log ?? (() => {});
  const basePort = opts.basePort ?? Number(process.env.MCP_BASE_PORT ?? 7100);
  const readyTimeoutMs = opts.readyTimeoutMs ?? 5000;

  const children: SpawnedChild[] = [];
  // Track ports we've already handed out this run so two children don't race
  // for the same probe-clear port.
  const reserved = new Set<number>();

  for (const spec of specs) {
    if (!isType1Spawn(spec)) continue;

    const port = await findAvailablePort(basePort, reserved);
    reserved.add(port);

    const dir = spec.dir;
    const serverFile = resolve(dir, "server.ts");
    const childEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
    if (spec.env) Object.assign(childEnv, spec.env);

    log(`spawning Type 1 child "${spec.name}" at ${dir} on port ${port}`);

    const proc = spawn(process.execPath, [TSX_BIN, serverFile], {
      cwd: dir,
      env: childEnv,
      stdio: ["ignore", "inherit", "inherit"],
    });

    proc.on("error", (e) => log(`child "${spec.name}" spawn error: ${e.message}`));
    proc.on("exit", (code, signal) => {
      log(`child "${spec.name}" exited (code=${code}, signal=${signal})`);
    });

    try {
      await waitForPort(port, readyTimeoutMs);
    } catch (e) {
      proc.kill("SIGTERM");
      throw new Error(`Type 1 child "${spec.name}" did not become ready on port ${port} within ${readyTimeoutMs}ms: ${(e as Error).message}`);
    }

    spec.endpoint = `http://127.0.0.1:${port}/mcp`;
    children.push({ name: spec.name, dir, port, pid: proc.pid ?? -1, proc });
  }

  return children;
}

export async function shutdownChildren(children: SpawnedChild[], log: (msg: string) => void = () => {}): Promise<void> {
  for (const c of children) {
    if (c.proc.exitCode == null && c.proc.signalCode == null) {
      log(`SIGTERM child "${c.name}" (pid=${c.pid})`);
      c.proc.kill("SIGTERM");
    }
  }
}

// Probe-bind a TCP socket on 127.0.0.1 to find the first port at or above
// `from` that the OS will accept, skipping any we've already handed out.
async function findAvailablePort(from: number, reserved: Set<number>): Promise<number> {
  for (let p = from; p < from + 1000; p++) {
    if (reserved.has(p)) continue;
    if (await canBind(p)) return p;
  }
  throw new Error(`no free port found above ${from}`);
}

function canBind(port: number): Promise<boolean> {
  return new Promise((res) => {
    const srv = createServer();
    srv.once("error", () => res(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => res(true));
    });
  });
}

// Poll the port until something accepts a TCP connection or we time out.
function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveReady, rejectReady) => {
    const tryOnce = () => {
      const sock = createConnection({ host: "127.0.0.1", port });
      sock.once("connect", () => {
        sock.destroy();
        resolveReady();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() >= deadline) {
          rejectReady(new Error(`timeout waiting for port ${port}`));
          return;
        }
        setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}
