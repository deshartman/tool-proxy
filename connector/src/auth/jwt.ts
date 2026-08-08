// CONNECTOR-NETWORK-EXPOSURE — machine-API JWT sign + verify. node:crypto
// only, no new dependency (jsonwebtoken / jose) — matches this codebase's
// existing preference for direct primitives over frameworks (seal.ts,
// oauth-provider.ts). Two algorithms:
//   - HS256 for self-issued tokens: the connector is both issuer and only
//     verifier, so a shared HMAC key is sufficient — no asymmetric keypair
//     or JWKS-serving needed.
//   - RS256 for federated tokens: verified against the customer's own IdP
//     via its published JWKS. The connector never signs with this mode.
// Both funnel through verifyAccessToken() so a route consuming the result
// doesn't care which mode issued the token — same iss/aud/exp shape either
// way (federated additionally checks iss/aud; self-issued tokens skip that
// since there both roles live in this same process).

import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify, type KeyObject } from "node:crypto";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function base64urlDecodeJson<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
}

export interface AccessTokenClaims {
  sub: string;             // client_id
  iss?: string;
  aud?: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

export interface VerifyResult {
  valid: boolean;
  claims?: AccessTokenClaims;
  error?: string;
}

// Deterministically derives the HS256 signing key from the connector's
// existing master key — no new secret to mint, seal, or lose. Same key
// material backs seal()/open() for the sealed-secrets tables; this derives
// a distinct value via HMAC so a JWT signature leak can't be replayed
// against the master key itself.
export function deriveJwtSigningKey(masterKeyBytes: Buffer): Buffer {
  return createHmac("sha256", masterKeyBytes).update("mcp-connector:jwt-signing-key:v1").digest();
}

export function signHs256(claims: { sub: string; iss?: string; aud?: string }, signingKey: Buffer, expiresInSec: number): string {
  const iat = Math.floor(Date.now() / 1000);
  const fullClaims: AccessTokenClaims = { ...claims, sub: claims.sub, iat, exp: iat + expiresInSec };
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(fullClaims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", signingKey).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

export function verifyHs256(token: string, signingKey: Buffer): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, error: "malformed token" };
  const [encodedHeader, encodedPayload, signature] = parts;
  let header: { alg?: string };
  try { header = base64urlDecodeJson(encodedHeader); } catch { return { valid: false, error: "malformed header" }; }
  if (header.alg !== "HS256") return { valid: false, error: "unexpected alg" };
  const expected = createHmac("sha256", signingKey).update(`${encodedHeader}.${encodedPayload}`).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return { valid: false, error: "malformed signature" }; }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { valid: false, error: "signature mismatch" };
  }
  return checkClaims(encodedPayload);
}

export interface TrustedIssuerConfig {
  issuer: string;
  jwksUrl: string;
  audience: string;
}

interface JwksKey {
  kty: string;
  kid?: string;
  [key: string]: unknown;
}

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const jwksCache = new Map<string, { keys: JwksKey[]; fetchedAt: number }>();

async function fetchJwks(jwksUrl: string): Promise<JwksKey[]> {
  const cached = jwksCache.get(jwksUrl);
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) return cached.keys;
  const res = await fetch(jwksUrl);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: JwksKey[] };
  const keys = body.keys ?? [];
  jwksCache.set(jwksUrl, { keys, fetchedAt: Date.now() });
  return keys;
}

// Federated mode. The connector never signs with this — verify only,
// against whatever key the trust config's JWKS endpoint currently serves.
export async function verifyRs256WithJwks(token: string, config: TrustedIssuerConfig): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, error: "malformed token" };
  const [encodedHeader, encodedPayload, signature] = parts;
  let header: { alg?: string; kid?: string };
  try { header = base64urlDecodeJson(encodedHeader); } catch { return { valid: false, error: "malformed header" }; }
  if (header.alg !== "RS256") return { valid: false, error: "unexpected alg" };

  let keys: JwksKey[];
  try { keys = await fetchJwks(config.jwksUrl); } catch (err) { return { valid: false, error: (err as Error).message }; }
  const jwk = header.kid ? keys.find((k) => k.kid === header.kid) : keys[0];
  if (!jwk) return { valid: false, error: "no matching JWKS key" };

  // The JWK arrives at runtime from a remote JWKS endpoint — its shape
  // isn't statically known, so this one call goes through `any` rather
  // than fighting node:crypto's narrow JsonWebKey type. try/catch below is
  // the real safety net for a malformed or unsupported key.
  let publicKey: KeyObject;
  try { publicKey = createPublicKey({ key: jwk, format: "jwk" } as Parameters<typeof createPublicKey>[0]); }
  catch { return { valid: false, error: "invalid JWKS key" }; }

  let sigBuf: Buffer;
  try { sigBuf = Buffer.from(signature, "base64url"); } catch { return { valid: false, error: "malformed signature" }; }
  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`);
  let ok: boolean;
  try { ok = cryptoVerify("RSA-SHA256", signingInput, publicKey, sigBuf); }
  catch { return { valid: false, error: "signature verification failed" }; }
  if (!ok) return { valid: false, error: "signature mismatch" };

  const result = checkClaims(encodedPayload);
  if (!result.valid) return result;
  if (result.claims!.iss !== config.issuer) return { valid: false, error: "iss mismatch" };
  if (result.claims!.aud !== config.audience) return { valid: false, error: "aud mismatch" };
  return result;
}

function checkClaims(encodedPayload: string): VerifyResult {
  let claims: AccessTokenClaims;
  try { claims = base64urlDecodeJson(encodedPayload); }
  catch { return { valid: false, error: "malformed payload" }; }
  if (typeof claims.exp !== "number" || Date.now() >= claims.exp * 1000) {
    return { valid: false, error: "expired" };
  }
  return { valid: true, claims };
}

export interface JwtVerifierConfig {
  // Self-issued (default). Present whenever /oauth/token issuance is live
  // — which is always, since it's derived from the master key at boot.
  selfIssuedSigningKey?: Buffer;
  // Federated. Present only when the operator has configured a trusted
  // issuer (see boot/network-access-config.ts). Both may be set at once —
  // "Both modes can coexist" — dispatch is by the token's own `alg` header.
  trustedIssuer?: TrustedIssuerConfig;
}

// Unified verifier consumed by any route gating on a machine-API bearer
// (the OAuth2 token endpoint's own issued tokens, and the future outbound-
// calls route). Same iss/aud/exp check regardless of which mode issued the
// token — the caller doesn't need to know which one it was.
export async function verifyAccessToken(token: string, config: JwtVerifierConfig): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, error: "malformed token" };
  let header: { alg?: string };
  try { header = base64urlDecodeJson(parts[0]); } catch { return { valid: false, error: "malformed header" }; }
  if (header.alg === "HS256" && config.selfIssuedSigningKey) {
    return verifyHs256(token, config.selfIssuedSigningKey);
  }
  if (header.alg === "RS256" && config.trustedIssuer) {
    return verifyRs256WithJwks(token, config.trustedIssuer);
  }
  return { valid: false, error: "no verifier configured for this token's algorithm" };
}
