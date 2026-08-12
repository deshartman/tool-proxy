import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { handleIdentityFind, handleIdentityList } from "../../src/inspector/identity-routes.js";
import { signHs256, type TrustedIssuerConfig } from "../../src/auth/jwt.js";
import type { ControllerApiCoordinator } from "../../src/tunnel/controller-api-coordinator.js";

// MEMORY-INJECTION (2026-08-12 contract change) — POST /v1/identity/find and
// POST /v1/identity/list, the resolve half of memory injection's
// resolve-then-write flow. Same harness as memory-events-route.test.ts and
// outbound-calls-route.test.ts: real http.createServer, mocked coordinator.
//
// The federated (RS256) bearer path is not re-tested here — it lives in the
// shared verifyAccessToken layer, pinned by outbound-calls-route.test.ts and
// tests/auth/federated-jwt.test.ts. What's specific to these two routes and
// pinned below:
//   - `identity: null` from find is a 200, NOT a 404 (it means "we've never
//     spoken to this customer", a normal answer with a correct alternative).
//   - `channel` is required on find, optional on list, and enumerated locally
//     (the one place these routes don't pass a value through opaquely).
//   - list omits `limit` unless supplied — no connector-side default page size,
//     because a silent cap is the exact failure the controller refused to ship.
//   - list defaults to a higher timeout than find and accepts a clamped
//     caller override; find passes none at all.

