import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { handleOutboundCalls } from "../../src/inspector/outbound-calls-route.js";
import { signHs256 } from "../../src/auth/jwt.js";
import type { ControllerApiCoordinator } from "../../src/tunnel/controller-api-coordinator.js";

// CONNECTOR-NETWORK-EXPOSURE step 9 — POST /v1/outbound/calls. Mirrors
// controller-api-auth.test.ts's small-harness-over-a-real-http.createServer
// approach: no DB, no full Inspector class, just the route handler wired
// directly against a real server so status codes and body shapes are
// exercised end to end. The coordinator is mocked (vi.fn) since its own
// wire behavior is pinned separately by controller-api-coordinator.test.ts.

describe("POST /v1/outbound/calls", () => {
  let server: Server;
  let port: number;
  const signingKey = randomBytes(32);
  const coordinatorCall = vi.fn();
  let coordinator: ControllerApiCoordinator | undefined;

  function validToken(sub = "client_abc"): string {
    return signHs256({ sub }, signingKey, 3600);
  }

  beforeEach(async () => {
    coordinatorCall.mockReset();
    coordinator = { call: coordinatorCall } as unknown as ControllerApiCoordinator;
    server = createServer((req, res) => {
      void handleOutboundCalls(req, res, {
        verifierConfig: { selfIssuedSigningKey: signingKey },
        getCoordinator: () => coordinator,
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/v1/outbound/calls`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  const validBody = { action: "place_call", to: "+15551234567", agentId: "agt_1", channelId: "chn_1" };

  it("no Authorization header → 401, coordinator never called", async () => {
    const res = await post(validBody);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("not_authorized");
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  it("garbage bearer → 401", async () => {
    const res = await post(validBody, { authorization: "Bearer not-a-real-token" });
    expect(res.status).toBe(401);
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  it("expired bearer → 401", async () => {
    const expired = signHs256({ sub: "client_abc" }, signingKey, -1);
    const res = await post(validBody, { authorization: `Bearer ${expired}` });
    expect(res.status).toBe(401);
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  it("valid bearer, no live tunnel → 503 tunnel_unavailable", async () => {
    coordinator = undefined;
    const res = await post(validBody, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("tunnel_unavailable");
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  it("valid bearer + place_call → coordinator called with machine-api:<sub> identity and wire action, 200 on success", async () => {
    coordinatorCall.mockResolvedValueOnce({ callSid: "CA123" });
    const res = await post(validBody, { authorization: `Bearer ${validToken("client_abc")}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { callSid: "CA123" } });
    expect(coordinatorCall).toHaveBeenCalledTimes(1);
    const [mcp, mcpId, action, params, timeoutMs] = coordinatorCall.mock.calls[0];
    expect(mcp).toBe("machine-api:client_abc");
    expect(mcpId).toBeUndefined();
    expect(action).toBe("outbound.place_call");
    expect(params).toMatchObject({ to: "+15551234567", agentId: "agt_1", channelId: "chn_1" });
    expect(typeof params.idempotencyKey).toBe("string");
    expect(timeoutMs).toBe(30_000);
  });

  it("send_message maps to the outbound.send_message wire action", async () => {
    coordinatorCall.mockResolvedValueOnce({ providerId: "SM123" });
    const res = await post({ ...validBody, action: "send_message" }, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(200);
    expect(coordinatorCall.mock.calls[0][2]).toBe("outbound.send_message");
  });

  it("caller-supplied idempotencyKey passes through unchanged", async () => {
    coordinatorCall.mockResolvedValueOnce({ callSid: "CA999" });
    await post({ ...validBody, idempotencyKey: "idem-fixed-1" }, { authorization: `Bearer ${validToken()}` });
    expect(coordinatorCall.mock.calls[0][3].idempotencyKey).toBe("idem-fixed-1");
  });

  it("invalid action value → 400, coordinator never called", async () => {
    const res = await post({ ...validBody, action: "delete_everything" }, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  it.each(["to", "agentId", "channelId"])("missing %s → 400, coordinator never called", async (field) => {
    const body = { ...validBody } as Record<string, unknown>;
    delete body[field];
    const res = await post(body, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(400);
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  it("a timeout-coded coordinator rejection surfaces as 502 passthrough", async () => {
    coordinatorCall.mockRejectedValueOnce(Object.assign(new Error("timed out"), { code: "timeout" }));
    const res = await post(validBody, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("timeout");
  });

  it("a tunnel_unavailable rejection from the coordinator itself (raced tunnel close) also surfaces as 503", async () => {
    coordinatorCall.mockRejectedValueOnce(Object.assign(new Error("tunnel closed"), { code: "tunnel_unavailable" }));
    const res = await post(validBody, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("tunnel_unavailable");
  });
});
