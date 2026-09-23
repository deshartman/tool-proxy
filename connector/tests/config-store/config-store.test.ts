import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { ConfigStore, type ControllerInput } from "../../src/config-store/index.js";
import { makeMasterKey, openTempStore, type StoreFixture } from "../helpers/config-store.js";

// Post DB-TO-FILE: the store is a sealed JSON file in a tmpdir. No Postgres, no
// POSTGRES_URL, no schema teardown — the suite now runs anywhere.

describe("ConfigStore", () => {
  let fixture: StoreFixture;
  let store: ConfigStore;
  let masterKey: { bytes: Buffer; fingerprint: string };

  beforeEach(async () => {
    fixture = await openTempStore();
    store = fixture.store;
    masterKey = fixture.masterKey;
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  describe("open()", () => {
    it("records the key fingerprint on first open", async () => {
      const doc = JSON.parse(readFileSync(fixture.path, "utf8"));
      expect(doc.keyFingerprint).toBe(masterKey.fingerprint);
      expect(doc.version).toBe(1);
    });

    // The file is written at open(), not lazily on first mutation. That is what
    // turns an unwritable state volume into a boot failure instead of a failure
    // on the operator's first Configure Tunnel submit.
    it("creates the store file immediately, before any mutation", async () => {
      expect(() => readFileSync(fixture.path)).not.toThrow();
    });

    it("succeeds on second open with same key", async () => {
      const store2 = await fixture.reopen();
      expect(store2).toBeDefined();
      await store2.close();
    });

    it("throws on open with wrong key", async () => {
      await expect(fixture.reopen(makeMasterKey())).rejects.toThrow(
        /master key does not match the fingerprint/
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

    it("validates oauth2-cc requires plaintext oauth fields", async () => {
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
        /oauthClientId and oauthTokenUrl are required when authMode is oauth2-cc/
      );
    });

    it("validates oauth2-cc requires oauthClientSecret when no prior row to preserve", async () => {
      const input: ControllerInput = {
        name: "test",
        controllerUrl: "https://example.com",
        connectorName: "test",
        environment: null,
        authMode: "oauth2-cc",
        oauthClientId: "client-id",
        oauthTokenUrl: "https://auth.example.com/token",
        // Missing oauthClientSecret
      };

      await expect(store.upsertController(input)).rejects.toThrow(
        /oauthClientSecret is required when authMode is oauth2-cc/
      );
    });

    // Pins the "leave blank to keep existing" behavior: on UPDATE with the
    // SAME authMode, an omitted secret preserves the prior sealed value via
    // SQL COALESCE. This is what powers the Edit Tunnel modal's ability to
    // update Display Name / Controller URL without re-pasting the token.
    it("UPDATE: omitted tunnelAuthToken preserves the prior sealed value on same authMode", async () => {
      await store!.upsertController({
        name: "test",
        controllerUrl: "https://example.com",
        connectorName: "test",
        environment: null,
        authMode: "static-bearer",
        tunnelAuthToken: "original-secret-token",
      });

      // Second call omits tunnelAuthToken — should NOT throw, and should
      // preserve the original secret.
      const updated = await store!.upsertController({
        name: "renamed",
        controllerUrl: "https://renamed.example.com",
        connectorName: "test",
        environment: null,
        authMode: "static-bearer",
        // tunnelAuthToken deliberately omitted
      });

      expect(updated.name).toBe("renamed");
      expect(updated.controllerUrl).toBe("https://renamed.example.com");
      expect(updated.tunnelAuthToken).toBe("original-secret-token");
    });

    it("UPDATE: omitted oauthClientSecret preserves the prior sealed value on same authMode", async () => {
      await store!.upsertController({
        name: "test",
        controllerUrl: "https://oauth.example.com",
        connectorName: "test",
        environment: null,
        authMode: "oauth2-cc",
        oauthClientId: "client-id",
        oauthClientSecret: "original-client-secret",
        oauthTokenUrl: "https://auth.example.com/token",
      });

      const updated = await store!.upsertController({
        name: "renamed",
        controllerUrl: "https://oauth.example.com",
        connectorName: "test",
        environment: null,
        authMode: "oauth2-cc",
        oauthClientId: "client-id",
        oauthTokenUrl: "https://auth.example.com/token",
        // oauthClientSecret deliberately omitted
      });

      expect(updated.name).toBe("renamed");
      expect(updated.oauthClientSecret).toBe("original-client-secret");
    });

    it("UPDATE: authMode switch (static-bearer → oauth2-cc) still requires the new secret", async () => {
      await store!.upsertController({
        name: "test",
        controllerUrl: "https://example.com",
        connectorName: "test",
        environment: null,
        authMode: "static-bearer",
        tunnelAuthToken: "static-token",
      });

      // Switching authMode → the prior sealed value is for a DIFFERENT
      // authMode, so there is nothing to preserve. Must supply new secret.
      await expect(store!.upsertController({
        name: "test",
        controllerUrl: "https://example.com",
        connectorName: "test",
        environment: null,
        authMode: "oauth2-cc",
        oauthClientId: "client-id",
        oauthTokenUrl: "https://auth.example.com/token",
        // oauthClientSecret omitted; prior row was static-bearer so no
        // oauth secret to preserve.
      })).rejects.toThrow(/oauthClientSecret is required/);
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

      // Sealed at rest: the bearer must not be recoverable from the file
      // without the key. Checks the raw bytes AND the whole serialised
      // document, so a future field that accidentally stored the plaintext
      // alongside the ciphertext would still fail this.
      const raw = readFileSync(fixture.path, "utf8");
      expect(raw).not.toContain("secret-bearer-token");
      const doc = JSON.parse(raw);
      const ct = doc.controllers[0].tunnelAuthTokenCt;
      expect(typeof ct).toBe("string");
      expect(Buffer.from(ct, "base64").toString("utf8")).not.toBe("secret-bearer-token");
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
