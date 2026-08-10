import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { handleMemoryEvents } from "../../src/inspector/memory-events-route.js";
import { signHs256, type TrustedIssuerConfig } from "../../src/auth/jwt.js";
import type { ControllerApiCoordinator } from "../../src/tunnel/controller-api-coordinator.js";

// MEMORY-INJECTION — POST /v1/memory/events. Same harness as
// outbound-calls-route.test.ts: no DB, no full Inspector class, just the route
// handler wired against a real http.createServer so status codes and body
// shapes are exercised end to end. The coordinator is mocked (vi.fn) since its
// wire behavior is pinned separately by controller-api-coordinator.test.ts.
//
// The federated (RS256) bearer path is NOT re-tested here — it lives entirely
// in the shared verifyAccessToken/getVerifierConfig layer, already pinned by
// outbound-calls-route.test.ts and tests/auth/federated-jwt.test.ts. This file
// covers what's specific to this route: its body validation, its refusal to
// mint an idempotencyKey, and its lack of a timeout override.

describe("POST /v1/memory/events", () => {
  let server: Server;
  let port: number;
  const signingKey = randomBytes(32);
  const coordinatorCall = vi.fn();
  let coordinator: ControllerApiCoordinator | undefined;
  let trustedIssuer: TrustedIssuerConfig | undefined;

  function validToken(sub = "client_abc"): string {
    return signHs256({ sub }, signingKey, 3600);
  }

  beforeEach(async () => {
    coordinatorCall.mockReset();
    trustedIssuer = undefined;
    coordinator = { call: coordinatorCall } as unknown as ControllerApiCoordinator;
    server = createServer((req, res) => {
      void handleMemoryEvents(req, res, {
        getVerifierConfig: async () => ({ selfIssuedSigningKey: signingKey, trustedIssuer }),
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
    return fetch(`http://127.0.0.1:${port}/v1/memory/events`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  const validBody = { identity: { channel: "sms", value: "+15555550123" }, event: "your flight is delayed" };

  it("no Authorization header → 401, coordinator never called", async () => {
    const res = await post(validBody);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("not_authorized");
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  it("garbage bearer → 401", async () => {
    const res = await post(validBody, { authorization: "Bearer not-a-real-token" });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("not_authorized");
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  it("bearer signed with the wrong key → 401", async () => {
    const foreign = signHs256({ sub: "client_abc" }, randomBytes(32), 3600);
    const res = await post(validBody, { authorization: `Bearer ${foreign}` });
    expect(res.status).toBe(401);
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  it("expired bearer → 401", async () => {
    const expired = signHs256({ sub: "client_abc" }, signingKey, -1);
    const res = await post(validBody, { authorization: `Bearer ${expired}` });
    expect(res.status).toBe(401);
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  // Body validation — presence + type only. Each case must 400 BEFORE the
  // coordinator is touched.
  const badBodies: Array<[string, unknown]> = [
    ["missing identity", { event: "e" }],
    ["identity not an object", { identity: "sms:+1555", event: "e" }],
    ["identity.channel non-string", { identity: { channel: 7, value: "+1555" }, event: "e" }],
    ["identity.channel empty string", { identity: { channel: "", value: "+1555" }, event: "e" }],
    ["identity.channel whitespace only", { identity: { channel: "   ", value: "+1555" }, event: "e" }],
    ["identity.value missing", { identity: { channel: "sms" }, event: "e" }],
    ["identity.value empty string", { identity: { channel: "sms", value: "" }, event: "e" }],
    ["missing event", { identity: { channel: "sms", value: "+1555" } }],
    ["event empty string", { identity: { channel: "sms", value: "+1555" }, event: "" }],
    ["event whitespace only", { identity: { channel: "sms", value: "+1555" }, event: "  " }],
    ["occurredAt non-string", { ...{ identity: { channel: "sms", value: "+1555" }, event: "e" }, occurredAt: 12345 }],
    ["idempotencyKey non-string", { ...{ identity: { channel: "sms", value: "+1555" }, event: "e" }, idempotencyKey: 99 }],
    ["type not a known memory store", { ...{ identity: { channel: "sms", value: "+1555" }, event: "e" }, type: "procedural" }],
    ["type misspelled", { ...{ identity: { channel: "sms", value: "+1555" }, event: "e" }, type: "semmantic" }],
    ["type non-string", { ...{ identity: { channel: "sms", value: "+1555" }, event: "e" }, type: 3 }],
  ];

  it.each(badBodies)("%s → 400 bad_request, coordinator never called", async (_label, body) => {
    const res = await post(body, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  // The inverse of the cases above, and the one that pins the
  // single-source-of-truth decision: the 9-value IDENTITY_CHANNEL_KINDS enum
  // lives on the CONTROLLER. A well-formed body with a nonsense channel must
  // pass this route's gate and reach the tunnel, where the controller answers
  // invalid_params. If this test ever fails, someone copied the enum into the
  // connector and created a second copy to keep in sync.
  it("unknown identity.channel is NOT rejected locally — it reaches the coordinator", async () => {
    coordinatorCall.mockResolvedValueOnce({ identityId: "id_1", stored: true });
    const body = { identity: { channel: "telepathy", value: "brainwave-7" }, event: "a fact" };
    const res = await post(body, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(200);
    expect(coordinatorCall).toHaveBeenCalledTimes(1);
    expect(coordinatorCall.mock.calls[0][3].identity).toEqual({ channel: "telepathy", value: "brainwave-7" });
  });

  // Memory types. Unlike identity.channel, `type` IS enumerated
  // connector-side — a bad channel fails loudly downstream (identity won't
  // resolve, nothing is written) while a bad type could write into the wrong
  // store and be noticed only when a recall comes back missing the fact. The
  // 400 cases above pin the enum; these pin the accepted values and the
  // omitted-by-default behavior.
  describe("memory types", () => {
    it.each(["episodic", "semantic", "working"])("type=%s forwards verbatim", async (type) => {
      coordinatorCall.mockResolvedValueOnce({ identityId: "idn_1", stored: true });
      const res = await post({ ...validBody, type }, { authorization: `Bearer ${validToken()}` });
      expect(res.status).toBe(200);
      expect(coordinatorCall.mock.calls[0][3].type).toBe(type);
    });

    // Back-compat with a controller that predates memory-type support: the
    // default case must send the exact params it always did, with no `type`
    // key at all — not `type: undefined`, and not a connector-side
    // "episodic" default. If this fails, an older controller with a strict
    // params schema starts rejecting every default-path call.
    it("omitted type is absent from the forwarded params, not defaulted to episodic", async () => {
      coordinatorCall.mockResolvedValueOnce({ identityId: "idn_1", stored: true });
      await post(validBody, { authorization: `Bearer ${validToken()}` });
      expect(Object.hasOwn(coordinatorCall.mock.calls[0][3], "type")).toBe(false);
    });

    it("the action is the same single wire action regardless of type", async () => {
      coordinatorCall.mockResolvedValueOnce({ identityId: "idn_1", stored: true });
      await post({ ...validBody, type: "semantic" }, { authorization: `Bearer ${validToken()}` });
      expect(coordinatorCall.mock.calls[0][2]).toBe("memory.append_event");
    });
  });

  it("valid bearer, no live tunnel → 503 tunnel_unavailable", async () => {
    coordinator = undefined;
    const res = await post(validBody, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("tunnel_unavailable");
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  it("valid bearer + coordinator resolves → 200 with the controller result", async () => {
    coordinatorCall.mockResolvedValueOnce({ identityId: "idn_123", stored: true });
    const res = await post(validBody, { authorization: `Bearer ${validToken("client_abc")}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { identityId: "idn_123", stored: true } });
    const [mcp, mcpId, action, params] = coordinatorCall.mock.calls[0];
    expect(mcp).toBe("machine-api:client_abc");
    expect(mcpId).toBeUndefined();
    expect(action).toBe("memory.append_event");
    expect(params).toEqual({ identity: { channel: "sms", value: "+15555550123" }, event: "your flight is delayed" });
  });

  // Delta #2 — unlike /v1/outbound/calls, this route NEVER mints an
  // idempotencyKey. The controller doesn't dedup memory writes in v1 and a
  // duplicate fact is low-harm, so an absent key stays absent on the wire.
  it("omitted idempotencyKey is absent from the forwarded params, not minted", async () => {
    coordinatorCall.mockResolvedValueOnce({ identityId: "idn_1", stored: true });
    await post(validBody, { authorization: `Bearer ${validToken()}` });
    const params = coordinatorCall.mock.calls[0][3];
    expect(Object.hasOwn(params, "idempotencyKey")).toBe(false);
    expect(Object.hasOwn(params, "occurredAt")).toBe(false);
  });

  it("caller-supplied idempotencyKey and occurredAt pass through verbatim", async () => {
    coordinatorCall.mockResolvedValueOnce({ identityId: "idn_1", stored: true });
    await post(
      { ...validBody, idempotencyKey: "k-123", occurredAt: "2026-08-11T10:00:00Z" },
      { authorization: `Bearer ${validToken()}` },
    );
    const params = coordinatorCall.mock.calls[0][3];
    expect(params.idempotencyKey).toBe("k-123");
    expect(params.occurredAt).toBe("2026-08-11T10:00:00Z");
  });

  // Delta #3 — no explicit timeout: memory.append_event is a fast
  // identity-resolve + episodic write, so it inherits the coordinator's 8s
  // default instead of outbound.*'s 30s LLM-turn ceiling.
  it("passes no timeoutMs override — inherits the coordinator default", async () => {
    coordinatorCall.mockResolvedValueOnce({ identityId: "idn_1", stored: true });
    await post(validBody, { authorization: `Bearer ${validToken()}` });
    expect(coordinatorCall.mock.calls[0][4]).toBeUndefined();
  });

  it("a timeout-coded coordinator rejection surfaces as 502 passthrough", async () => {
    coordinatorCall.mockRejectedValueOnce(Object.assign(new Error("timed out"), { code: "timeout" }));
    const res = await post(validBody, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("timeout");
  });

  it("an invalid_params rejection from the controller surfaces as 502 passthrough", async () => {
    coordinatorCall.mockRejectedValueOnce(Object.assign(new Error("unknown channel"), { code: "invalid_params" }));
    const res = await post(validBody, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("invalid_params");
  });

  it("a tunnel_unavailable rejection from the coordinator itself (raced tunnel close) surfaces as 503", async () => {
    coordinatorCall.mockRejectedValueOnce(Object.assign(new Error("tunnel closed"), { code: "tunnel_unavailable" }));
    const res = await post(validBody, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("tunnel_unavailable");
  });
});
