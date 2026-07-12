import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createTunnelRoutes } from "../../src/inspector/tunnel-routes.js";
import type { ConfigStore, ControllerInput, ControllerRow } from "../../src/config-store/index.js";

// Step 11 — TUNNEL-CREDS-LEAK: sentinel-grep pin for every inspector
// route that could echo a decrypted secret back to the operator. Each
// test plants unique magic values on the ControllerRow / ControllerInput
// and asserts no response body ever contains them. This is the runtime
// guarantee behind the plan's "write-only for secrets" contract
// (docs/plans/ENV-TO-DB.md §"Inspector as the write path").
//
// Paired with tests/logger/redact.test.ts (structural pino redact) and
// tests/inspector/session-creds-leak.test.ts (the analogous suite for
// per-MCP session-pasted env values).

const usedMagic = new Set<string>();
function freshMagic(prefix: string): string {
  for (let i = 0; i < 32; i++) {
    const v = `${prefix}_${Math.random().toString(36).slice(2, 14)}`;
    if (!usedMagic.has(v)) {
      usedMagic.add(v);
      return v;
    }
  }
  throw new Error("could not mint unique magic value");
}

function mockRequest(method: string, body?: unknown): IncomingMessage {
  const req = {
    method,
    url: "/internal/tunnel/config",
    headers: {},
    on: vi.fn(),
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) {
        yield Buffer.from(JSON.stringify(body), "utf8");
      }
    },
  } as unknown as IncomingMessage;
  return req;
}

function mockResponse(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: "",
    statusCode: 0,
    setHeader: vi.fn(),
    end: function (b?: string) {
      this._body = b ?? "";
      this._status = this.statusCode;
    },
    write: vi.fn(),
    flushHeaders: vi.fn(),
  } as unknown as ServerResponse & { _status: number; _body: string };
  return res;
}

function makeRow(overrides: Partial<ControllerRow> = {}): ControllerRow {
  return {
    id: "row-uuid",
    name: "test-row",
    controllerUrl: "https://controller.example.com",
    connectorName: "test-connector",
    environment: "dev",
    authMode: "static-bearer",
    tunnelAuthToken: null,
    oauthClientId: null,
    oauthClientSecret: null,
    oauthTokenUrl: null,
    registrationToken: null,
    enabled: true,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    lastConnectedAt: null,
    lastDisconnectReason: null,
    ...overrides,
  };
}

