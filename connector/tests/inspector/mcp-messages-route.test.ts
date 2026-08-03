import { describe, it, expect, beforeEach } from "vitest";
import { createServer, type AddressInfo } from "node:net";

import { Inspector, startInspector, type McpActions } from "@connector/inspector/server.js";

// HTTP-level tests for GET /mcp/messages, POST /mcp/messages/clear (the
// standalone "Clear" button — wipes the log without touching the child),
// and the "Restart clears history" contract (mirrors boot/lifecycle.ts's
// mcpActions.restart, which calls inspector.clearMcpMessages(name) BEFORE
// supervisor.restart()). See .claude/plans/MCP-STATUS-DETAIL.md.

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

interface Harness {
  port: number;
  inspector: Inspector;
}

async function buildHarness(): Promise<Harness> {
  const inspector = new Inspector({ controllerUrl: "https://controller.example.com", state: "open" });
  // Mirrors boot/lifecycle.ts: restart clears the message log BEFORE the
  // (here, fake) respawn happens.
  inspector.mcpActions = {
    reloadCreds: async () => undefined,
    restart: async (name: string) => {
      inspector.clearMcpMessages(name);
    },
  } as McpActions;

  const port = await findFreePort();
  startInspector(port, inspector);
  await new Promise((r) => setTimeout(r, 20));

  return { port, inspector };
}

async function getJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

async function postRestart(port: number, mcp: string): Promise<{ status: number }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp/restart`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-inspector-request": "1" },
    body: JSON.stringify({ mcp }),
  });
  return { status: res.status };
}

async function postClear(
  port: number,
  mcp: string | undefined,
  opts: { csrf?: boolean } = { csrf: true },
): Promise<{ status: number }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp/messages/clear`, {
    method: "POST",
    headers: opts.csrf
      ? { "content-type": "application/json", "x-inspector-request": "1" }
      : { "content-type": "application/json" },
    body: JSON.stringify(mcp === undefined ? {} : { mcp }),
  });
  return { status: res.status };
}

describe("GET /mcp/messages", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  it("returns an empty list for an MCP with no recorded taps", async () => {
    const { status, body } = await getJson(harness.port, "/mcp/messages?mcp=foo");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, messages: [] });
  });

  it("returns 400 when the mcp query param is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${harness.port}/mcp/messages`);
    expect(res.status).toBe(400);
  });

  it("returns recorded taps for that MCP, and only that MCP", async () => {
    harness.inspector.recordMcpMessage({
      mcp: "foo", direction: "out", kind: "request", method: "callTool", payload: {}, ts: 1,
    });
    harness.inspector.recordMcpMessage({
      mcp: "bar", direction: "out", kind: "request", method: "callTool", payload: {}, ts: 2,
    });

    const { body } = await getJson(harness.port, "/mcp/messages?mcp=foo");
    expect(body).toMatchObject({ ok: true, messages: [{ mcp: "foo", ts: 1 }] });
  });

  it("Restart clears the message log for that MCP", async () => {
    harness.inspector.recordMcpMessage({
      mcp: "foo", direction: "out", kind: "request", method: "callTool", payload: {}, ts: 1,
    });
    let before = await getJson(harness.port, "/mcp/messages?mcp=foo");
    expect((before.body as { messages: unknown[] }).messages).toHaveLength(1);

    const restart = await postRestart(harness.port, "foo");
    expect(restart.status).toBe(202);

    const after = await getJson(harness.port, "/mcp/messages?mcp=foo");
    expect(after.body).toEqual({ ok: true, messages: [] });
  });

  it("Restart on one MCP does not clear another MCP's log", async () => {
    harness.inspector.recordMcpMessage({
      mcp: "foo", direction: "out", kind: "request", method: "callTool", payload: {}, ts: 1,
    });
    harness.inspector.recordMcpMessage({
      mcp: "bar", direction: "out", kind: "request", method: "callTool", payload: {}, ts: 2,
    });

    await postRestart(harness.port, "foo");

    const fooAfter = await getJson(harness.port, "/mcp/messages?mcp=foo");
    const barAfter = await getJson(harness.port, "/mcp/messages?mcp=bar");
    expect((fooAfter.body as { messages: unknown[] }).messages).toHaveLength(0);
    expect((barAfter.body as { messages: unknown[] }).messages).toHaveLength(1);
  });
});

describe("POST /mcp/messages/clear", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  it("clears the log for that MCP without touching the child process (no mcpActions round-trip)", async () => {
    harness.inspector.recordMcpMessage({
      mcp: "foo", direction: "out", kind: "request", method: "callTool", payload: {}, ts: 1,
    });

    const clear = await postClear(harness.port, "foo");
    expect(clear.status).toBe(202);

    const after = await getJson(harness.port, "/mcp/messages?mcp=foo");
    expect(after.body).toEqual({ ok: true, messages: [] });
  });

  it("works even when inspector.mcpActions is entirely unset", async () => {
    const inspector = new Inspector({ controllerUrl: "https://controller.example.com", state: "open" });
    inspector.recordMcpMessage({ mcp: "foo", direction: "out", kind: "request", method: "callTool", payload: {}, ts: 1 });
    const port = await findFreePort();
    startInspector(port, inspector);
    await new Promise((r) => setTimeout(r, 20));

    const clear = await postClear(port, "foo");
    expect(clear.status).toBe(202);
    expect(inspector.getMcpMessages("foo")).toEqual([]);
  });

  it("does not clear another MCP's log", async () => {
    harness.inspector.recordMcpMessage({
      mcp: "foo", direction: "out", kind: "request", method: "callTool", payload: {}, ts: 1,
    });
    harness.inspector.recordMcpMessage({
      mcp: "bar", direction: "out", kind: "request", method: "callTool", payload: {}, ts: 2,
    });

    await postClear(harness.port, "foo");

    expect(harness.inspector.getMcpMessages("foo")).toHaveLength(0);
    expect(harness.inspector.getMcpMessages("bar")).toHaveLength(1);
  });

  it("returns 400 when mcp is missing", async () => {
    const res = await postClear(harness.port, undefined);
    expect(res.status).toBe(400);
  });

  it("is rejected by the CSRF guard without the inspector-request header", async () => {
    harness.inspector.recordMcpMessage({
      mcp: "foo", direction: "out", kind: "request", method: "callTool", payload: {}, ts: 1,
    });

    const res = await postClear(harness.port, "foo", { csrf: false });
    expect(res.status).toBe(403);
    // CSRF-rejected request must not have cleared anything.
    expect(harness.inspector.getMcpMessages("foo")).toHaveLength(1);
  });
});
