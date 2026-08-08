import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ConfigStore } from "../../src/config-store/index.js";
import { initSodium } from "../../src/config-store/seal.js";
import { randomBytes, createHash } from "node:crypto";
import pg from "pg";

// CONNECTOR-NETWORK-EXPOSURE — network_access.enabled gates ONLY the
// machine API (POST /oauth/token) being reachable non-loopback. There is
// no admin secret / session concept — the operator UI stays loopback-only
// unconditionally, forever.

describe("ConfigStore — network access state + API clients", () => {
  const TEST_SCHEMA = "test_mcp_connector_netaccess_" + Date.now();
  let store: ConfigStore | undefined;
  let pool: pg.Pool;
  let masterKey: { bytes: Buffer; fingerprint: string };

  beforeAll(async () => {
    const url = process.env.POSTGRES_URL;
    if (!url) {
      throw new Error(
        "POSTGRES_URL must be set for this integration test. Example: postgres://ek:{PASSWORD}@localhost:5433/enterprise_knowledge"
      );
    }

    await initSodium();

    const keyBytes = randomBytes(32);
    const fingerprint = createHash("sha256").update(keyBytes).digest("hex");
    masterKey = { bytes: keyBytes, fingerprint };

    process.env.POSTGRES_SCHEMA = TEST_SCHEMA;

    pool = new pg.Pool({ connectionString: url });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.network_access CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.api_clients CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.controllers CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.encryption_meta CASCADE`);
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
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.network_access CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.api_clients CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.controllers CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.encryption_meta CASCADE`);
    }
    store = await ConfigStore.open(masterKey);
  });

  describe("getNetworkAccessState()", () => {
    it("returns disabled before anything is enabled", async () => {
      const state = await store!.getNetworkAccessState();
      expect(state).toEqual({ enabled: false });
    });
  });

  describe("setNetworkAccessEnabled()", () => {
    it("persists the enabled flag", async () => {
      await store!.setNetworkAccessEnabled(true);
      expect((await store!.getNetworkAccessState()).enabled).toBe(true);
      await store!.setNetworkAccessEnabled(false);
      expect((await store!.getNetworkAccessState()).enabled).toBe(false);
    });
  });

  describe("API clients", () => {
    it("mintApiClient() issues a client_id/client_secret pair that verifies", async () => {
      const { clientId, clientSecret } = await store!.mintApiClient("my-integration");
      expect(await store!.verifyApiClient(clientId, clientSecret)).toBe(true);
      expect(await store!.verifyApiClient(clientId, "wrong-secret")).toBe(false);
      expect(await store!.verifyApiClient("unknown-client-id", clientSecret)).toBe(false);
    });

    it("listApiClients() never returns secrets", async () => {
      await store!.mintApiClient("integration-a");
      const clients = await store!.listApiClients();
      expect(clients).toHaveLength(1);
      expect(clients[0].name).toBe("integration-a");
      expect((clients[0] as unknown as Record<string, unknown>).clientSecret).toBeUndefined();
    });

    it("revokeApiClient() disables future verification", async () => {
      const { clientId, clientSecret } = await store!.mintApiClient();
      expect(await store!.revokeApiClient(clientId)).toBe(true);
      expect(await store!.verifyApiClient(clientId, clientSecret)).toBe(false);
    });

    it("revokeApiClient() on an unknown or already-revoked client_id returns false", async () => {
      expect(await store!.revokeApiClient("nonexistent")).toBe(false);
      const { clientId } = await store!.mintApiClient();
      expect(await store!.revokeApiClient(clientId)).toBe(true);
      expect(await store!.revokeApiClient(clientId)).toBe(false);
    });
  });
});