describe("tunnel routes — leak channels", () => {
  describe("GET /internal/tunnel/config", () => {
    it("NEVER echoes tunnelAuthToken cleartext (static-bearer row)", async () => {
      const SECRET = freshMagic("bearer");
      const mockStore = {
        getController: vi.fn().mockResolvedValue(
          makeRow({ tunnelAuthToken: SECRET, registrationToken: "reg-token-xyz" }),
        ),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const res = mockResponse();
      await routes.handleGetConfig(mockRequest("GET"), res);

      expect(res._status).toBe(200);
      expect(res._body).not.toContain(SECRET);
      // Sanity: presence flag still reported.
      const body = JSON.parse(res._body);
      expect(body.row.hasTunnelAuthToken).toBe(true);
    });

    it("NEVER echoes oauthClientSecret cleartext (oauth2-cc row)", async () => {
      const SECRET = freshMagic("oauth");
      const mockStore = {
        getController: vi.fn().mockResolvedValue(
          makeRow({
            authMode: "oauth2-cc",
            oauthClientId: "cid_public_abc",
            oauthClientSecret: SECRET,
            oauthTokenUrl: "https://auth.example.com/token",
          }),
        ),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const res = mockResponse();
      await routes.handleGetConfig(mockRequest("GET"), res);

      expect(res._status).toBe(200);
      expect(res._body).not.toContain(SECRET);
      // Sanity: clientId is NOT redacted — it's not a secret and the UI
      // needs to show it.
      expect(res._body).toContain("cid_public_abc");
    });

    it("NEVER echoes registrationToken cleartext", async () => {
      const REG = freshMagic("regtok");
      const mockStore = {
        getController: vi.fn().mockResolvedValue(
          makeRow({ tunnelAuthToken: "some-token", registrationToken: REG }),
        ),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const res = mockResponse();
      await routes.handleGetConfig(mockRequest("GET"), res);

      expect(res._body).not.toContain(REG);
      // Sanity: length is exposed (needed by the UI to render "bound (len=N)").
      const body = JSON.parse(res._body);
      expect(body.row.hasRegistrationToken).toBe(true);
      expect(body.row.registrationTokenLen).toBe(REG.length);
    });

    it("500 DB-error response surfaces the error text but not row secrets", async () => {
      // The invariant we care about: ConfigStore-level errors never
      // quote row values in the .message string, so the route can
      // safely surface (err as Error).message verbatim. This test pins
      // that invariant — if a future code path introduces an error
      // message containing decrypted-row content, the sentinel-grep
      // here would fail and we'd know to sanitize before responding.
      const mockStore = {
        getController: vi.fn().mockRejectedValue(
          new Error("connection to Postgres timed out"),
        ),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const res = mockResponse();
      await routes.handleGetConfig(mockRequest("GET"), res);

      expect(res._status).toBe(500);
      expect(res._body).toContain("connection to Postgres timed out");
      // Belt-and-braces: even sentinel-shaped values that were NEVER
      // handed to the store should never appear here.
      for (const magic of usedMagic) {
        expect(res._body).not.toContain(magic);
      }
    });
  });

  describe("POST /internal/tunnel/creds", () => {
    it("INSERT: 200 response NEVER echoes the just-pasted tunnelAuthToken", async () => {
      const SECRET = freshMagic("bearer-post");
      const newRow = makeRow({ tunnelAuthToken: SECRET });
      const mockStore = {
        getController: vi.fn().mockResolvedValue(null),
        upsertController: vi.fn().mockResolvedValue(newRow),
        deleteController: vi.fn(),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn().mockResolvedValue(undefined),
        cycleTunnel: vi.fn(),
      });

      const input: ControllerInput = {
        name: "test-row",
        controllerUrl: "https://controller.example.com",
        connectorName: "test-connector",
        environment: "dev",
        authMode: "static-bearer",
        tunnelAuthToken: SECRET,
      };

      const res = mockResponse();
      await routes.handlePostCreds(mockRequest("POST", input), res);

      expect(res._status).toBe(200);
      expect(res._body).not.toContain(SECRET);
    });

    it("INSERT: 200 response NEVER echoes the just-pasted oauthClientSecret", async () => {
      const SECRET = freshMagic("oauth-post");
      const newRow = makeRow({
        authMode: "oauth2-cc",
        oauthClientId: "cid_x",
        oauthClientSecret: SECRET,
        oauthTokenUrl: "https://a.example.com/token",
      });
      const mockStore = {
        getController: vi.fn().mockResolvedValue(null),
        upsertController: vi.fn().mockResolvedValue(newRow),
        deleteController: vi.fn(),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn().mockResolvedValue(undefined),
        cycleTunnel: vi.fn(),
      });

      const input: ControllerInput = {
        name: "test-row",
        controllerUrl: "https://controller.example.com",
        connectorName: "test-connector",
        environment: null,
        authMode: "oauth2-cc",
        oauthClientId: "cid_x",
        oauthClientSecret: SECRET,
        oauthTokenUrl: "https://a.example.com/token",
      };

      const res = mockResponse();
      await routes.handlePostCreds(mockRequest("POST", input), res);

      expect(res._status).toBe(200);
      expect(res._body).not.toContain(SECRET);
    });

    it("409 dial-failure response NEVER echoes the just-pasted secret (INSERT rollback path)", async () => {
      const SECRET = freshMagic("bearer-fail");
      const newRow = makeRow({ tunnelAuthToken: SECRET });
      const mockStore = {
        getController: vi.fn().mockResolvedValue(null),
        upsertController: vi.fn().mockResolvedValue(newRow),
        deleteController: vi.fn().mockResolvedValue(true),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn().mockRejectedValueOnce(new Error("controller rejected bearer")),
        cycleTunnel: vi.fn(),
      });

      const input: ControllerInput = {
        name: "test",
        controllerUrl: "https://x.example.com",
        connectorName: "c",
        environment: null,
        authMode: "static-bearer",
        tunnelAuthToken: SECRET,
      };

      const res = mockResponse();
      await routes.handlePostCreds(mockRequest("POST", input), res);

      expect(res._status).toBe(409);
      expect(res._body).toContain("controller rejected bearer");
      expect(res._body).not.toContain(SECRET);
    });

    it("400 validation-error response NEVER echoes any pasted value", async () => {
      const SECRET = freshMagic("bearer-400");
      const mockStore = {} as ConfigStore;
      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      // Missing controllerUrl → 400. Body still carries tunnelAuthToken —
      // must not reflect it back in the error response. (controllerUrl and
      // authMode are the only remaining required fields after the modal
      // collapse; missing either triggers the 400.)
      const badInput = {
        // controllerUrl intentionally missing
        authMode: "static-bearer",
        tunnelAuthToken: SECRET,
      };

      const res = mockResponse();
      await routes.handlePostCreds(mockRequest("POST", badInput), res);

      expect(res._status).toBe(400);
      expect(res._body).not.toContain(SECRET);
    });
  });

  describe("POST /internal/tunnel/force-reregister", () => {
    it("200 response NEVER echoes the current registrationToken", async () => {
      const REG = freshMagic("regtok-force");
      const clearRegistrationToken = vi.fn().mockResolvedValue(undefined);
      const mockStore = {
        getController: vi.fn().mockResolvedValue(
          makeRow({ tunnelAuthToken: "some-token", registrationToken: REG }),
        ),
        clearRegistrationToken,
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn().mockResolvedValue(undefined),
      });

      const res = mockResponse();
      await routes.handleForceReregister(mockRequest("POST"), res);

      expect(res._status).toBe(200);
      expect(res._body).not.toContain(REG);
    });
  });
});
