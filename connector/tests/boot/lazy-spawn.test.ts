import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

import { TunnelWorkspace, type WorkspaceShared } from "@connector/boot/workspace.js";
import { ConfigStore } from "@connector/config-store/index.js";
import { ConfigSchema } from "@connector/config.js";
import { discoverDropins } from "@connector/dropin.js";
import { PortAllocator } from "@connector/port-allocator.js";
import { Inspector } from "@connector/inspector/server.js";
import { removeWorkspaceStorage } from "@connector/boot/workspace-storage.js";
import { DiscoveryCache } from "@connector/boot/discovery-cache.js";
import { createLogger } from "@connector/logger.js";
import { openTempStore, type StoreFixture } from "../helpers/config-store.js";

// LAZY-SPAWN variant (§5.3, D16) of two-workspaces.test.ts: same harness,
// with the process-wide DiscoveryCache wired, so gated children start only on
// mcp-enable. The original header follows.
//
// MULTI-PLATFORM-MCP §5.10, end to end: two REAL TunnelWorkspaces in one
// process, each dialling its own mock controller over a real WebSocket, each
// spawning its own real `sample` child. This is the isolation claim (D14)
// tested directly rather than through stand-ins:
//   * the same MCP name lives in both workspaces with no collision, on
//     distinct ports (the shared PortAllocator under contention);
//   * an approval in A is not visible in B;
//   * creds pushed to A restart A's child and not B's;
//   * a tools/call on A runs on A's child;
//   * each child gets its own MCP_STATE_DIR;
//   * stopping one workspace leaves the other serving.

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(here, "../../../examples/demos/sample");

interface MockController {
  url: string;
  frames: Array<Record<string, unknown>>;
  socket(): WebSocket | undefined;
  send(frame: unknown): void;
  waitFor(pred: (f: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

async function mockController(): Promise<MockController> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server, path: "/mcp-tunnel" });
  const frames: Array<Record<string, unknown>> = [];
  let live: WebSocket | undefined;
  const waiters: Array<() => void> = [];
  wss.on("connection", (ws) => {
    live = ws;
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "register") {
        ws.send(JSON.stringify({ type: "register-ack", connectorId: "c", accepted: true, registrationToken: "rt", supportedTunnelProtocol: { min: "1.0", max: "2.0" } }));
      }
      for (const w of waiters.splice(0)) w();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    frames,
    socket: () => live,
    send: (frame) => live?.send(JSON.stringify(frame)),
    async waitFor(pred, ms = 20000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = frames.find(pred);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`timed out; saw ${frames.map((f) => f.type).join(",")}`);
        await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 100); });
      }
    },
    async close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

let fixture: StoreFixture;
let dropinRoot: string;
let ctlA: MockController;
let ctlB: MockController;
let wsA: TunnelWorkspace;
let wsB: TunnelWorkspace;
let discoverySpawns = 0;
let rpcId = 0;

async function rpc(ctl: MockController, method: string, params: unknown): Promise<Record<string, unknown>> {
  const id = `r${++rpcId}`;
  ctl.send({ type: "rpc", payload: { jsonrpc: "2.0", id, method, params } });
  const reply = await ctl.waitFor((f) => f.type === "rpc" && (f.payload as { id?: string })?.id === id);
  return reply.payload as Record<string, unknown>;
}

const running = (ws: TunnelWorkspace) => ws.statuses().find((s) => s.name === "sample")!.process;

