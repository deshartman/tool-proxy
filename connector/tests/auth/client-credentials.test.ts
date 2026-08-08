import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import pg from "pg";
import { ConfigStore } from "../../src/config-store/index.js";
import { initSodium } from "../../src/config-store/seal.js";
import { handleOauthToken } from "../../src/inspector/oauth-token-route.js";
import { deriveJwtSigningKey, verifyAccessToken, verifyHs256 } from "../../src/auth/jwt.js";

// CONNECTOR-NETWORK-EXPOSURE — self-issued client_credentials grant.
// Mirrors oauth-provider-hardening.test.ts's describe/it structure, but for
// the ISSUING side: valid creds → JWT; wrong/unknown client → identical
// invalid_client shape (RFC 6749 §5.2); the issued JWT verifies against the
// same unified verifier a route consuming it would use; expiry + revocation
// behave per the plan's stated v1 scope (no forced early revocation of
// already-issued tokens).

describe("POST /oauth/token — self-issued client_credentials", () => {
  const TEST_SCHEMA = "test_mcp_connector_oauth_" + Date.now();
  let store: ConfigStore;
  let pool: pg.Pool;
  let masterKey: { bytes: Buffer; fingerprint: string };
  let signingKey: Buffer;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const url = process.env.POSTGRES_URL;
    if (!url) {
      throw new Error("POSTGRES_URL must be set for this integration test.");
    }
    await initSodium();
    const keyBytes = randomBytes(32);
    masterKey = { bytes: keyBytes, fingerprint: createHash("sha256").update(keyBytes).digest("hex") };
    signingKey = deriveJwtSigningKey(masterKey.bytes);

    process.env.POSTGRES_SCHEMA = TEST_SCHEMA;
    pool = new pg.Pool({ connectionString: url });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.api_clients CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.network_access CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.controllers CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.encryption_meta CASCADE`);
  });

  afterAll(async () => {
    await store?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await pool.end();
    delete process.env.POSTGRES_SCHEMA;
  });

  beforeEach(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.api_clients CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.network_access CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.controllers CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.encryption_meta CASCADE`);
    store = await ConfigStore.open(masterKey);

    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((req, res) => {
      void handleOauthToken(req, res, { configStore: store, signingKey, expiresInSec: 3600 });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as { port: number }).port;
  });

  async function postToken(body: Record<string, string>): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  }

  it("valid client_id + client_secret returns a Bearer JWT", async () => {
    const { clientId, clientSecret } = await store.mintApiClient("integration-a");
    const res = await postToken({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.access_token).toBe("string");
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
  });

  it("wrong secret → 400 invalid_client", async () => {
    const { clientId } = await store.mintApiClient();
    const res = await postToken({ grant_type: "client_credentials", client_id: clientId, client_secret: "wrong" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_client");
  });

  it("unknown client_id → identical invalid_client shape (no leak vs wrong-secret)", async () => {
    const res = await postToken({ grant_type: "client_credentials", client_id: "no-such-client", client_secret: "anything" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_client");
  });

  it("unsupported grant_type is rejected", async () => {
    const { clientId, clientSecret } = await store.mintApiClient();
    const res = await postToken({ grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("unsupported_grant_type");
  });

  it("the returned JWT verifies against the same unified verifier the outbound route will use", async () => {
    const { clientId, clientSecret } = await store.mintApiClient();
    const res = await postToken({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
    const { access_token } = await res.json();
    const result = await verifyAccessToken(access_token, { selfIssuedSigningKey: signingKey });
    expect(result.valid).toBe(true);
    expect(result.claims?.sub).toBe(clientId);
  });

  it("an expired JWT is rejected by the verifier", async () => {
    const { clientId, clientSecret } = await store.mintApiClient();
    const server2 = createServer((req, res) => {
      void handleOauthToken(req, res, { configStore: store, signingKey, expiresInSec: -1 });
    });
    await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", () => resolve()));
    const p2 = (server2.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${p2}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    });
    const { access_token } = await res.json();
    const result = verifyHs256(access_token, signingKey);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("expired");
    await new Promise<void>((resolve) => server2.close(() => resolve()));
  });

  it("a revoked client_id is rejected on its NEXT /oauth/token attempt", async () => {
    const { clientId, clientSecret } = await store.mintApiClient();
    expect(await store.revokeApiClient(clientId)).toBe(true);
    const res = await postToken({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_client");
  });

  it("a JWT already issued before revocation still verifies until its own natural expiry (no forced early revocation — explicit v1 non-goal)", async () => {
    const { clientId, clientSecret } = await store.mintApiClient();
    const res = await postToken({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
    const { access_token } = await res.json();

    await store.revokeApiClient(clientId);

    const result = verifyHs256(access_token, signingKey);
    expect(result.valid).toBe(true);
  });
});
