import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Inspector, startInspector, type McpActions } from "@connector/inspector/server.js";

// MULTI-PLATFORM-MCP Phase 6 (§5.5, §5.8). One inspector, one view per
// workspace. Pinned here:
//   * an operator route names its workspace with ?ws=; omitted it means the
//     only workspace, and with several it is a 400 rather than a guess;
//   * a child's per-MCP bearer routes its controller-call to ITS workspace,
//     so a call from B's child can only ever reach B's tunnel;
//   * the event stream is scoped to one workspace and carries the list.

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function serve(inspector: Inspector): Promise<number> {
  server = startInspector(0, inspector);
  await new Promise<void>((r) => server!.once("listening", () => r()));
  return (server.address() as AddressInfo).port;
}

const post = (port: number, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-inspector-request": "1", ...headers },
    body: JSON.stringify(body),
  });

// A workspace whose actions record what reached it.
function wire(inspector: Inspector, id: string, token: string, calls: string[]): void {
  const view = inspector.addWorkspace(id, { controllerUrl: `https://${id}.example`, state: "open" });
  view.mcpActions = {
    reloadCreds: async (name) => { calls.push(`${id}:reload:${name}`); },
    restart: async (name) => { calls.push(`${id}:restart:${name}`); },
    resolveMcpByWebhookToken: (t) => (t === token ? "agentic-memory" : undefined),
    isAuthorTwilio: () => true,
    callControllerApi: async (mcp, action) => { calls.push(`${id}:call:${mcp}:${action}`); return { from: id }; },
  } as McpActions;
}

describe("workspace-scoped operator routes", () => {
  it("?ws= reaches that workspace only", async () => {
    const inspector = new Inspector();
    const calls: string[] = [];
    wire(inspector, "A", "tok-a", calls);
    wire(inspector, "B", "tok-b", calls);
    const port = await serve(inspector);

    const res = await post(port, "/mcp/restart?ws=B", { mcp: "crm" });
    expect(res.status).toBe(202);
    expect(calls).toEqual(["B:restart:crm"]);
  });

  it("omitted ws with several workspaces is a 400, and nothing runs", async () => {
    const inspector = new Inspector();
    const calls: string[] = [];
    wire(inspector, "A", "tok-a", calls);
    wire(inspector, "B", "tok-b", calls);
    const port = await serve(inspector);

    const res = await post(port, "/mcp/restart", { mcp: "crm" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/several workspaces/);
    expect(calls).toEqual([]);
  });

  it("omitted ws with exactly one workspace means that one (the pre-Phase-6 shape)", async () => {
    const inspector = new Inspector();
    const calls: string[] = [];
    wire(inspector, "A", "tok-a", calls);
    const port = await serve(inspector);

    expect((await post(port, "/mcp/reload-creds", { mcp: "crm" })).status).toBe(202);
    expect(calls).toEqual(["A:reload:crm"]);
  });

  it("an unknown ws is a 404", async () => {
    const inspector = new Inspector();
    wire(inspector, "A", "tok-a", []);
    const port = await serve(inspector);
    expect((await post(port, "/mcp/restart?ws=nope", { mcp: "crm" })).status).toBe(404);
  });

  it("CSRF is checked before the workspace is resolved (a forged POST learns nothing)", async () => {
    const inspector = new Inspector();
    wire(inspector, "A", "tok-a", []);
    const port = await serve(inspector);
    const res = await fetch(`http://127.0.0.1:${port}/mcp/restart?ws=nope`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });
});

describe("controller-call is routed by the child's token (§5.5)", () => {
  it("B's child reaches B's tunnel, never A's", async () => {
    const inspector = new Inspector();
    const calls: string[] = [];
    wire(inspector, "A", "tok-a", calls);
    wire(inspector, "B", "tok-b", calls);
    const port = await serve(inspector);

    const res = await post(port, "/internal/controller-api/call", { action: "memory.write" }, { authorization: "Bearer tok-b" });
    expect(res.status).toBe(200);
    expect((await res.json()).result).toEqual({ from: "B" });
    expect(calls).toEqual(["B:call:agentic-memory:memory.write"]);
  });

  it("an unknown token is refused and reaches no workspace", async () => {
    const inspector = new Inspector();
    const calls: string[] = [];
    wire(inspector, "A", "tok-a", calls);
    wire(inspector, "B", "tok-b", calls);
    const port = await serve(inspector);

    const res = await post(port, "/internal/controller-api/call", { action: "x" }, { authorization: "Bearer tok-z" });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("a token matching two workspaces fails closed", async () => {
    const inspector = new Inspector();
    const calls: string[] = [];
    wire(inspector, "A", "same", calls);
    wire(inspector, "B", "same", calls);
    const port = await serve(inspector);

    const res = await post(port, "/internal/controller-api/call", { action: "x" }, { authorization: "Bearer same" });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("the webhook stream is authorized against the token's workspace", async () => {
    const inspector = new Inspector();
    wire(inspector, "A", "tok-a", []);
    wire(inspector, "B", "tok-b", []);
    const port = await serve(inspector);
    // Right token, wrong MCP name → refused; the token decides ownership.
    const res = await fetch(`http://127.0.0.1:${port}/internal/webhook/stream?mcp=crm`, { headers: { authorization: "Bearer tok-a" } });
    expect(res.status).toBe(403);
  });
});

describe("the event stream", () => {
  async function firstEvent(port: number, query = ""): Promise<Record<string, unknown>> {
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/events${query}`, { signal: ac.signal });
    const reader = res.body!.getReader();
    let buf = "";
    while (!buf.includes("\n\n")) buf += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    return JSON.parse(buf.slice(buf.indexOf("data: ") + 6, buf.indexOf("\n\n")));
  }

  it("is scoped to the named workspace and lists every workspace", async () => {
    const inspector = new Inspector();
    wire(inspector, "A", "tok-a", []);
    wire(inspector, "B", "tok-b", []);
    const port = await serve(inspector);

    const snap = await firstEvent(port, "?ws=B");
    expect(snap.kind).toBe("snapshot");
    expect(snap.ws).toBe("B");
    expect(snap.controllerUrl).toBe("https://B.example");
    expect((snap.workspaces as Array<{ id: string }>).map((w) => w.id)).toEqual(["A", "B"]);
  });

  it("with zero workspaces it still opens, with an empty list", async () => {
    const port = await serve(new Inspector());
    const snap = await firstEvent(port);
    expect(snap.workspaces).toEqual([]);
    expect(snap.ws).toBeUndefined();
  });
});