beforeAll(async () => {
  fixture = await openTempStore();
  dropinRoot = mkdtempSync(join(tmpdir(), "ws-lazy-"));
  mkdirSync(dropinRoot, { recursive: true });
  symlinkSync(SAMPLE, join(dropinRoot, "sample"));
  // `sample` declares no envKeys, so a second, minimal drop-in that does
  // proves envKeys travel through the discovery cache too.
  mkdirSync(join(dropinRoot, "keyed", "tools"), { recursive: true });
  writeFileSync(join(dropinRoot, "keyed", "tools", "ping.ts"), [
    'import type { Tool } from "@mcp-shim/connector/sdk";',
    'export const ping: Tool = {',
    '  name: "ping",',
    '  envKeys: ["KEYED_API_TOKEN"],',
    '  register(server) {',
    '    server.registerTool("ping", { description: "ping" }, async () => ({ content: [{ type: "text", text: "pong" }] }));',
    '  },',
    '};',
    'export default ping;',
    '',
  ].join("\n"));
  process.env.MCP_DROPIN_ALLOW_SYMLINK_ESCAPE = "1";
  // Own child-port range. vitest runs files in parallel PROCESSES, and a
  // PortAllocator is per process, so two files spawning from the default 7100
  // can both take one port and one file's teardown kills the other's child.
  // (Production is one process with one allocator; this is a test-only race.)
  process.env.MCP_BASE_PORT = "17300";
  // Refresh (local-mcps-rescan) re-scans MCP_DROPIN_DIR.
  process.env.MCP_DROPIN_DIR = dropinRoot;

  ctlA = await mockController();
  ctlB = await mockController();
  const rowA = await fixture.store.addController({ name: "a", controllerUrl: ctlA.url, connectorName: "a", environment: null, authMode: "static-bearer", tunnelAuthToken: "ts_a" });
  const rowB = await fixture.store.addController({ name: "b", controllerUrl: ctlB.url, connectorName: "b", environment: null, authMode: "static-bearer", tunnelAuthToken: "ts_b" });

  const ports = new PortAllocator();
  const discovery = new DiscoveryCache({ ports, readyTimeoutMs: 30000, log: createLogger("test-discovery") });
  const realDescribe = discovery.describe.bind(discovery);
  // Count spawns: concurrent describes of one folder must share ONE spawn.
  (discovery as unknown as { spawnAndRead: (...a: unknown[]) => unknown }).spawnAndRead = ((orig) => function (this: unknown, ...a: unknown[]) {
    discoverySpawns++;
    return orig.apply(this, a);
  })((discovery as unknown as { spawnAndRead: (...a: unknown[]) => unknown }).spawnAndRead);
  void realDescribe;

  const shared: WorkspaceShared = {
    config: ConfigSchema.parse({ mcp_servers: [], policy: { reconnect: { enabled: false } } }),
    version: "test",
    store: fixture.store,
    inspector: new Inspector(),
    ports,
    readyTimeoutMs: 30000,
    bundled: [],
    dropins: discoverDropins({ yamlNames: new Set(), dropinDir: dropinRoot }),
    yamlNames: new Set(),
    reloadConfig: () => {},
    discovery,
  };
  wsA = new TunnelWorkspace(rowA, shared);
  wsB = new TunnelWorkspace(rowB, shared);
  await Promise.all([wsA.start(), wsB.start()]);
  for (const ctl of [ctlA, ctlB]) {
    await ctl.waitFor((f) => f.type === "mcp-discovered" && f.mcp === "sample");
    await ctl.waitFor((f) => f.type === "mcp-discovered" && f.mcp === "keyed");
  }
}, 90000);

afterAll(async () => {
  await Promise.allSettled([wsA?.stop("test"), wsB?.stop("test")]);
  await Promise.allSettled([ctlA?.close(), ctlB?.close()]);
  for (const ws of [wsA, wsB]) if (ws) removeWorkspaceStorage(ws.id);
  rmSync(dropinRoot, { recursive: true, force: true });
  delete process.env.MCP_DROPIN_ALLOW_SYMLINK_ESCAPE;
  delete process.env.MCP_BASE_PORT;
  delete process.env.MCP_DROPIN_DIR;
  await fixture?.cleanup();
}, 30000);

