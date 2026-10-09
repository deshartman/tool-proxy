import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import { TunnelClient } from "../../src/tunnel/client.js";
import { createFrameRouter, type FrameRouterOpts } from "../../src/tunnel/frame-router.js";
import { PROTOCOL_VERSION } from "@gtmi/toolproxy-protocol";

// MULTI-PLATFORM-MCP Phase 1, connector side. Inbound frames are now checked
// against @gtmi/toolproxy-protocol — but LOG-ONLY: the frame is still delivered
// to onframe exactly as before. Strict validation against live traffic will
// surface drift the hand-written types tolerated, and a tunnel that worked
// yesterday must not break on that. These tests pin both halves: a violation
// is REPORTED, and the frame is STILL DELIVERED. Plus the version handshake.
//
// Real WebSocket server on an ephemeral port — never a fixed one (a fixed port
// collides with a running connector; see csrf-guard.test.ts on 9091).

interface Harness {
  client: TunnelClient;
  delivered: unknown[];
  violations: Array<{ type: string | undefined; error: string; issues: string[] }>;
  push: (frame: unknown) => Promise<void>;
  received: unknown[];
}

let server: Server | undefined;
let wss: WebSocketServer | undefined;
let client: TunnelClient | undefined;

afterEach(async () => {
  client?.close();
  wss?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = wss = client = undefined;
});

async function connect(): Promise<Harness> {
  server = createServer();
  wss = new WebSocketServer({ server, path: "/mcp-tunnel" });
  const received: unknown[] = [];
  let socket: ServerSocket | undefined;
  const ready = new Promise<void>((resolve) => {
    wss!.on("connection", (ws) => {
      socket = ws;
      ws.on("message", (data) => received.push(JSON.parse(String(data))));
      resolve();
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  client = new TunnelClient(`http://127.0.0.1:${port}`, "ts_test_bearer", "test");
  const delivered: unknown[] = [];
  const violations: Harness["violations"] = [];
  client.onframe = (f) => delivered.push(f);
  client.onschemaviolation = (v) => violations.push(v);
  await client.connect();
  await ready;

  const push = async (frame: unknown) => {
    socket!.send(JSON.stringify(frame));
    // Let the client's message handler run.
    for (let i = 0; i < 20 && delivered.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  };
  return { client, delivered, violations, push, received };
}

describe("inbound validation is log-only", () => {
  it("delivers a valid frame and reports nothing", async () => {
    const h = await connect();
    await h.push({ type: "heartbeat", ts: 1 });
    expect(h.delivered).toEqual([{ type: "heartbeat", ts: 1 }]);
    expect(h.violations).toEqual([]);
  });

  it("REPORTS a frame that breaks the schema — and STILL delivers it unchanged", async () => {
    const h = await connect();
    const drifted = { type: "heartbeat", ts: 1, unexpected: true };
    await h.push(drifted);
    expect(h.violations).toHaveLength(1);
    expect(h.violations[0].type).toBe("heartbeat");
    // Load-bearing: log-only must not change what the connector acts on.
    expect(h.delivered).toEqual([drifted]);
  });

  it("never puts a field value into the violation report", async () => {
    const h = await connect();
    const secret = "sk_live_must_not_appear_123";
    await h.push({ type: "creds-response", requestId: "r", env: { API_KEY: secret }, source: "not-a-source" });
    expect(h.violations).toHaveLength(1);
    expect(JSON.stringify(h.violations)).not.toContain(secret);
    expect(h.delivered).toHaveLength(1);
  });

  it("tolerates a newer-minor controller once its protocol is known", async () => {
    const h = await connect();
    h.client.peerProtocol = { major: 1, minor: 7 };
    await h.push({ type: "heartbeat", ts: 1, addedInAFutureMinor: "x" });
    expect(h.violations).toEqual([]);
    expect(h.delivered).toHaveLength(1);
  });
});

describe("tunnel-protocol handshake", () => {
  it("register-ack's supportedTunnelProtocol reaches onPeerProtocol", () => {
    const ranges: Array<{ min: string; max: string }> = [];
    const noop = () => undefined;
    const router = createFrameRouter({
      webhooks: { setTunnelOpen: noop, reallocateAll: noop, onAllocateAck: noop, dispatch: noop } as unknown as FrameRouterOpts["webhooks"],
      tokenRef: { current: "tok" },
      onPeerProtocol: (r) => ranges.push(r),
      inspector: undefined,
      reconnect: { markAccepted: noop, markRejected: noop } as unknown as FrameRouterOpts["reconnect"],
      log: { info: noop, warn: noop, error: noop } as unknown as FrameRouterOpts["log"],
      connectorName: "test",
    });
    router({ type: "register-ack", accepted: true, supportedTunnelProtocol: { min: "1.0", max: "1.4" } });
    expect(ranges).toEqual([{ min: "1.0", max: "1.4" }]);
  });

  it("an ack from a controller that predates the field leaves the peer unknown", () => {
    const ranges: unknown[] = [];
    const noop = () => undefined;
    const router = createFrameRouter({
      webhooks: { setTunnelOpen: noop, reallocateAll: noop, onAllocateAck: noop, dispatch: noop } as unknown as FrameRouterOpts["webhooks"],
      tokenRef: { current: "tok" },
      onPeerProtocol: (r) => ranges.push(r),
      inspector: undefined,
      reconnect: { markAccepted: noop, markRejected: noop } as unknown as FrameRouterOpts["reconnect"],
      log: { info: noop, warn: noop, error: noop } as unknown as FrameRouterOpts["log"],
      connectorName: "test",
    });
    router({ type: "register-ack", accepted: true });
    expect(ranges).toEqual([]);
  });

  it("the connector speaks the package's protocol version", () => {
    // lifecycle.ts sends `tunnelProtocol: PROTOCOL_VERSION` on register.
    expect(PROTOCOL_VERSION).toBe("1.0");
  });
});
