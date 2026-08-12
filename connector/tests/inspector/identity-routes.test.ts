import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import * as identityRoutes from "../../src/inspector/identity-routes.js";
import { handleIdentityList } from "../../src/inspector/identity-routes.js";
import { signHs256, type TrustedIssuerConfig } from "../../src/auth/jwt.js";
import type { ControllerApiCoordinator } from "../../src/tunnel/controller-api-coordinator.js";

// MEMORY-INJECTION — POST /v1/identity/list, the resolve half of memory
// injection's resolve-then-write flow. Same harness as memory-events-route.test.ts
// and outbound-calls-route.test.ts: real http.createServer, mocked coordinator.
//
// A sibling POST /v1/identity/find was covered here until the controller merged
// the two actions: list's `identifier` is a case-insensitive SUBSTRING, and an
// exact address is a substring of itself, so one predicate serves both browse and
// resolve. Its deletion is pinned below rather than merely uncovered, because a
// route that quietly comes back is how a dead action starts returning
// unknown_action to real callers.
//
// The federated (RS256) bearer path is not re-tested here — it lives in the
// shared verifyAccessToken layer, pinned by outbound-calls-route.test.ts and
// tests/auth/federated-jwt.test.ts. What's specific to this route and pinned:
//   - `identifier` replaced `match`, and the old name is REJECTED, not ignored.
//   - `channel` is optional (find needed it required; substring matching doesn't)
//     but still enumerated locally — the one value this route doesn't pass
//     through opaquely.
//   - `limit` is omitted unless supplied: no connector-side default page size,
//     because a silent cap is the exact failure the controller refused to ship.
//   - `timeoutMs` NEVER reaches params. The controller's schema is .strict() and
//     explicitly refuses it, so leaking it would be a hard error, not a shrug.
//   - An empty `identities` array is a 200 — it carries the meaning find's `null`
//     had, and turning it into a 4xx would push callers to drop a normal answer.

