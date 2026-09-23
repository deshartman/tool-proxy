import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { ConfigStore } from "../../src/config-store/index.js";
import { openTempStore, type StoreFixture } from "../helpers/config-store.js";

// CONNECTOR-NETWORK-EXPOSURE — network_access.enabled gates ONLY the
// machine API (POST /oauth/token) being reachable non-loopback. There is
// no admin secret / session concept — the operator UI stays loopback-only
// unconditionally, forever.

describe("ConfigStore — network access state + API clients", () => {
  let fixture: StoreFixture;
  let store: ConfigStore | undefined;

  beforeEach(async () => {
    fixture = await openTempStore();
    store = fixture.store;
  });

  afterEach(async () => {
    await fixture.cleanup();
    store = undefined;
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

    describe("deleteApiClient()", () => {
      it("refuses to delete a client that hasn't been revoked yet", async () => {
        const { clientId } = await store!.mintApiClient("still-active");
        expect(await store!.deleteApiClient(clientId)).toBe(false);
        // Row must still exist — the refusal didn't silently no-op-delete it.
        expect(await store!.listApiClients()).toHaveLength(1);
      });

      it("deletes a revoked client, removing the row entirely", async () => {
        const { clientId } = await store!.mintApiClient("to-delete");
        await store!.revokeApiClient(clientId);
        expect(await store!.deleteApiClient(clientId)).toBe(true);
        expect(await store!.listApiClients()).toHaveLength(0);
      });

      it("returns false for an unknown client_id", async () => {
        expect(await store!.deleteApiClient("nonexistent")).toBe(false);
      });

      it("returns false on a second delete of the same client_id", async () => {
        const { clientId } = await store!.mintApiClient();
        await store!.revokeApiClient(clientId);
        expect(await store!.deleteApiClient(clientId)).toBe(true);
        expect(await store!.deleteApiClient(clientId)).toBe(false);
      });
    });
  });
});
