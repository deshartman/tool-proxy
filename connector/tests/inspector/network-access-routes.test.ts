import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import pg from "pg";
import { ConfigStore } from "../../src/config-store/index.js";
import { initSodium } from "../../src/config-store/seal.js";
import { createNetworkAccessRoutes } from "../../src/inspector/network-access-routes.js";

// CONNECTOR-NETWORK-EXPOSURE — handleAddClient's core new behavior after
// dropping the admin-secret/session system: the FIRST API client ever
// added is what flips network_access.enabled and triggers the live
// rebind — there is no separate "Enable" action anymore. This is the one
// piece of business logic that lives only in the route handler (not in
// ConfigStore, not in rebindInspector individually), so it needs its own
// coverage at this level.

const CSRF_HEADERS = { "content-type": "application/json", "x-inspector-request": "1" };

describe("POST /internal/network-access/clients — auto-enable on first add", () => {
  const TEST_SCHEMA = "test_mcp_connector_addclient_" + Date.now();
  let store: ConfigStore;
  let pool: pg.Pool;
  let masterKey: { bytes: Buffer; fingerprint: string };
  let server: Server;
  let port: number;
  let rebindCallCount: number;

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
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.api_clients CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.network_access CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.trusted_issuer_config CASCADE`);
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
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.trusted_issuer_config CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.controllers CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.encryption_meta CASCADE`);
    store = await ConfigStore.open(masterKey);
    rebindCallCount = 0;

    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    const routes = createNetworkAccessRoutes({
      configStore: store,
      rebindNonLoopback: () => { rebindCallCount++; },
    });
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/internal/network-access/clients" && req.method === "POST") {
        void routes.handleAddClient(req, res);
        return;
      }
      if (url.pathname === "/internal/network-access/status" && req.method === "GET") {
        void routes.handleStatus(req, res);
        return;
      }
      if (url.pathname === "/internal/network-access/clients/revoke" && req.method === "POST") {
        void routes.handleRevokeClient(req, res);
        return;
      }
      if (url.pathname === "/internal/network-access/clients/delete" && req.method === "POST") {
        void routes.handleDeleteClient(req, res);
        return;
      }
      if (url.pathname === "/internal/network-access/trusted-issuer" && req.method === "GET") {
        void routes.handleGetTrustedIssuer(req, res);
        return;
      }
      if (url.pathname === "/internal/network-access/trusted-issuer" && req.method === "POST") {
        void routes.handleSetTrustedIssuer(req, res);
        return;
      }
      if (url.pathname === "/internal/network-access/trusted-issuer/clear" && req.method === "POST") {
        void routes.handleClearTrustedIssuer(req, res);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as { port: number }).port;
  });

  async function addClient(name?: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/internal/network-access/clients`, {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({ name }),
    });
  }

  async function revokeClient(clientId: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/internal/network-access/clients/revoke`, {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({ clientId }),
    });
  }

  async function deleteClient(clientId: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/internal/network-access/clients/delete`, {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({ clientId }),
    });
  }

  async function getStatus(): Promise<{ enabled: boolean }> {
    const res = await fetch(`http://127.0.0.1:${port}/internal/network-access/status`);
    return res.json();
  }

  async function getTrustedIssuer(): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/internal/network-access/trusted-issuer`);
  }

  async function setTrustedIssuer(body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/internal/network-access/trusted-issuer`, {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify(body),
    });
  }

  async function clearTrustedIssuer(): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/internal/network-access/trusted-issuer/clear`, {
      method: "POST",
      headers: CSRF_HEADERS,
      body: "{}",
    });
  }

  it("network access starts disabled, with no clients", async () => {
    expect((await getStatus()).enabled).toBe(false);
    expect(await store.listApiClients()).toHaveLength(0);
  });

  it("the FIRST client added flips enabled=true and rebinds exactly once", async () => {
    const res = await addClient("first-integration");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.clientId).toBe("string");
    expect(typeof body.clientSecret).toBe("string");

    // rebindNonLoopback is deferred to res.on("finish"); give that a tick.
    await new Promise((r) => setTimeout(r, 20));
    expect(rebindCallCount).toBe(1);
    expect((await getStatus()).enabled).toBe(true);
  });

  it("a SECOND client does NOT re-trigger the rebind — it's already enabled", async () => {
    await addClient("first-integration");
    await new Promise((r) => setTimeout(r, 20));
    expect(rebindCallCount).toBe(1);

    const res = await addClient("second-integration");
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));

    // Still exactly one rebind call — adding a client once enabled is a
    // pure credential mint with no side effect on the bind.
    expect(rebindCallCount).toBe(1);
    expect((await getStatus()).enabled).toBe(true);
    expect(await store.listApiClients()).toHaveLength(2);
  });

  it("network access stays enabled even if every client is later removed", async () => {
    const res = await addClient("only-integration");
    const { clientId } = await res.json();
    await new Promise((r) => setTimeout(r, 20));

    await store.revokeApiClient(clientId);

    expect((await getStatus()).enabled).toBe(true);
  });

  describe("Revoke then Delete (two-step row removal)", () => {
    it("Delete is refused via the route until the client has been Revoked first", async () => {
      const res = await addClient("still-active");
      const { clientId } = await res.json();

      const deleteRes = await deleteClient(clientId);
      expect(deleteRes.status).toBe(404);

      // Row survives the refused delete.
      expect(await store.listApiClients()).toHaveLength(1);
    });

    it("Revoke then Delete removes the row entirely", async () => {
      const res = await addClient("to-remove");
      const { clientId } = await res.json();

      const revokeRes = await revokeClient(clientId);
      expect(revokeRes.status).toBe(200);

      const deleteRes = await deleteClient(clientId);
      expect(deleteRes.status).toBe(200);

      expect(await store.listApiClients()).toHaveLength(0);
    });

    it("Delete on an unknown client_id → 404", async () => {
      const res = await deleteClient("nonexistent");
      expect(res.status).toBe(404);
    });
  });

  // FEDERATED-JWT-MODE — trusted-issuer config folded into the same routes
  // factory. Its one genuinely-new behavior: setting a config for the FIRST
  // time (when no API client ever flipped network_access.enabled) also
  // enables non-loopback + rebinds, mirroring handleAddClient.
  describe("Federated trusted-issuer config", () => {
    const sample = { issuer: "https://idp.example.com", jwksUrl: "https://idp.example.com/jwks", audience: "mcp-connector" };

    it("GET with no config set → { ok:true, config:null }", async () => {
      const res = await getTrustedIssuer();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, config: null });
    });

    it("POST a valid body → 200, GET now returns it", async () => {
      const res = await setTrustedIssuer(sample);
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
      expect(await store.getTrustedIssuerConfig()).toEqual(sample);
      const getRes = await getTrustedIssuer();
      expect(await getRes.json()).toEqual({ ok: true, config: sample });
    });

    it("POST a body missing a field → 400, nothing persisted", async () => {
      const res = await setTrustedIssuer({ issuer: sample.issuer, jwksUrl: sample.jwksUrl });
      expect(res.status).toBe(400);
      expect(await store.getTrustedIssuerConfig()).toBeUndefined();
    });

    it("configuring federated mode FIRST (no API client) flips enabled=true and rebinds once", async () => {
      expect((await getStatus()).enabled).toBe(false);
      const res = await setTrustedIssuer(sample);
      expect(res.status).toBe(200);
      // rebindNonLoopback is deferred to res.on("finish"); give it a tick.
      await new Promise((r) => setTimeout(r, 20));
      expect(rebindCallCount).toBe(1);
      expect((await getStatus()).enabled).toBe(true);
    });

    it("configuring federated mode when already enabled does NOT re-rebind", async () => {
      await addClient("first-integration");
      await new Promise((r) => setTimeout(r, 20));
      expect(rebindCallCount).toBe(1);

      const res = await setTrustedIssuer(sample);
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      // Still one — enabling is one-way and idempotent on the rebind.
      expect(rebindCallCount).toBe(1);
    });

    it("clear removes the config but leaves network_access.enabled=true (no un-rebind)", async () => {
      await setTrustedIssuer(sample);
      await new Promise((r) => setTimeout(r, 20));
      expect((await getStatus()).enabled).toBe(true);

      const res = await clearTrustedIssuer();
      expect(res.status).toBe(200);
      expect(await store.getTrustedIssuerConfig()).toBeUndefined();
      // One-way widening — clearing federated config does not re-narrow the bind.
      expect((await getStatus()).enabled).toBe(true);
    });
  });
});
