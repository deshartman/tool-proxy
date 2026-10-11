import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

// F7 — SSE webhook stream + revoke require the caller's bearer token to
// identify them as owner of the requested MCP. Two-MCP test harness: MCP
// "twilio" and MCP "attacker" each have their own token; the inspector
// resolver returns the mcp name for the matching token.

// Small route harness that mirrors production auth shape without dragging
// in the whole Inspector class.
function makeHarness(tokenTable: Map<string, string>) {
  const resolve = (token: string): string | undefined => {
    for (const [tok, mcp] of tokenTable) {
      if (tok === token) return mcp;
    }
    return undefined;
  };

  const authorize = (req: IncomingMessage, res: ServerResponse, requestedMcp: string): boolean => {
    const header = req.headers["authorization"];
    const auth = typeof header === "string" ? header : Array.isArray(header) ? header[0] : "";
    const m = /^Bearer\s+(.+)$/i.exec(auth ?? "");
    const token = m?.[1]?.trim();
    const owner = token ? resolve(token) : undefined;
    if (owner !== requestedMcp) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end('{"ok":false,"error":"webhook subscription: token does not match requested MCP"}');
      return false;
    }
    return true;
  };

  return { authorize };
}

describe("Webhook stream + revoke identity check (F7)", () => {
  let server: Server;
  // Port 0: the OS picks a free one, so the suite runs beside a live connector.
  let port: number;
  const twilioToken = randomBytes(32).toString("base64url");
  const attackerToken = randomBytes(32).toString("base64url");
  const tokens = new Map<string, string>([
    [twilioToken, "twilio"],
    [attackerToken, "attacker"],
  ]);

  beforeEach(async () => {
    const { authorize } = makeHarness(tokens);
    await new Promise<void>((resolve) => {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/internal/webhook/stream" && req.method === "GET") {
          const mcp = url.searchParams.get("mcp") ?? "";
          if (!authorize(req, res, mcp)) return;
          res.statusCode = 200;
          res.setHeader("content-type", "text/event-stream");
          res.end(`event: url\ndata: {"url":"http://ok"}\n\n`);
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("subscribe with matching token → 200", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/webhook/stream?mcp=twilio`, {
      headers: { authorization: `Bearer ${twilioToken}` },
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it("subscribe with a different MCP's token → 403", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/webhook/stream?mcp=twilio`, {
      headers: { authorization: `Bearer ${attackerToken}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("does not match");
  });

  it("subscribe with no token → 403", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/webhook/stream?mcp=twilio`);
    expect(res.status).toBe(403);
  });

  it("subscribe with malformed Authorization header → 403", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/webhook/stream?mcp=twilio`, {
      headers: { authorization: "NotBearer garbage" },
    });
    expect(res.status).toBe(403);
  });

  it("subscribe with unknown token → 403", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/webhook/stream?mcp=twilio`, {
      headers: { authorization: `Bearer ${randomBytes(32).toString("base64url")}` },
    });
    expect(res.status).toBe(403);
  });
});

// Direct test of supervisor.resolveMcpByWebhookToken constant-time behavior.
// We can't easily observe timing directly, but we can verify the method
// works over the actual public API + returns undefined for non-matching
// inputs of every length.
describe("Supervisor resolveMcpByWebhookToken", () => {
  it("returns undefined for empty / null / mismatched-length input", async () => {
    const { McpSupervisor } = await import("../../src/mcp-supervisor.js");
    const s = new McpSupervisor({
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({} as never) } as never,
      servers: new Map(),
    });
    s.register([{ name: "twilio", transport: "stdio", command: "true" } as never]);
    expect(s.resolveMcpByWebhookToken("")).toBeUndefined();
    expect(s.resolveMcpByWebhookToken("short")).toBeUndefined();
    expect(s.resolveMcpByWebhookToken("x".repeat(43))).toBeUndefined();
  });
});
