import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ConfigStore } from "../../src/config-store/index.js";
import { initSodium } from "../../src/config-store/seal.js";
import { randomBytes, createHash } from "node:crypto";
import pg from "pg";

// FEDERATED-JWT-MODE — trusted_issuer_config round trip against a real
// Postgres schema (no mocking), mirroring network-access-state.test.ts.
// Presence of all three columns = configured; absence = undefined. Not
// sealed — issuer/JWKS URL/audience are public IdP metadata.

describe("ConfigStore — trusted issuer config", () => {
  const TEST_SCHEMA = "test_mcp_connector_trustedissuer_" + Date.now();
  let store: ConfigStore | undefined;
  let pool: pg.Pool;
  let masterKey: { bytes: Buffer; fingerprint: string };

  const sample = { issuer: "https://idp.example.com", jwksUrl: "https://idp.example.com/.well-known/jwks.json", audience: "mcp-connector" };

  beforeAll(async () => {
    const url = process.env.POSTGRES_URL;
    if (!url) {
      throw new Error("POSTGRES_URL must be set for this integration test.");
    }
    await initSodium();
    const keyBytes = randomBytes(32);
    masterKey = { bytes: keyBytes, fingerprint: createHash("sha256").update(keyBytes).digest("hex") };

    process.env.POSTGRES_SCHEMA = TEST_SCHEMA;
    pool = new pg.Pool({ connectionString: url });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
  });

  afterAll(async () => {
    if (store) {
      await store.close();
      store = undefined;
    }
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await pool.end();
    }
    delete process.env.POSTGRES_SCHEMA;
  });

  beforeEach(async () => {
    if (store) {
      await store.close();
      store = undefined;
    }
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.trusted_issuer_config CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.network_access CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.api_clients CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.controllers CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.encryption_meta CASCADE`);
    store = await ConfigStore.open(masterKey);
  });

  it("getTrustedIssuerConfig() returns undefined when unset", async () => {
    expect(await store!.getTrustedIssuerConfig()).toBeUndefined();
  });

  it("setTrustedIssuerConfig() persists and round-trips", async () => {
    await store!.setTrustedIssuerConfig(sample);
    expect(await store!.getTrustedIssuerConfig()).toEqual(sample);
  });

  it("a second setTrustedIssuerConfig() overwrites (upsert, not duplicate insert)", async () => {
    await store!.setTrustedIssuerConfig(sample);
    const next = { issuer: "https://other.example.com", jwksUrl: "https://other.example.com/jwks", audience: "other-aud" };
    await store!.setTrustedIssuerConfig(next);
    expect(await store!.getTrustedIssuerConfig()).toEqual(next);
  });

  it("clearTrustedIssuerConfig() returns it to undefined", async () => {
    await store!.setTrustedIssuerConfig(sample);
    expect(await store!.getTrustedIssuerConfig()).toEqual(sample);
    await store!.clearTrustedIssuerConfig();
    expect(await store!.getTrustedIssuerConfig()).toBeUndefined();
  });
});