describe("POST /v1/identity/list", () => {
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
      void handleIdentityList(req, res, deps);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/v1/identity/list`, {
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

  // identity.find is GONE. Nothing may re-export a handler for it: the controller
  // deleted the action, so a resurrected route would forward a call that comes
  // back unknown_action. Cheaper to fail here than to debug that in the field.
  it("exports no find handler — identity.find was deleted controller-side", () => {
    expect(Object.keys(identityRoutes)).not.toContain("handleIdentityFind");
    expect(identityRoutes.createIdentityRoutes({
      getVerifierConfig: async () => ({ selfIssuedSigningKey: signingKey }),
      getCoordinator: () => coordinator,
    })).not.toHaveProperty("handleFind");
  });

  it("no Authorization header → 401", async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  it("garbage bearer → 401", async () => {
    const res = await post({}, { authorization: "Bearer not-a-real-token" });
    expect(res.status).toBe(401);
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  it("expired bearer → 401", async () => {
    const expired = signHs256({ sub: "client_abc" }, signingKey, -1);
    const res = await post({}, { authorization: `Bearer ${expired}` });
    expect(res.status).toBe(401);
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  const badBodies: Array<[string, unknown]> = [
    ["identifier non-string", { identifier: 7 }],
    ["channel not in the enum", { channel: "sms" }],
    ["channel = test-harness, which the controller refuses on input", { channel: "test-harness" }],
    ["limit non-number", { limit: "10" }],
    ["timeoutMs non-number", { timeoutMs: "30000" }],
    ["unknown field", { cursor: "abc" }],
    // The param's name until the find/list merge. Rejected rather than dropped —
    // silently ignoring it would run an unfiltered whole-account query while the
    // caller believed they had narrowed it.
    ["retired match field", { match: "smith" }],
  ];

  it.each(badBodies)("%s → 400 bad_request, coordinator never called", async (_label, body) => {
    const res = await post(body, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
    expect(coordinatorCall).not.toHaveBeenCalled();
  });

  it("the match→identifier rename is named in the error, not just rejected", async () => {
    const res = await post({ match: "smith" }, { authorization: `Bearer ${validToken()}` });
    expect((await res.json()).error.message).toContain("identifier");
  });

  it.each(["phone", "email", "webchat-uid"])("channel=%s is accepted and forwarded", async (channel) => {
    coordinatorCall.mockResolvedValueOnce({ identities: [] });
    const res = await post({ channel }, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(200);
    expect(coordinatorCall.mock.calls[0][3].channel).toBe(channel);
  });

  // channel is OPTIONAL here — find needed it REQUIRED because its equality
  // lookup ran against a kind-normalised column; ILIKE is case-insensitive on its
  // own and needs no kind. Absence must mean "any kind", never a 400.
  it("identifier without channel is accepted — substring matching needs no kind", async () => {
    coordinatorCall.mockResolvedValueOnce({ identities: [summary] });
    const res = await post({ identifier: "+15555550123" }, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(200);
    expect(coordinatorCall.mock.calls[0][3]).toEqual({ identifier: "+15555550123" });
  });

  // THE guard on the controller's no-silent-cap decision: the connector must not
  // substitute a default page size. An empty body means "the whole account", and
  // 100 rows back must never be indistinguishable from "that's all of them".
  it("an empty body forwards empty params — no connector-side default limit", async () => {
    coordinatorCall.mockResolvedValueOnce({ identities: [] });
    const res = await post({}, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(200);
    expect(coordinatorCall.mock.calls[0][3]).toEqual({});
    expect(Object.hasOwn(coordinatorCall.mock.calls[0][3], "limit")).toBe(false);
  });

  it("identifier / channel / limit are forwarded when supplied", async () => {
    coordinatorCall.mockResolvedValueOnce({ identities: [summary] });
    const res = await post(
      { identifier: "smith", channel: "email", limit: 25 },
      { authorization: `Bearer ${validToken()}` },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { identities: [summary] } });
    const [mcp, mcpId, action, params] = coordinatorCall.mock.calls[0];
    expect(mcp).toBe("machine-api:client_abc");
    expect(mcpId).toBeUndefined();
    expect(action).toBe("identity.list");
    expect(params).toEqual({ identifier: "smith", channel: "email", limit: 25 });
  });

  // An exact address is a substring of itself, so resolve runs through this same
  // param — and can legitimately return SEVERAL rows ("des@example.com" also
  // matches "des@example.com.au"). The connector passes the array through
  // untouched and never picks a winner; disambiguation belongs to the caller that
  // knows which address it asked about.
  it("a multi-row result is passed through verbatim, never narrowed to one", async () => {
    const other = { ...summary, identityId: "idn_456", aliases: [{ channel: "email", value: "des@example.com.au" }] };
    const exact = { ...summary, identityId: "idn_789", aliases: [{ channel: "email", value: "des@example.com" }] };
    coordinatorCall.mockResolvedValueOnce({ identities: [other, exact] });
    const res = await post({ identifier: "des@example.com" }, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(200);
    expect((await res.json()).result.identities).toEqual([other, exact]);
  });

  // Carries exactly the meaning the deleted find route's `identity: null` had.
  it("an empty identities array is a 200, NOT a 404 — an unknown customer is a normal answer", async () => {
    coordinatorCall.mockResolvedValueOnce({ identities: [] });
    const res = await post({ identifier: "+15550000000" }, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { identities: [] } });
  });

  // timeoutMs is a route-level knob. The controller's schema is .strict() and
  // explicitly REFUSES it (with a test pinning that refusal), so leaking it into
  // params would be a hard invalid_params, not a tolerated extra.
  it("timeoutMs is consumed by the route, never forwarded as a controller param", async () => {
    coordinatorCall.mockResolvedValueOnce({ identities: [] });
    await post({ timeoutMs: 60_000 }, { authorization: `Bearer ${validToken()}` });
    expect(coordinatorCall.mock.calls[0][3]).toEqual({});
    expect(Object.hasOwn(coordinatorCall.mock.calls[0][3], "timeoutMs")).toBe(false);
    expect(coordinatorCall.mock.calls[0][4]).toBe(60_000);
  });

  it("timeoutMs is stripped even when other fields are present", async () => {
    coordinatorCall.mockResolvedValueOnce({ identities: [] });
    await post(
      { identifier: "smith", channel: "email", limit: 5, timeoutMs: 45_000 },
      { authorization: `Bearer ${validToken()}` },
    );
    expect(coordinatorCall.mock.calls[0][3]).toEqual({ identifier: "smith", channel: "email", limit: 5 });
  });

  // list can walk the account's whole identity set, and a timeout yields NOTHING
  // rather than a partial — so it defaults well above the coordinator's 8s,
  // matching outbound.*'s 30s rather than inventing a third number.
  it("defaults to a 30s timeout, well above the coordinator's 8s", async () => {
    coordinatorCall.mockResolvedValueOnce({ identities: [] });
    await post({}, { authorization: `Bearer ${validToken()}` });
    expect(coordinatorCall.mock.calls[0][4]).toBe(30_000);
  });

  // Clamped, not rejected — an out-of-range value is a caller misjudging their
  // own account size, not a malformed request.
  it.each([
    [1, 1_000],
    [500, 1_000],
    [45_000, 45_000],
    [500_000, 120_000],
    [0, 1_000],
    [-1, 1_000],
  ])("timeoutMs=%i clamps to %i", async (given, expected) => {
    coordinatorCall.mockResolvedValueOnce({ identities: [] });
    const res = await post({ timeoutMs: given }, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(200);
    expect(coordinatorCall.mock.calls[0][4]).toBe(expected);
  });

  it("no live tunnel → 503 tunnel_unavailable", async () => {
    coordinator = undefined;
    const res = await post({}, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("tunnel_unavailable");
  });

  // The documented large-account failure mode: exceed the window and you get
  // nothing, not a partial list. The route surfaces it rather than retrying —
  // there's no cancellation path, so a retry stacks abandoned full-account scans.
  it("a timeout rejection surfaces as 502 passthrough", async () => {
    coordinatorCall.mockRejectedValueOnce(Object.assign(new Error("timed out"), { code: "timeout" }));
    const res = await post({}, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("timeout");
  });

  it("the route never retries a failed call", async () => {
    coordinatorCall.mockRejectedValueOnce(Object.assign(new Error("timed out"), { code: "timeout" }));
    await post({}, { authorization: `Bearer ${validToken()}` });
    expect(coordinatorCall).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["invalid_params", 502],
    ["cross_account", 502],
    ["controller_error", 502],
    ["tunnel_unavailable", 503],
  ])("a %s rejection surfaces as %i passthrough", async (code, status) => {
    coordinatorCall.mockRejectedValueOnce(Object.assign(new Error("nope"), { code }));
    const res = await post({}, { authorization: `Bearer ${validToken()}` });
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
  });
});
