import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RegisterFrame, TunnelFrame } from "@mcp-shim/shared";
import { TunnelServerTransport } from "./tunnel-transport.js";
import { registry } from "./registry.js";
import { eventBus } from "./event-bus.js";

// Shared-secret tunnel auth.
//
// This is the registration / license / billing gate. In production the
// shared secret would be a per-customer JWT (or similar), issued at
// signup and validated here. The check happens at tunnel-open time, so
// an unauthorized shim never registers itself and never gets queries.
//
// If TUNNEL_AUTH_TOKEN is unset we skip auth — that keeps the local-dev
// flow zero-config. Production deployments MUST set the env var.
function tokenAuthOk(req: IncomingMessage): boolean {
  const expected = process.env.TUNNEL_AUTH_TOKEN;
  if (!expected) return true;
  const raw = req.headers["authorization"];
  if (typeof raw !== "string") return false;
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  if (!m) return false;
  const got = m[1];
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

// Accepts an inbound shim tunnel connection. The first NDJSON line on the
// request body is expected to be a "register" frame. Everything after is
// MCP JSON-RPC traffic, handed off to a per-shim MCP Client.
export async function handleTunnelConnection(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("tunnel endpoint requires POST");
    return;
  }
  if (!tokenAuthOk(req)) {
    res.statusCode = 401;
    res.setHeader("www-authenticate", "Bearer");
    res.end("unauthorized");
    return;
  }

  res.statusCode = 200;
  res.setHeader("content-type", "application/x-ndjson");
  res.flushHeaders?.();

  let buffer = "";
  let registered = false;
  let shimId: string | null = null;

  req.setEncoding("utf8");

  // We can't pass control to the MCP Client until we've read the register frame,
  // so we consume bytes here until we see one newline, then construct the
  // transport and hand the rest of the data flow to it.
  const onData = (chunk: string) => {
    if (registered) return; // transport's own listener took over via swap below
    buffer += chunk;
    const idx = buffer.indexOf("\n");
    if (idx === -1) return;

    const line = buffer.slice(0, idx).trim();
    const remainder = buffer.slice(idx + 1);
    req.removeListener("data", onData);

    let frame: RegisterFrame;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type !== "register") {
        throw new Error(`expected register frame, got ${parsed.type}`);
      }
      frame = parsed as RegisterFrame;
    } catch (e) {
      console.error("[tunnel] invalid register frame:", e);
      res.end();
      return;
    }

    shimId = frame.shimId;
    registered = true;

    const t = new TunnelServerTransport(req, res);
    t.start().catch((e) => console.error("[tunnel] transport start error:", e));

    const client = new Client(
      { name: `main-server:${frame.shimId}`, version: "0.1.0" },
      { capabilities: {} }
    );

    // Demo-only: route inbound non-RPC frames (event/token) into the event bus.
    t.onframe = (f: TunnelFrame) => {
      if (f.type === "event") {
        eventBus.publish({
          source: f.source,
          panel: "shim",
          level: f.level,
          message: f.message,
          ts: f.ts,
        });
      } else if (f.type === "token") {
        eventBus.publishToken({
          kind: "token",
          queryId: f.queryId,
          source: f.source,
          seq: f.seq,
          delta: f.delta,
          done: f.done,
        });
      }
    };

    client
      .connect(t)
      .then(() => {
        registry.register({
          shimId: frame.shimId,
          procedures: frame.procedures,
          client,
          transport: t,
        });
        eventBus.publish({
          source: "main",
          panel: "cloud",
          level: "info",
          message: `shim connected: ${frame.shimId} (${frame.procedures.map((p) => p.id).join(", ")})`,
          ts: Date.now(),
        });
      })
      .catch((e) => console.error(`[tunnel] MCP client connect failed for ${frame.shimId}:`, e));

    t.onclose = () => {
      if (shimId) {
        registry.unregister(shimId);
        eventBus.publish({
          source: "main",
          panel: "cloud",
          level: "info",
          message: `shim disconnected: ${shimId}`,
          ts: Date.now(),
        });
      }
    };

    t.feedInitialBuffer(remainder);
  };

  req.on("data", onData);

  req.on("close", () => {
    if (shimId) registry.unregister(shimId);
  });
}
