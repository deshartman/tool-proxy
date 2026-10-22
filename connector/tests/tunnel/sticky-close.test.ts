import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

import { TunnelClient } from "../../src/tunnel/client.js";
import { isStickyClose } from "../../src/tunnel/reconnect.js";
import { FRAME_SCHEMA_MISMATCH_CLOSE } from "@gtmi/toolproxy-protocol";

// A controller that ENFORCES schema validation closes the socket with 4422
// frame_schema_mismatch when it refuses a frame. Before this fix the proxy's
// close handler ignored the close code entirely, so the reconnect policy only
// went sticky on a register-ack ERROR — and under enforcement a refused
// register gets no ack at all. The proxy would have reconnected forever,
// re-sending the same invalid frame each time.
//
// Pinned at both seams: TunnelClient REPORTS the real close code from a real
// WebSocket server, and the policy treats 4422 — and only 4422 — as sticky.

let server: Server | undefined;
let wss: WebSocketServer | undefined;
let client: TunnelClient | undefined;

afterEach(async () => {
  client?.close();
  wss?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = wss = client = undefined;
});

async function closeWith(code: number, reason: string): Promise<{ code: number; reason: string }> {
  server = createServer();
  wss = new WebSocketServer({ server, path: "/mcp-tunnel" });
  wss.on("connection", (ws) => ws.close(code, reason));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  client = new TunnelClient(`http://127.0.0.1:${port}`, "ts_test", "test");
  const closed = new Promise<{ code: number; reason: string }>((resolve) => { client!.onclose = resolve; });
  await client.connect();
  return closed;
}

describe("TunnelClient reports the controller's close code", () => {
  it("passes 4422 frame_schema_mismatch through to onclose", async () => {
    const info = await closeWith(4422, "frame_schema_mismatch");
    expect(info).toEqual({ code: 4422, reason: "frame_schema_mismatch" });
  });

  it("passes other close codes through unchanged", async () => {
    const info = await closeWith(4401, "unknown_registration_token");
    expect(info).toEqual({ code: 4401, reason: "unknown_registration_token" });
  });
});

describe("isStickyClose — which closes stop auto-reconnect", () => {
  it("the shared constant is 4422", () => {
    expect(FRAME_SCHEMA_MISMATCH_CLOSE).toBe(4422);
  });

  it("4422 is sticky", () => {
    expect(isStickyClose(4422, FRAME_SCHEMA_MISMATCH_CLOSE)).toBe(true);
  });

  // The guard against over-correcting into "any 4xxx is sticky". 4401
  // unknown_registration_token MUST stay self-healing: a controller DB reset
  // relies on it to re-mint every connector with no human involvement.
  it.each([
    [4401, "unknown_registration_token (must self-heal)"],
    [4403, "controller-initiated close"],
    [4409, "name_taken — sticky via the register-ack path, not this one"],
    [4400, "missing_name_or_token"],
    [1000, "normal close"],
    [1006, "abnormal close / network drop"],
  ])("%i (%s) is NOT made sticky by the close code", (code) => {
    expect(isStickyClose(code, FRAME_SCHEMA_MISMATCH_CLOSE)).toBe(false);
  });
});
