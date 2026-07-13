import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ConfigStore, type ControllerInput } from "../../src/config-store/index.js";
import { initSodium } from "../../src/config-store/seal.js";
import { randomBytes, createHash } from "node:crypto";
import pg from "pg";

describe("ConfigStore", () => {
  const TEST_SCHEMA = "test_mcp_connector_" + Date.now();
  let store: ConfigStore | undefined;
  let pool: pg.Pool;
  let masterKey: { bytes: Buffer; fingerprint: string };

  beforeAll(async () => {
    // Inherit POSTGRES_URL from shell environment
    const url = process.env.POSTGRES_URL;
    if (!url) {
      throw new Error(
        "POSTGRES_URL must be set for the ConfigStore integration test. Example: postgres://ek:{PASSWORD}@localhost:5433/enterprise_knowledge"
      );
    }

    await initSodium();

    // Generate a random 32-byte key
    const keyBytes = randomBytes(32);
    const fingerprint = createHash("sha256").update(keyBytes).digest("hex");
    masterKey = { bytes: keyBytes, fingerprint };

    // Set the test schema name
    process.env.POSTGRES_SCHEMA = TEST_SCHEMA;

    // Create test schema
    pool = new pg.Pool({ connectionString: url });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);

    // Clean up any existing test data
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.controllers CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.encryption_meta CASCADE`);
  });

  afterAll(async () => {
    // Clean up: close store first, then drop schema, then end pool
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
    // Close any existing store from the previous test
    if (store) {
      await store.close();
      store = undefined;
    }

    // Clean tables between tests
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.controllers CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.encryption_meta CASCADE`);
    }

    // Re-create store for each test
    store = await ConfigStore.open(masterKey);
  });

  describe("open()", () => {
    it("populates encryption_meta on first open", async () => {
      const { rows } = await pool.query(
        `SELECT key_fingerprint FROM ${TEST_SCHEMA}.encryption_meta WHERE id=1`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].key_fingerprint).toBe(masterKey.fingerprint);
    });

    it("succeeds on second open with same key", async () => {
      // First open already happened in beforeEach
      // Second open should succeed
      const store2 = await ConfigStore.open(masterKey);
      expect(store2).toBeDefined();
      await store2.close();
    });

    it("throws on open with wrong key", async () => {
      // Generate a different key
      const wrongKeyBytes = randomBytes(32);
      const wrongFingerprint = createHash("sha256")
        .update(wrongKeyBytes)
        .digest("hex");
      const wrongKey = { bytes: wrongKeyBytes, fingerprint: wrongFingerprint };

      await expect(ConfigStore.open(wrongKey)).rejects.toThrow(
        /master key does not match the fingerprint recorded on first migration/
      );
    });
  });

  describe("upsertController()", () => {
    it("INSERT creates a new row with generated UUID", async () => {
      const input: ControllerInput = {
        name: "test-controller",
        controllerUrl: "https://controller.example.com",
        connectorName: "my-connector",
        environment: "dev",
        authMode: "static-bearer",
        tunnelAuthToken: "ts_test_token_12345",
      };

      const row = await store.upsertController(input);

      expect(row.id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
      expect(row.name).toBe("test-controller");
      expect(row.controllerUrl).toBe("https://controller.example.com");
      expect(row.connectorName).toBe("my-connector");
      expect(row.environment).toBe("dev");
      expect(row.authMode).toBe("static-bearer");
      expect(row.tunnelAuthToken).toBe("ts_test_token_12345");
      expect(row.oauthClientId).toBeNull();
      expect(row.oauthClientSecret).toBeNull();
      expect(row.oauthTokenUrl).toBeNull();
      expect(row.enabled).toBe(true);
      expect(row.registrationToken).toBeNull();
    });

    it("UPDATE preserves the same row id", async () => {
      const input1: ControllerInput = {
        name: "test-controller",
        controllerUrl: "https://controller.example.com",
        connectorName: "my-connector",
        environment: "dev",
        authMode: "static-bearer",
        tunnelAuthToken: "token1",
      };

      const row1 = await store.upsertController(input1);
      const firstId = row1.id;

      const input2: ControllerInput = {
        name: "test-controller-updated",
        controllerUrl: "https://controller2.example.com",
        connectorName: "my-connector-2",
        environment: "prod",
        authMode: "static-bearer",
        tunnelAuthToken: "token2",
      };

      const row2 = await store.upsertController(input2);

      expect(row2.id).toBe(firstId);
      expect(row2.name).toBe("test-controller-updated");
      expect(row2.tunnelAuthToken).toBe("token2");
    });

    it("validates required fields", async () => {
      const input: ControllerInput = {
        name: "",
        controllerUrl: "https://example.com",
        connectorName: "test",
        environment: null,
        authMode: "static-bearer",
      };

      await expect(store.upsertController(input)).rejects.toThrow(/name, controllerUrl, and connectorName are required/);
    });

    it("validates static-bearer requires tunnelAuthToken", async () => {
      const input: ControllerInput = {
        name: "test",
        controllerUrl: "https://example.com",
        connectorName: "test",
        environment: null,
        authMode: "static-bearer",
        // Missing tunnelAuthToken
      };

      await expect(store.upsertController(input)).rejects.toThrow(
        /tunnelAuthToken is required when authMode is static-bearer/
      );
    });

    it("validates oauth2-cc requires all oauth fields", async () => {
      const input: ControllerInput = {
        name: "test",
        controllerUrl: "https://example.com",
        connectorName: "test",
        environment: null,
        authMode: "oauth2-cc",
        oauthClientId: "client-id",
        // Missing oauthClientSecret and oauthTokenUrl
      };

      await expect(store.upsertController(input)).rejects.toThrow(
        /oauthClientId, oauthClientSecret, and oauthTokenUrl are required when authMode is oauth2-cc/
      );
    });

    it("round-trips OAuth2 fields", async () => {
      const input: ControllerInput = {
        name: "oauth-controller",
        controllerUrl: "https://oauth.example.com",
        connectorName: "oauth-connector",
        environment: "prod",
        authMode: "oauth2-cc",
        oauthClientId: "my-client-id",
        oauthClientSecret: "my-client-secret-abc123",
        oauthTokenUrl: "https://auth.example.com/oauth/token",
      };

      const row = await store.upsertController(input);

      expect(row.authMode).toBe("oauth2-cc");
      expect(row.oauthClientId).toBe("my-client-id");
      expect(row.oauthClientSecret).toBe("my-client-secret-abc123");
      expect(row.oauthTokenUrl).toBe("https://auth.example.com/oauth/token");
      expect(row.tunnelAuthToken).toBeNull();
    });
  });

  describe("getController()", () => {
    it("returns null when table is empty", async () => {
      const row = await store.getController();
      expect(row).toBeNull();
    });

    it("returns fully decrypted row", async () => {
      const input: ControllerInput = {
        name: "test",
        controllerUrl: "https://example.com",
        connectorName: "test-connector",
        environment: "staging",
        authMode: "static-bearer",
        tunnelAuthToken: "secret-bearer-token",
      };

      await store.upsertController(input);
      const row = await store.getController();

      expect(row).toBeDefined();
      expect(row!.name).toBe("test");
      expect(row!.connectorName).toBe("test-connector");
      expect(row!.environment).toBe("staging");
      expect(row!.tunnelAuthToken).toBe("secret-bearer-token");

      // Verify encrypted in DB
      const { rows: dbRows } = await pool.query(
        `SELECT tunnel_auth_token_ct FROM ${TEST_SCHEMA}.controllers LIMIT 1`
      );
      const encrypted = dbRows[0].tunnel_auth_token_ct;
      expect(encrypted).toBeInstanceOf(Buffer);
      expect(encrypted.toString("utf8")).not.toBe("secret-bearer-token");
    });
  });

  describe("updateRegistrationToken()", () => {
    it("stores encrypted registration token", async () => {
      const input: ControllerInput = {
        name: "test",
        controllerUrl: "https://example.com",
        connectorName: "test",
        environment: null,
        authMode: "static-bearer",
        tunnelAuthToken: "token",
      };

      const row = await store.upsertController(input);
      await store.updateRegistrationToken(row.id, "registration-token-12345");

      const updated = await store.getController();
      expect(updated!.registrationToken).toBe("registration-token-12345");
    });
  });

  describe("clearRegistrationToken()", () => {
    it("clears registration token", async () => {
      const input: ControllerInput = {
        name: "test",
        controllerUrl: "https://example.com",
        connectorName: "test",
        environment: null,
        authMode: "static-bearer",
        tunnelAuthToken: "token",
      };

      const row = await store.upsertController(input);
      await store.updateRegistrationToken(row.id, "registration-token");
      await store.clearRegistrationToken(row.id);

      const updated = await store.getController();
      expect(updated!.registrationToken).toBeNull();
    });
  });

  describe("deleteController()", () => {
    it("removes the row and subsequent getController() returns null", async () => {
      const input: ControllerInput = {
        name: "test",
        controllerUrl: "https://example.com",
        connectorName: "test",
        environment: null,
        authMode: "static-bearer",
        tunnelAuthToken: "token",
      };

      // Create a row first
      await store.upsertController(input);
      const row = await store.getController();
      expect(row).not.toBeNull();

      // Delete the row
      const deleted = await store.deleteController();
      expect(deleted).toBe(true);

      // Verify it's gone
      const afterDelete = await store.getController();
      expect(afterDelete).toBeNull();
    });

    it("returns false when no row exists", async () => {
      const deleted = await store.deleteController();
      expect(deleted).toBe(false);
    });
  });
});
