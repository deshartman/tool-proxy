import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { randomBytes, generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { handleOutboundCalls } from "../../src/inspector/outbound-calls-route.js";
import { signHs256, type TrustedIssuerConfig } from "../../src/auth/jwt.js";
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
  // FEDERATED-JWT-MODE §4 — getVerifierConfig is read fresh per request; this
  // mutable field lets a test point the verifier at a federated (RS256) trust
  // config. Defaults to undefined, so the HS256-only cases below are
  // unaffected by the verifierConfig → getVerifierConfig rename.
  let trustedIssuer: TrustedIssuerConfig | undefined;

  function validToken(sub = "client_abc"): string {
    return signHs256({ sub }, signingKey, 3600);
  }

  beforeEach(async () => {
    coordinatorCall.mockReset();
    trustedIssuer = undefined;
    coordinator = { call: coordinatorCall } as unknown as ControllerApiCoordinator;
    server = createServer((req, res) => {
      void handleOutboundCalls(req, res, {
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

  // FEDERATED-JWT-MODE §4 — an RS256 bearer is accepted only when
  // getVerifierConfig returns a matching trustedIssuer. Stub JWKS setup mirrors
  // tests/auth/federated-jwt.test.ts: sign with a test-only RSA keypair, serve
  // the public half over a tiny http.createServer, point the trust config at it.
  describe("federated RS256 bearers", () => {
    let jwksServer: Server;
    let jwksUrl: string;
    let privateKey: KeyObject;
    const kid = "test-key-1";
    const issuer = "https://idp.example.com";
    const audience = "mcp-connector";

    function b64url(input: Buffer | string): string {
      return Buffer.from(input).toString("base64url");
    }

    function signRs256(claims: Record<string, unknown>): string {
      const header = { alg: "RS256", typ: "JWT", kid };
      const now = Math.floor(Date.now() / 1000);
      const payload = { sub: "machine-caller", iss: issuer, aud: audience, iat: now, exp: now + 3600, ...claims };
      const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
      const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
      return `${signingInput}.${b64url(signature)}`;
    }

    beforeAll(async () => {
      const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      privateKey = pair.privateKey;
      const jwk = pair.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
      const publicJwk = { ...jwk, kid, use: "sig", alg: "RS256" };
      jwksServer = createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ keys: [publicJwk] }));
      });
      await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", () => resolve()));
      jwksUrl = `http://127.0.0.1:${(jwksServer.address() as { port: number }).port}/jwks.json`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
    });

    it("valid RS256 bearer with matching trustedIssuer → 200, coordinator called with the JWT sub", async () => {
      trustedIssuer = { issuer, jwksUrl, audience };
      coordinatorCall.mockResolvedValueOnce({ callSid: "CA-fed" });
      const res = await post(validBody, { authorization: `Bearer ${signRs256({ sub: "fed-caller" })}` });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: { callSid: "CA-fed" } });
      expect(coordinatorCall.mock.calls[0][0]).toBe("machine-api:fed-caller");
    });

    it("RS256 bearer with mismatched aud → 401", async () => {
      trustedIssuer = { issuer, jwksUrl, audience };
      const res = await post(validBody, { authorization: `Bearer ${signRs256({ aud: "someone-else" })}` });
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("not_authorized");
      expect(coordinatorCall).not.toHaveBeenCalled();
    });

    it("RS256 bearer with mismatched iss → 401", async () => {
      trustedIssuer = { issuer, jwksUrl, audience };
      const res = await post(validBody, { authorization: `Bearer ${signRs256({ iss: "https://evil.example.com" })}` });
      expect(res.status).toBe(401);
      expect(coordinatorCall).not.toHaveBeenCalled();
    });

    it("RS256 bearer presented when federated mode is NOT configured → 401 (no verifier for this alg)", async () => {
      // trustedIssuer stays undefined (outer beforeEach) — federated never configured.
      const res = await post(validBody, { authorization: `Bearer ${signRs256({})}` });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("not_authorized");
      expect(body.error.message).toMatch(/no verifier configured/);
      expect(coordinatorCall).not.toHaveBeenCalled();
    });
  });
});
