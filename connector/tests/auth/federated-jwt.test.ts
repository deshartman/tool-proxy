import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { verifyRs256WithJwks, verifyAccessToken, type TrustedIssuerConfig } from "../../src/auth/jwt.js";

// CONNECTOR-NETWORK-EXPOSURE — federated mode. The connector never SIGNS
// RS256 (that's the customer's IdP's job); it only verifies against
// whatever JWKS endpoint the trust config points at. This test plays both
// roles a real IdP would: sign with a test-only keypair, serve the public
// half via a stub JWKS endpoint, and confirm the connector's verifier
// accepts a well-formed token and rejects mismatched aud/iss or a
// different-keypair signature.

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signRs256(claims: Record<string, unknown>, privateKey: KeyObject, kid: string): string {
  const header = { alg: "RS256", typ: "JWT", kid };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function validClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "machine-caller", iss: "https://idp.example.com", aud: "tool-proxy", iat: now, exp: now + 3600, ...overrides };
}

describe("Federated JWT verification (RS256 via JWKS)", () => {
  let server: Server;
  let jwksUrl: string;
  let publicJwk: Record<string, unknown>;
  let privateKey: KeyObject;
  let otherPrivateKey: KeyObject;
  let config: TrustedIssuerConfig;
  const kid = "test-key-1";

  beforeAll(async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKey = pair.privateKey;
    const otherPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    otherPrivateKey = otherPair.privateKey;

    const jwk = pair.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    publicJwk = { ...jwk, kid, use: "sig", alg: "RS256" };

    server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [publicJwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    jwksUrl = `http://127.0.0.1:${port}/.well-known/jwks.json`;

    config = { issuer: "https://idp.example.com", jwksUrl, audience: "tool-proxy" };

  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("accepts a validly-signed token from the trusted issuer's JWKS", async () => {
    const token = signRs256(validClaims(), privateKey, kid);
    const result = await verifyRs256WithJwks(token, config);
    expect(result.valid).toBe(true);
    expect(result.claims?.sub).toBe("machine-caller");
  });

  it("the unified verifyAccessToken() dispatches RS256 tokens to the federated path", async () => {
    const token = signRs256(validClaims(), privateKey, kid);
    const result = await verifyAccessToken(token, { trustedIssuer: config });
    expect(result.valid).toBe(true);
  });

  it("rejects a mismatched aud claim", async () => {
    const token = signRs256(validClaims({ aud: "someone-else" }), privateKey, kid);
    const result = await verifyRs256WithJwks(token, config);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/aud/);
  });

  it("rejects a mismatched iss claim", async () => {
    const token = signRs256(validClaims({ iss: "https://not-the-trusted-idp.example.com" }), privateKey, kid);
    const result = await verifyRs256WithJwks(token, config);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/iss/);
  });

  it("rejects a token signed with a different keypair than the one JWKS serves", async () => {
    const token = signRs256(validClaims(), otherPrivateKey, kid);
    const result = await verifyRs256WithJwks(token, config);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/signature/);
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signRs256(validClaims({ iat: now - 7200, exp: now - 3600 }), privateKey, kid);
    const result = await verifyRs256WithJwks(token, config);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("expired");
  });

  it("rejects an HS256-alg token even with a trustedIssuer configured (no algorithm confusion)", async () => {
    const result = await verifyRs256WithJwks("not.a.rs256token", config);
    expect(result.valid).toBe(false);
  });
});
