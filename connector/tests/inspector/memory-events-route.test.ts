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
//
// Wire contract per the controller's memory.inject_context (see
// architectural-plans/MEMORY-INJECTION-CONTRACT-CHANGE.md): the write targets
// WORKING memory, keyed (accountId, agentId, identityKey), so agentId is
// required. It takes an OPAQUE identityId resolved beforehand via
// POST /v1/identity/find — never an address. Two earlier shapes are retired and
// both are pinned as rejected below: a nested identity: { channel, value } pair,
// and a flat `customer` string. There is no memory-tier selector — the `type`
// field was cancelled outright, and the controller's schema is .strict(), so
// this route mirrors that strictness rather than silently dropping stray keys.

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

  const validBody = {
    agentId: "agt_1",
    identityId: "idn_123",
    event: "your flight is delayed",
  };

  const ok = { stored: true, expiresAt: "2026-08-12T10:10:00Z" };

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
  const core = { agentId: "agt_1", identityId: "idn_123", event: "e" };
  const badBodies: Array<[string, unknown]> = [
    ["missing agentId", { identityId: core.identityId, event: "e" }],
    ["agentId non-string", { ...core, agentId: 7 }],
    ["agentId empty string", { ...core, agentId: "" }],
    ["agentId whitespace only", { ...core, agentId: "   " }],
    ["missing identityId", { agentId: "agt_1", event: "e" }],
    ["identityId non-string", { ...core, identityId: 123 }],
    ["identityId empty string", { ...core, identityId: "" }],
    ["identityId whitespace only", { ...core, identityId: "   " }],
    ["missing event", { agentId: "agt_1", identityId: core.identityId }],
    ["event empty string", { ...core, event: "" }],
    ["event whitespace only", { ...core, event: "  " }],
    ["occurredAt non-string", { ...core, occurredAt: 12345 }],
    ["ttlSeconds non-number", { ...core, ttlSeconds: "600" }],
    ["idempotencyKey non-string", { ...core, idempotencyKey: 99 }],
    // Stray keys are rejected, not silently dropped — the controller's schema is
    // .strict() for the same reason. Each of these was considered and refused
    // for this action, and a caller still sending one should be told rather than
    // handed a 200 that ignored it.
    ["cancelled type field", { ...core, type: "working" }],
    ["channelId, which this action never takes", { ...core, channelId: "chn_1" }],
    ["retired identity pair", { ...core, identity: { channel: "sms", value: "+15555550123" } }],
    ["a typo'd field name", { ...core, evnet: "oops" }],
  ];

  it.each(badBodies)("%s → 400 bad_request, coordinator never called", async (_label, body) => {
    const res = await post(body, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  // THE regression guard for the 2026-08-12 contract change. This route used to
  // take an address and let the controller resolve it, and that resolve was
  // find-or-CREATE — so a typo minted a phantom identity, silently. Address
  // input is gone; a caller still on the old contract must be told, loudly,
  // rather than have `customer` dropped and the write attempted without it.
  it.each([
    ["retired flat customer string", { ...core, customer: "+15555550123" }],
    ["customer INSTEAD of identityId", { agentId: "agt_1", customer: "+15555550123", event: "e" }],
    ["customer as an email", { ...core, customer: "someone@example.com" }],
  ])("%s → 400, never forwarded", async (_label, body) => {
    const res = await post(body, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe("bad_request");
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  // The inverse: identityId is an OPAQUE controller handle, so this route must
  // not pattern-check it. If the controller's id format changes, valid handles
  // must keep flowing. A value that happens to look like a phone number is not
  // special-cased either — it's just a (wrong) id, and the controller answers.
  it.each(["idn_123", "01J8ZQ7YB4", "+15555550123", "someone@example.com", "any-opaque-string"])(
    "identityId=%s is forwarded verbatim, never shape-checked",
    async (identityId) => {
      coordinatorCall.mockResolvedValueOnce(ok);
      const res = await post({ ...validBody, identityId }, { authorization: `Bearer ${validToken()}` });
      expect(res.status).toBe(200);
      expect(coordinatorCall).toHaveBeenCalledTimes(1);
      expect(coordinatorCall.mock.calls[0][3].identityId).toBe(identityId);
    },
  );

  it("valid bearer, no live tunnel → 503 tunnel_unavailable", async () => {
    coordinator = undefined;
    const res = await post(validBody, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("tunnel_unavailable");
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  it("valid bearer + coordinator resolves → 200 with the controller result", async () => {
    coordinatorCall.mockResolvedValueOnce(ok);
    const res = await post(validBody, { authorization: `Bearer ${validToken("client_abc")}` });
    expect(res.status).toBe(200);
    // The result no longer echoes identityId — the caller supplied it. expiresAt
    // replaces it, because a clamped ttlSeconds has to be visible.
    expect(await res.json()).toEqual({ result: ok });
    const [mcp, mcpId, action, params] = coordinatorCall.mock.calls[0];
    expect(mcp).toBe("machine-api:client_abc");
    expect(mcpId).toBeUndefined();
    expect(action).toBe("memory.inject_context");
    expect(params).toEqual({ agentId: "agt_1", identityId: "idn_123", event: "your flight is delayed" });
  });

  // Unlike /v1/outbound/calls, this route NEVER mints an idempotencyKey. The
  // controller doesn't dedup memory writes in v1 and a duplicate fact is
  // low-harm, so an absent key stays absent on the wire.
  it("omitted optional fields are absent from the forwarded params, not minted or nulled", async () => {
    coordinatorCall.mockResolvedValueOnce(ok);
    await post(validBody, { authorization: `Bearer ${validToken()}` });
    const params = coordinatorCall.mock.calls[0][3];
    expect(Object.hasOwn(params, "idempotencyKey")).toBe(false);
    expect(Object.hasOwn(params, "occurredAt")).toBe(false);
    // Omitting ttlSeconds is how a caller asks for the controller's 600s
    // default, which equals its quietFlushMs — i.e. the pre-TTL behavior.
    expect(Object.hasOwn(params, "ttlSeconds")).toBe(false);
  });

  it("caller-supplied idempotencyKey, occurredAt and ttlSeconds pass through verbatim", async () => {
    coordinatorCall.mockResolvedValueOnce(ok);
    await post(
      { ...validBody, idempotencyKey: "k-123", occurredAt: "2026-08-12T10:00:00Z", ttlSeconds: 3600 },
      { authorization: `Bearer ${validToken()}` },
    );
    const params = coordinatorCall.mock.calls[0][3];
    expect(params.idempotencyKey).toBe("k-123");
    expect(params.occurredAt).toBe("2026-08-12T10:00:00Z");
    expect(params.ttlSeconds).toBe(3600);
  });

  // ttlSeconds is guarded on `!== undefined`, NOT truthiness, and that
  // distinction is load-bearing: the controller REJECTS 0 with invalid_params.
  // A truthiness guard would drop the 0 and silently substitute the 600s
  // default, so the caller would never learn they asked for something invalid.
  it("ttlSeconds: 0 is forwarded, not dropped as falsy — the controller rejects it, and the caller must find out", async () => {
    coordinatorCall.mockResolvedValueOnce(ok);
    await post({ ...validBody, ttlSeconds: 0 }, { authorization: `Bearer ${validToken()}` });
    const params = coordinatorCall.mock.calls[0][3];
    expect(Object.hasOwn(params, "ttlSeconds")).toBe(true);
    expect(params.ttlSeconds).toBe(0);
  });

  // Range is entirely the controller's rule, and it's ASYMMETRIC: above 86400
  // is clamped (200 + a corrected expiresAt), while 0 / negative / fractional
  // are rejected with invalid_params. This route forwards all of them unchanged
  // and predicts neither outcome — duplicating the rule would 400 values the
  // controller would have clamped, and give a second copy to drift.
  //
  // So this test asserts FORWARDING, not acceptance. A 200 here is the mocked
  // coordinator answering, not a claim that the controller accepts the value.
  it.each([
    [86_401, "clamped controller-side"],
    [999_999, "clamped controller-side"],
    [-5, "rejected controller-side as invalid_params"],
    [0.5, "rejected controller-side as invalid_params"],
  ])("ttlSeconds=%s is forwarded verbatim (%s), never range-checked locally", async (ttlSeconds) => {
    coordinatorCall.mockResolvedValueOnce(ok);
    const res = await post({ ...validBody, ttlSeconds }, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(200);
    expect(coordinatorCall.mock.calls[0][3].ttlSeconds).toBe(ttlSeconds);
  });

  // ... and when the controller does reject one, the connector passes the code
  // straight through rather than reinterpreting it.
  it("an out-of-range ttlSeconds rejected by the controller surfaces as 502 invalid_params", async () => {
    coordinatorCall.mockRejectedValueOnce(Object.assign(new Error("ttlSeconds must be a positive integer"), { code: "invalid_params" }));
    const res = await post({ ...validBody, ttlSeconds: 0 }, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("invalid_params");
  });

  // memory.inject_context is a fast identity-resolve plus row write with no LLM
  // turn, so it inherits the coordinator's 8s default instead of
  // outbound.*'s 30s LLM-turn ceiling.
  it("passes no timeoutMs override — inherits the coordinator default", async () => {
    coordinatorCall.mockResolvedValueOnce(ok);
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
    coordinatorCall.mockRejectedValueOnce(Object.assign(new Error("bad params"), { code: "invalid_params" }));
    const res = await post(validBody, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("invalid_params");
  });

  // Both agentId and identityId are checked against the tunnel session's
  // account, and a merged (dead) identity handle is refused the same way — so
  // cross_account is the expected code for a foreign id, NOT invalid_params.
  it("a cross_account rejection surfaces as 502 passthrough", async () => {
    coordinatorCall.mockRejectedValueOnce(Object.assign(new Error("agent not in account"), { code: "cross_account" }));
    const res = await post(validBody, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("cross_account");
  });

  it("a tunnel_unavailable rejection from the coordinator itself (raced tunnel close) surfaces as 503", async () => {
    coordinatorCall.mockRejectedValueOnce(Object.assign(new Error("tunnel closed"), { code: "tunnel_unavailable" }));
    const res = await post(validBody, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("tunnel_unavailable");
  });
});
