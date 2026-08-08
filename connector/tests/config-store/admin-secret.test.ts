import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ConfigStore } from "../../src/config-store/index.js";
import { initSodium } from "../../src/config-store/seal.js";
import { randomBytes, createHash } from "node:crypto";
import pg from "pg";

describe("ConfigStore — admin secret + API clients (CONNECTOR-NETWORK-EXPOSURE)", () => {
  const TEST_SCHEMA = "test_mcp_connector_admin_" + Date.now();
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
    it("returns disabled/no-secret before anything is minted", async () => {
      const state = await store!.getNetworkAccessState();
      expect(state).toEqual({ enabled: false, hasSecret: false });
    });
  });

  describe("mintAdminSecret()", () => {
    it("generates a fresh secret when none exists", async () => {
      const { plaintext } = await store!.mintAdminSecret();
      expect(plaintext).toBeDefined();
      expect(plaintext!.length).toBeGreaterThan(20);
      const state = await store!.getNetworkAccessState();
      expect(state.hasSecret).toBe(true);
    });

    it("seals the secret at rest", async () => {
      const { plaintext } = await store!.mintAdminSecret();
      const { rows } = await pool.query(`SELECT admin_secret_ct FROM ${TEST_SCHEMA}.network_access WHERE id=1`);
      const stored = rows[0].admin_secret_ct as Buffer;
      expect(stored).toBeInstanceOf(Buffer);
      expect(stored.toString("utf8")).not.toBe(plaintext);
    });

    it("second call is a no-op — never re-exposes the plaintext", async () => {
      const first = await store!.mintAdminSecret();
      expect(first.plaintext).toBeDefined();

      const second = await store!.mintAdminSecret();
      expect(second.plaintext).toBeUndefined();

      // The original secret still verifies — proving it wasn't replaced.
      const stillValid = await store!.verifyAdminSecret(first.plaintext!);
      expect(stillValid).toBe(true);
    });
  });

  describe("rotateAdminSecret()", () => {
    it("replaces the sealed value; the old plaintext no longer verifies", async () => {
      const { plaintext: original } = await store!.mintAdminSecret();
      const rotated = await store!.rotateAdminSecret();

      expect(rotated).not.toBe(original);
      expect(await store!.verifyAdminSecret(original!)).toBe(false);
      expect(await store!.verifyAdminSecret(rotated)).toBe(true);
    });

    it("works even when no secret was ever minted", async () => {
      const rotated = await store!.rotateAdminSecret();
      expect(await store!.verifyAdminSecret(rotated)).toBe(true);
    });
  });

  describe("verifyAdminSecret()", () => {
    it("returns false when no secret has been minted", async () => {
      expect(await store!.verifyAdminSecret("anything")).toBe(false);
    });

    it("returns false for an empty string, without throwing", async () => {
      await store!.mintAdminSecret();
      await expect(store!.verifyAdminSecret("")).resolves.toBe(false);
    });

    it("returns false for a wrong-length candidate, without throwing", async () => {
      await store!.mintAdminSecret();
      await expect(store!.verifyAdminSecret("short")).resolves.toBe(false);
    });

    it("returns false for a correct-length-but-wrong-value candidate, without throwing", async () => {
      const { plaintext } = await store!.mintAdminSecret();
      const wrongSameLength = "x".repeat(plaintext!.length);
      await expect(store!.verifyAdminSecret(wrongSameLength)).resolves.toBe(false);
    });

    it("returns true for the exact current plaintext", async () => {
      const { plaintext } = await store!.mintAdminSecret();
      expect(await store!.verifyAdminSecret(plaintext!)).toBe(true);
    });
  });

  describe("setNetworkAccessEnabled()", () => {
    it("persists the enabled flag independently of the secret", async () => {
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