describe("lazy spawn (§5.3)", () => {
  it("no gated child runs before it is enabled", () => {
    for (const ws of [wsA, wsB]) {
      expect(ws.statuses().map((s) => s.process)).toEqual(["stopped", "stopped"]);
    }
  });

  it("mcp-discovered still carries the real tool list and envKeys, from ONE discovery spawn per folder", () => {
    for (const ctl of [ctlA, ctlB]) {
      const sample = ctl.frames.find((f) => f.type === "mcp-discovered" && f.mcp === "sample")!;
      expect((sample.tools as Array<{ name: string }>).map((t) => t.name).sort()).toEqual(["now", "slow_echo", "uuid", "weather"]);
      const keyed = ctl.frames.find((f) => f.type === "mcp-discovered" && f.mcp === "keyed")!;
      expect(keyed.envKeys).toEqual(["KEYED_API_TOKEN"]);
      expect((keyed.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["ping"]);
    }
    // Two workspaces × two folders, but each folder spawned once.
    expect(discoverySpawns).toBe(2);
  });

  it("an un-enabled gated child does not hold readiness", () => {
    expect(wsA.childrenPending()).toEqual([]);
    expect(wsB.childrenPending()).toEqual([]);
  });

  it("mcp-enable on A starts A's child only; the delta precedes the ack; a call then works", async () => {
    ctlA.send({ type: "mcp-enable", mcp: "sample" });
    const ack = await ctlA.waitFor((f) => f.type === "mcp-enable-ack");
    expect(ack.status).toBe("enabled");
    expect(ack.toolsCount).toBe(4);
    const deltaIdx = ctlA.frames.findIndex((f) => f.type === "manifest-delta");
    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    expect(deltaIdx).toBeLessThan(ctlA.frames.indexOf(ack));
    expect(running(wsA)).toBe("running");
    expect(running(wsB)).toBe("stopped");

    const reply = await rpc(ctlA, "tools/call", { name: `${fixture.store.getShimId()}.sample.uuid`, arguments: {} });
    expect(reply.error).toBeUndefined();
    // The freshly started child gets its creds-request, as a boot-time child would.
    expect(ctlA.frames.filter((f) => f.type === "creds-request" && f.mcp === "sample").length).toBeGreaterThan(0);
  }, 40000);

  it("mcp-disable keeps the child warm (MCP-PROTOCOL.md: no stop on disable)", async () => {
    ctlA.send({ type: "mcp-disable", mcp: "sample" });
    await ctlA.waitFor((f) => f.type === "mcp-enable-ack" && f.status === "disabled");
    expect(running(wsA)).toBe("running");
    expect(wsA.isMcpEnabled("sample")).toBe(false);
  });

  it("re-enable does not spawn a second child", async () => {
    const before = wsA.statuses().find((s) => s.name === "sample")!.restartCount;
    const acks = ctlA.frames.filter((f) => f.type === "mcp-enable-ack").length;
    ctlA.send({ type: "mcp-enable", mcp: "sample" });
    const deadline = Date.now() + 10000;
    while (ctlA.frames.filter((f) => f.type === "mcp-enable-ack").length === acks && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(wsA.isMcpEnabled("sample")).toBe(true);
    expect(wsA.statuses().find((s) => s.name === "sample")!.restartCount).toBe(before);
  });
});

// Plan §10 q6, hybrid: connect-time discovery stays (cached); the
// controller's Refresh describes NEW folders without starting them and
// re-describes folders whose code CHANGED.
const pingTool = (name: string, envKey: string) => [
  'import type { Tool } from "@mcp-shim/connector/sdk";',
  `export const t: Tool = {`,
  `  name: "${name}",`,
  `  envKeys: ["${envKey}"],`,
  '  register(server) {',
  `    server.registerTool("${name}", { description: "${name}" }, async () => ({ content: [{ type: "text", text: "ok" }] }));`,
  '  },',
  '};',
  'export default t;',
  '',
].join("\n");

const discoveredFor = (ctl: MockController, mcp: string) => ctl.frames.filter((f) => f.type === "mcp-discovered" && f.mcp === mcp);

describe("Refresh from the controller (hybrid discovery)", () => {
  it("a folder added after boot is described but NOT started", async () => {
    mkdirSync(join(dropinRoot, "fresh", "tools"), { recursive: true });
    writeFileSync(join(dropinRoot, "fresh", "tools", "hello.ts"), pingTool("hello", "FRESH_KEY"));
    ctlB.send({ type: "local-mcps-rescan" });
    const ack = await ctlB.waitFor((f) => f.type === "local-mcps-rescan-ack", 40000);
    expect(ack.added).toEqual([{ name: "fresh", toolsCount: 1 }]);
    const [frame] = discoveredFor(ctlB, "fresh");
    expect((frame.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["hello"]);
    expect(frame.envKeys).toEqual(["FRESH_KEY"]);
    expect(wsB.statuses().find((s) => s.name === "fresh")!.process).toBe("stopped");
  }, 60000);

  it("an un-started folder whose code changed is re-described with the new tools", async () => {
    const before = discoveredFor(ctlB, "keyed").length;
    writeFileSync(join(dropinRoot, "keyed", "tools", "pong.ts"), pingTool("pong", "KEYED_API_TOKEN"));
    const acks = ctlB.frames.filter((f) => f.type === "local-mcps-rescan-ack").length;
    ctlB.send({ type: "local-mcps-rescan" });
    const deadline = Date.now() + 40000;
    while (ctlB.frames.filter((f) => f.type === "local-mcps-rescan-ack").length === acks && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const frames = discoveredFor(ctlB, "keyed");
    expect(frames.length).toBe(before + 1);
    expect((frames.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name).sort()).toEqual(["ping", "pong"]);
    expect(wsB.statuses().find((s) => s.name === "keyed")!.process).toBe("stopped");
  }, 60000);

  it("an unchanged folder is not re-described", async () => {
    const before = discoveredFor(ctlB, "sample").length;
    const acks = ctlB.frames.filter((f) => f.type === "local-mcps-rescan-ack").length;
    ctlB.send({ type: "local-mcps-rescan" });
    const deadline = Date.now() + 20000;
    while (ctlB.frames.filter((f) => f.type === "local-mcps-rescan-ack").length === acks && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(discoveredFor(ctlB, "sample").length).toBe(before);
  }, 30000);
});
