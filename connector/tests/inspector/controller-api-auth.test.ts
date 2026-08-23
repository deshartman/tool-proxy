import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

// v1.4 — Controller API calls (Twilio-bundled only). Two gates stand
// between a bundled MCP's loopback POST and the tunnel: (1) the same
// per-MCP bearer token webhook ingress reuses (resolveMcpByWebhookToken),
// (2) isAuthorTwilio — only Twilio-authored bundled MCPs may call this
// route, never a customer drop-in. Small route harness that mirrors
// production auth shape without dragging in the whole Inspector class
// (same approach as webhook-stream-auth.test.ts).

function makeHarness(
  tokenTable: Map<string, string>,
  twilioAuthored: Set<string>,
  coordinatorCall: (mcp: string, action: string, params: unknown) => Promise<unknown>,
) {
  const resolveMcpByWebhookToken = (token: string): string | undefined => {
    for (const [tok, mcp] of tokenTable) {
      if (tok === token) return mcp;
    }
    return undefined;
  };
  const isAuthorTwilio = (mcp: string): boolean => twilioAuthored.has(mcp);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const header = req.headers["authorization"];
    const auth = typeof header === "string" ? header : Array.isArray(header) ? header[0] : "";
    const m = /^Bearer\s+(.+)$/i.exec(auth ?? "");
    const token = m?.[1]?.trim();
    const mcp = token ? resolveMcpByWebhookToken(token) : undefined;
    if (!mcp) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { code: "not_authorized", message: "invalid or missing bearer token" } }));
      return;
    }
    if (!isAuthorTwilio(mcp)) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { code: "not_authorized", message: "MCP is not Twilio-authored" } }));
      return;
    }

    let raw = "";
    for await (const chunk of req) raw += chunk as Buffer;
    const body = raw ? JSON.parse(raw) : {};
    try {
      const result = await coordinatorCall(mcp, body.action, body.params);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ result }));
    } catch (err) {
      const code = (err as { code?: string }).code ?? "controller_error";
      res.statusCode = code === "tunnel_unavailable" ? 503 : 502;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { code, message: (err as Error).message } }));
    }
  };

  return { handle };
}

describe("Controller API call auth gate (v1.4)", () => {
  let server: Server;
  const port = 9094;
  const twilioToken = randomBytes(32).toString("base64url");
  const customerToken = randomBytes(32).toString("base64url");
  const tokens = new Map<string, string>([
    [twilioToken, "agentic-memory"],
    [customerToken, "crm"],
  ]);
  const twilioAuthored = new Set(["agentic-memory"]);
  const coordinatorCall = vi.fn().mockResolvedValue({ eventId: "evt_789" });

  beforeEach(async () => {
    coordinatorCall.mockClear();
    const { handle } = makeHarness(tokens, twilioAuthored, coordinatorCall);
    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/internal/controller-api/call" && req.method === "POST") {
          void handle(req, res);
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      server.listen(port, "127.0.0.1", () => resolve());
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("no token → 403", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/controller-api/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "memory.inject_context", params: {} }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("not_authorized");
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  it("token resolves to a customer-authored MCP → 403 not_authorized", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/controller-api/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ action: "memory.inject_context", params: {} }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("not_authorized");
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  it("token resolves to a twilio-authored MCP → request proceeds to the coordinator", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/controller-api/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${twilioToken}` },
      body: JSON.stringify({ action: "memory.inject_context", params: { customerId: "CU123" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toEqual({ eventId: "evt_789" });
    expect(coordinatorCall).toHaveBeenCalledWith("agentic-memory", "memory.inject_context", { customerId: "CU123" });
  });

  it("a tunnel_unavailable failure from the coordinator surfaces as 503, other failures as 502", async () => {
    coordinatorCall.mockRejectedValueOnce(Object.assign(new Error("no tunnel connected"), { code: "tunnel_unavailable" }));
    const unavailable = await fetch(`http://127.0.0.1:${port}/internal/controller-api/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${twilioToken}` },
      body: JSON.stringify({ action: "memory.inject_context", params: {} }),
    });
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.code).toBe("tunnel_unavailable");

    coordinatorCall.mockRejectedValueOnce(Object.assign(new Error("timed out"), { code: "timeout" }));
    const failed = await fetch(`http://127.0.0.1:${port}/internal/controller-api/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${twilioToken}` },
      body: JSON.stringify({ action: "memory.inject_context", params: {} }),
    });
    expect(failed.status).toBe(502);
    expect((await failed.json()).error.code).toBe("timeout");
  });
});
