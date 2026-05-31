import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RawData, WebSocket } from "ws";
import type { RegisterFrame, TunnelFrame } from "@mcp-shim/shared";
import { TunnelServerTransport } from "./tunnel-transport.js";
import { registry } from "./registry.js";
import { eventBus } from "./event-bus.js";

function wsDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

// Shared-secret tunnel auth.
//
// This is the registration / license / billing gate. In production the
// shared secret would be a per-customer JWT (or similar), issued at signup
// and validated here. The check happens at WS handshake time (during the
// HTTP upgrade), so an unauthorized shim never opens a WebSocket and never
// gets queries.
//
// If TUNNEL_AUTH_TOKEN is unset we skip auth — that keeps the local-dev
// flow zero-config. Production deployments MUST set the env var.
export function tokenAuthOk(req: IncomingMessage): boolean {
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

// Wraps a freshly-upgraded WebSocket. The first message is expected to be
// a "register" frame; everything after is MCP JSON-RPC traffic, handed off
// to a per-shim MCP Client.
export function acceptTunnel(ws: WebSocket): void {
  let shimId: string | null = null;

  const onFirstMessage = (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      ws.close(1003, "expected text register frame");
      return;
    }
    ws.off("message", onFirstMessage);

    let frame: RegisterFrame;
    try {
      const parsed = JSON.parse(wsDataToString(data));
      if (parsed.type !== "register") {
        throw new Error(`expected register frame, got ${parsed.type}`);
      }
      frame = parsed as RegisterFrame;
    } catch (e) {
      console.error("[tunnel] invalid register frame:", e);
      ws.close(1002, "invalid register frame");
      return;
    }

    shimId = frame.shimId;

    const t = new TunnelServerTransport(ws);
    t.start().catch((e) => console.error("[tunnel] transport start error:", e));

    const client = new Client(
      { name: `main-server:${frame.shimId}`, version: "0.1.0" },
      { capabilities: {} }
    );

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
  };

  ws.on("message", onFirstMessage);
  ws.on("close", () => {
    if (shimId) registry.unregister(shimId);
  });
}
