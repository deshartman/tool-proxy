import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
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
import { workspaceDir, removeWorkspaceStorage } from "@connector/boot/workspace-storage.js";
import { openTempStore, type StoreFixture } from "../helpers/config-store.js";

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
let store: ConfigStore;
let dropinRoot: string;
let ctlA: MockController;
let ctlB: MockController;
let wsA: TunnelWorkspace;
let wsB: TunnelWorkspace;
let inspector: Inspector;
let rpcId = 0;

async function rpc(ctl: MockController, method: string, params: unknown): Promise<Record<string, unknown>> {
  const id = `r${++rpcId}`;
  ctl.send({ type: "rpc", payload: { jsonrpc: "2.0", id, method, params } });
  const reply = await ctl.waitFor((f) => f.type === "rpc" && (f.payload as { id?: string })?.id === id);
  return reply.payload as Record<string, unknown>;
}

const toolNames = (manifest: unknown): string[] =>
  ((manifest as { servers: Array<{ name: string; tools: Array<{ name: string }> }> }).servers)
    .flatMap((s) => s.tools.map((t) => `${s.name}.${t.name}`));

beforeAll(async () => {
  fixture = await openTempStore();
  store = fixture.store;
  dropinRoot = mkdtempSync(join(tmpdir(), "ws-dropins-"));
  mkdirSync(dropinRoot, { recursive: true });
  symlinkSync(SAMPLE, join(dropinRoot, "sample"));
  process.env.MCP_DROPIN_ALLOW_SYMLINK_ESCAPE = "1";
  // Own child-port range. vitest runs files in parallel PROCESSES, and a
  // PortAllocator is per process, so two files spawning from the default 7100
  // can both take one port and one file's teardown kills the other's child.
  // (Production is one process with one allocator; this is a test-only race.)
  process.env.MCP_BASE_PORT = "17100";

  ctlA = await mockController();
  ctlB = await mockController();
  const rowA = await store.addController({ name: "a", controllerUrl: ctlA.url, connectorName: "a", environment: null, authMode: "static-bearer", tunnelAuthToken: "ts_a" });
  const rowB = await store.addController({ name: "b", controllerUrl: ctlB.url, connectorName: "b", environment: null, authMode: "static-bearer", tunnelAuthToken: "ts_b" });

  const config = ConfigSchema.parse({ mcp_servers: [], policy: { reconnect: { enabled: false } } });
  inspector = new Inspector();
  const shared: WorkspaceShared = {
    config,
    version: "test",
    store,
    inspector,
    ports: new PortAllocator(),
    readyTimeoutMs: 30000,
    bundled: [],
    dropins: discoverDropins({ yamlNames: new Set(), dropinDir: dropinRoot }),
    yamlNames: new Set(),
    reloadConfig: () => {},
  };
  expect(shared.dropins.map((d) => d.name)).toEqual(["sample"]);

  wsA = new TunnelWorkspace(rowA, shared);
  wsB = new TunnelWorkspace(rowB, shared);
  // Start both at once — the PortAllocator must keep the two spawns apart.
  await Promise.all([wsA.start(), wsB.start()]);
  await ctlA.waitFor((f) => f.type === "mcp-discovered");
  await ctlB.waitFor((f) => f.type === "mcp-discovered");
}, 90000);

afterAll(async () => {
  await Promise.allSettled([wsA?.stop("test"), wsB?.stop("test")]);
  await Promise.allSettled([ctlA?.close(), ctlB?.close()]);
  for (const ws of [wsA, wsB]) if (ws) removeWorkspaceStorage(ws.id);
  rmSync(dropinRoot, { recursive: true, force: true });
  delete process.env.MCP_DROPIN_ALLOW_SYMLINK_ESCAPE;
  delete process.env.MCP_BASE_PORT;
  await fixture?.cleanup();
}, 30000);

describe("two workspaces in one process", () => {
  it("each registers on its own tunnel with the one shimId", () => {
    const regA = ctlA.frames.find((f) => f.type === "register")!;
    const regB = ctlB.frames.find((f) => f.type === "register")!;
    expect(regA.shimId).toBe(store.getShimId());
    expect(regB.shimId).toBe(store.getShimId());
    expect(regA.name).toBe("a");
    expect(regB.name).toBe("b");
  });

  it("the same MCP runs in both, on distinct ports", () => {
    const portOf = (ws: TunnelWorkspace) =>
      (ws.supervisor as unknown as { entries: Map<string, { spec: { __port?: number } }> }).entries.get("sample")!.spec.__port;
    expect(portOf(wsA)).toBeTypeOf("number");
    expect(portOf(wsB)).toBeTypeOf("number");
    expect(portOf(wsA)).not.toBe(portOf(wsB));
  });

  it("each child gets its own MCP_STATE_DIR under its workspace", () => {
    expect(existsSync(join(workspaceDir(wsA.id)!, "sample"))).toBe(true);
    expect(existsSync(join(workspaceDir(wsB.id)!, "sample"))).toBe(true);
    expect(workspaceDir(wsA.id)).not.toBe(workspaceDir(wsB.id));
  });

  it("an approval in A is not visible in B", async () => {
    ctlA.send({ type: "mcp-enable", mcp: "sample" });
    const delta = await ctlA.waitFor((f) => f.type === "manifest-delta");
    expect(JSON.stringify(delta)).toContain("now");
    await ctlA.waitFor((f) => f.type === "mcp-enable-ack" && f.status === "enabled");

    expect(wsA.isMcpEnabled("sample")).toBe(true);
    expect(wsB.isMcpEnabled("sample")).toBe(false);
    expect(ctlB.frames.some((f) => f.type === "manifest-delta")).toBe(false);
    const listB = await rpc(ctlB, "tools/list", {});
    expect((listB.result as { tools: unknown[] }).tools).toEqual([]);
  });

  it("a tools/call on A runs on A's child, under A's qualified name", async () => {
    const shim = store.getShimId();
    const reply = await rpc(ctlA, "tools/call", { name: `${shim}.sample.uuid`, arguments: {} });
    expect(reply.error).toBeUndefined();
    // B never approved it: the same call on B is refused as not found.
    const refused = await rpc(ctlB, "tools/call", { name: `${shim}.sample.uuid`, arguments: {} });
    expect((refused.error as { data?: { kind?: string } })?.data?.kind).toBe("tool_not_found");
  });

  it("creds pushed to A restart A's child and not B's", async () => {
    const restarts = (ws: TunnelWorkspace) => ws.statuses().find((s) => s.name === "sample")!.restartCount;
    const beforeB = restarts(wsB);
    const beforeA = restarts(wsA);
    ctlA.send({ type: "creds-update", mcp: "sample", env: { WEATHER_API_KEY: "a-only" }, source: "operator-entered" });
    const deadline = Date.now() + 30000;
    while (restarts(wsA) === beforeA && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(restarts(wsA)).toBe(beforeA + 1);
    expect(restarts(wsB)).toBe(beforeB);
  }, 40000);

  it("the inspector holds one view per workspace", () => {
    expect(inspector.workspaceSummaries().map((w) => w.id).sort()).toEqual([wsA.id, wsB.id].sort());
  });

  it("stopping A leaves B serving", async () => {
    await wsA.stop("test");
    expect(wsA.isTunnelOpen()).toBe(false);
    expect(wsB.isTunnelOpen()).toBe(true);
    const listB = await rpc(ctlB, "tools/list", {});
    expect(listB.error).toBeUndefined();
  }, 20000);
});