describe("identity machine-API routes", () => {
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
    const deps = {
      getVerifierConfig: async () => ({ selfIssuedSigningKey: signingKey, trustedIssuer }),
      getCoordinator: () => coordinator,
    };
    server = createServer((req, res) => {
      if (req.url === "/v1/identity/find") void handleIdentityFind(req, res, deps);
      else void handleIdentityList(req, res, deps);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  const summary = {
    identityId: "idn_123",
    isTemp: false,
    provider: "postgres",
    externalRef: "idn_123",
    aliases: [{ channel: "phone", value: "+15555550123" }],
    lastEngagedAt: "2026-08-01T00:00:00Z",
    sessionCount: 3,
  };

  describe("POST /v1/identity/find", () => {
    const validBody = { identifier: "+15555550123", channel: "phone" };

    it.each([
      ["no Authorization header", {}],
      ["garbage bearer", { authorization: "Bearer nope" }],
    ])("%s → 401, coordinator never called", async (_label, headers) => {
      const res = await post("/v1/identity/find", validBody, headers);
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("not_authorized");
      expect(coordinatorCall).not.toHaveBeenCalled();
    });

    it("expired bearer → 401", async () => {
      const expired = signHs256({ sub: "client_abc" }, signingKey, -1);
      const res = await post("/v1/identity/find", validBody, { authorization: `Bearer ${expired}` });
      expect(res.status).toBe(401);
      expect(coordinatorCall).not.toHaveBeenCalled();
    });

    const badBodies: Array<[string, unknown]> = [
      ["missing identifier", { channel: "phone" }],
      ["identifier non-string", { identifier: 15555550123, channel: "phone" }],
      ["identifier empty", { identifier: "", channel: "phone" }],
      ["identifier whitespace only", { identifier: "   ", channel: "phone" }],
      ["missing channel — required, never derived", { identifier: "+15555550123" }],
      ["channel non-string", { identifier: "+1555", channel: 7 }],
      // A caller guess the controller explicitly refuses on input: test-harness
      // is a controller-internal construct that can only APPEAR in a returned
      // aliases array. Naming the valid set locally beats an opaque round trip.
      ["channel test-harness", { identifier: "x", channel: "test-harness" }],
      // Retired wire values from the pre-2026-08-12 9-value channel enum: these
      // folded onto kinds internally and are not lookup kinds.
      ["channel sms", { identifier: "+1555", channel: "sms" }],
      ["channel voice", { identifier: "+1555", channel: "voice" }],
      ["channel whatsapp", { identifier: "+1555", channel: "whatsapp" }],
      ["unknown field", { identifier: "+1555", channel: "phone", value: "+1555" }],
      ["retired customer field", { customer: "+15555550123", channel: "phone" }],
    ];

    it.each(badBodies)("%s → 400 bad_request, coordinator never called", async (_label, body) => {
      const res = await post("/v1/identity/find", body, { authorization: `Bearer ${validToken()}` });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
      expect(coordinatorCall).not.toHaveBeenCalled();
    });

    it.each(["phone", "email", "webchat-uid"])("channel=%s is accepted and forwarded", async (channel) => {
      coordinatorCall.mockResolvedValueOnce({ identity: summary });
      const res = await post("/v1/identity/find", { identifier: "x", channel }, { authorization: `Bearer ${validToken()}` });
      expect(res.status).toBe(200);
      expect(coordinatorCall.mock.calls[0][3]).toEqual({ identifier: "x", channel });
    });

    it("resolves → 200 with the IdentitySummary and the machine-api audit identity", async () => {
      coordinatorCall.mockResolvedValueOnce({ identity: summary });
      const res = await post("/v1/identity/find", validBody, { authorization: `Bearer ${validToken("client_xyz")}` });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: { identity: summary } });
      const [mcp, mcpId, action, params, timeoutMs] = coordinatorCall.mock.calls[0];
      expect(mcp).toBe("machine-api:client_xyz");
      expect(mcpId).toBeUndefined();
      expect(action).toBe("identity.find");
      expect(params).toEqual({ identifier: "+15555550123", channel: "phone" });
      // find is an exact single-row lookup — the coordinator's 8s default is
      // enough, so no override is passed.
      expect(timeoutMs).toBeUndefined();
    });

    // The single most important assertion in this file. `identity: null` means
    // "we have no record of this customer" — a legitimate state with a correct
    // alternative (place the call with the fact in callContext instead, since
    // there's no conversation history to prepend to). Translating it into a 404
    // would push callers toward logging-and-dropping a normal answer, and read
    // as "injection is broken for new customers".
    it("identity: null is a 200, NOT a 404 — an unknown customer is a normal answer", async () => {
      coordinatorCall.mockResolvedValueOnce({ identity: null });
      const res = await post("/v1/identity/find", validBody, { authorization: `Bearer ${validToken()}` });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: { identity: null } });
    });

    it("identifier is trimmed before forwarding", async () => {
      coordinatorCall.mockResolvedValueOnce({ identity: null });
      await post("/v1/identity/find", { identifier: "  +15555550123  ", channel: "phone" }, { authorization: `Bearer ${validToken()}` });
      expect(coordinatorCall.mock.calls[0][3].identifier).toBe("+15555550123");
    });

    it("no live tunnel → 503 tunnel_unavailable", async () => {
      coordinator = undefined;
      const res = await post("/v1/identity/find", validBody, { authorization: `Bearer ${validToken()}` });
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe("tunnel_unavailable");
      expect(coordinatorCall).not.toHaveBeenCalled();
    });

    it.each([
      ["invalid_params", 502],
      ["cross_account", 502],
      ["timeout", 502],
      ["unknown_action", 502],
      ["tunnel_unavailable", 503],
    ])("a %s rejection surfaces as %i", async (code, status) => {
      coordinatorCall.mockRejectedValueOnce(Object.assign(new Error("nope"), { code }));
      const res = await post("/v1/identity/find", validBody, { authorization: `Bearer ${validToken()}` });
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe(code);
    });
  });

  describe("POST /v1/identity/list", () => {
    it("no Authorization header → 401", async () => {
      const res = await post("/v1/identity/list", {});
      expect(res.status).toBe(401);
      expect(coordinatorCall).not.toHaveBeenCalled();
    });

    const badBodies: Array<[string, unknown]> = [
      ["match non-string", { match: 7 }],
      ["channel not in the enum", { channel: "sms" }],
      ["limit non-number", { limit: "10" }],
      ["timeoutMs non-number", { timeoutMs: "30000" }],
      ["unknown field", { cursor: "abc" }],
    ];

    it.each(badBodies)("%s → 400 bad_request, coordinator never called", async (_label, body) => {
      const res = await post("/v1/identity/list", body, { authorization: `Bearer ${validToken()}` });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
      expect(coordinatorCall).not.toHaveBeenCalled();
    });

    // THE guard on the controller's no-silent-cap decision: the connector must
    // not substitute a default page size. An empty body means "the whole
    // account", and 100 rows back must never be indistinguishable from "that's
    // all of them".
    it("an empty body forwards empty params — no connector-side default limit", async () => {
      coordinatorCall.mockResolvedValueOnce({ identities: [] });
      const res = await post("/v1/identity/list", {}, { authorization: `Bearer ${validToken()}` });
      expect(res.status).toBe(200);
      expect(coordinatorCall.mock.calls[0][3]).toEqual({});
      expect(Object.hasOwn(coordinatorCall.mock.calls[0][3], "limit")).toBe(false);
    });

    it("match / channel / limit are forwarded when supplied", async () => {
      coordinatorCall.mockResolvedValueOnce({ identities: [summary] });
      const res = await post(
        "/v1/identity/list",
        { match: "smith", channel: "email", limit: 25 },
        { authorization: `Bearer ${validToken()}` },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: { identities: [summary] } });
      const [mcp, mcpId, action, params] = coordinatorCall.mock.calls[0];
      expect(mcp).toBe("machine-api:client_abc");
      expect(mcpId).toBeUndefined();
      expect(action).toBe("identity.list");
      expect(params).toEqual({ match: "smith", channel: "email", limit: 25 });
    });

    // timeoutMs is a route-level knob, never forwarded as a controller param —
    // the controller's schema is .strict() and knows nothing about it.
    it("timeoutMs is consumed by the route, not forwarded to the controller", async () => {
      coordinatorCall.mockResolvedValueOnce({ identities: [] });
      await post("/v1/identity/list", { timeoutMs: 60_000 }, { authorization: `Bearer ${validToken()}` });
      expect(coordinatorCall.mock.calls[0][3]).toEqual({});
      expect(coordinatorCall.mock.calls[0][4]).toBe(60_000);
    });

    // list can walk the account's whole identity set, and a timeout yields
    // NOTHING rather than a partial — so the default is the higher of the two,
    // matching outbound.*'s 30s rather than inventing a third number.
    it("defaults to a 30s timeout, well above find's 8s default", async () => {
      coordinatorCall.mockResolvedValueOnce({ identities: [] });
      await post("/v1/identity/list", {}, { authorization: `Bearer ${validToken()}` });
      expect(coordinatorCall.mock.calls[0][4]).toBe(30_000);
    });

    // Clamped, not rejected — mirroring how the controller treats ttlSeconds on
    // inject. An out-of-range value is a caller misjudging their own account
    // size, not a malformed request.
    it.each([
      [1, 1_000],
      [500, 1_000],
      [45_000, 45_000],
      [500_000, 120_000],
      [0, 1_000],
      [-1, 1_000],
    ])("timeoutMs=%i clamps to %i", async (given, expected) => {
      coordinatorCall.mockResolvedValueOnce({ identities: [] });
      const res = await post("/v1/identity/list", { timeoutMs: given }, { authorization: `Bearer ${validToken()}` });
      expect(res.status).toBe(200);
      expect(coordinatorCall.mock.calls[0][4]).toBe(expected);
    });

    it("no live tunnel → 503 tunnel_unavailable", async () => {
      coordinator = undefined;
      const res = await post("/v1/identity/list", {}, { authorization: `Bearer ${validToken()}` });
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe("tunnel_unavailable");
    });

    // The documented large-account failure mode: exceed the window and you get
    // nothing, not a partial list.
    it("a timeout rejection surfaces as 502 passthrough", async () => {
      coordinatorCall.mockRejectedValueOnce(Object.assign(new Error("timed out"), { code: "timeout" }));
      const res = await post("/v1/identity/list", {}, { authorization: `Bearer ${validToken()}` });
      expect(res.status).toBe(502);
      expect((await res.json()).error.code).toBe("timeout");
    });
  });
});
