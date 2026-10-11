import { describe, it, expect, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createTunnelRoutes, normalizeControllerUrl, type TunnelConfigSummary } from "../../src/inspector/tunnel-routes.js";
import type { ConfigStore, ControllerInput, ControllerRow } from "../../src/config-store/index.js";

function mockRequest(method: string, body?: unknown): IncomingMessage {
  const req = {
    method,
    url: "/internal/tunnel/config",
    headers: {
      "content-type": "application/json",
      "x-inspector-request": "1",
    },
    on: vi.fn(),
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) {
        const buf = Buffer.from(JSON.stringify(body), "utf8");
        yield buf;
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
    end: function (body?: string) {
      this._body = body ?? "";
      this._status = this.statusCode;
    },
    write: vi.fn(),
    flushHeaders: vi.fn(),
  } as unknown as ServerResponse & { _status: number; _body: string };
  return res;
}

describe("tunnel routes", () => {
  describe("GET /internal/tunnel/config", () => {
    it("returns {configured: false} when no row exists", async () => {
      const mockStore = {
        getShimId: () => "abcd2345",
        getController: vi.fn().mockResolvedValue(null),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const req = mockRequest("GET");
      const res = mockResponse();

      await routes.handleGetConfig(req, res);

      expect(res._status).toBe(200);
      // shimId exists from first boot, before any controller is configured.
      expect(JSON.parse(res._body)).toEqual({ configured: false, shimId: "abcd2345" });
    });

    it("returns TunnelConfigSummary with hasTunnelAuthToken: true for static-bearer row", async () => {
      const mockRow: ControllerRow = {
        id: "test-id-123",
        name: "test-controller",
        controllerUrl: "https://controller.example.com",
        connectorName: "test-connector",
        environment: "dev",
        authMode: "static-bearer",
        tunnelAuthToken: "ts_secret_token",  // This should NOT appear in response
        oauthClientId: null,
        oauthClientSecret: null,
        oauthTokenUrl: null,
        registrationToken: "reg_token_123",  // This should NOT appear in response
        enabled: true,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-02"),
        lastConnectedAt: new Date("2026-01-03"),
        lastDisconnectReason: null,
      };

      const mockStore = {
        getShimId: () => "abcd2345",
        getController: vi.fn().mockResolvedValue(mockRow),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const req = mockRequest("GET");
      const res = mockResponse();

      await routes.handleGetConfig(req, res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.configured).toBe(true);
      expect(body.row).toBeDefined();

      const summary: TunnelConfigSummary = body.row;
      expect(summary.id).toBe("test-id-123");
      expect(summary.name).toBe("test-controller");
      expect(summary.authMode).toBe("static-bearer");
      expect(summary.hasTunnelAuthToken).toBe(true);
      expect(summary.hasOauthClientSecret).toBe(false);
      expect(summary.oauthClientId).toBeNull();
      expect(summary.oauthTokenUrl).toBeNull();
      expect(summary.hasRegistrationToken).toBe(true);
      expect(summary.registrationTokenLen).toBe(13); // "reg_token_123".length
      expect(summary.enabled).toBe(true);

      // Secrets should NOT be in the response
      expect(summary).not.toHaveProperty("tunnelAuthToken");
      expect(summary).not.toHaveProperty("registrationToken");
      expect(summary).not.toHaveProperty("oauthClientSecret");

      // Dates should be ISO strings
      expect(typeof summary.createdAt).toBe("string");
      expect(typeof summary.updatedAt).toBe("string");
    });

    it("returns TunnelConfigSummary with hasOauthClientSecret: true for oauth2-cc row", async () => {
      const mockRow: ControllerRow = {
        id: "oauth-id-456",
        name: "oauth-controller",
        controllerUrl: "https://oauth-controller.example.com",
        connectorName: "oauth-connector",
        environment: "prod",
        authMode: "oauth2-cc",
        tunnelAuthToken: null,
        oauthClientId: "my-client-id",
        oauthClientSecret: "my-secret",  // This should NOT appear in response
        oauthTokenUrl: "https://auth.example.com/token",
        registrationToken: null,
        enabled: true,
        createdAt: new Date("2026-02-01"),
        updatedAt: new Date("2026-02-02"),
        lastConnectedAt: null,
        lastDisconnectReason: "timeout",
      };

      const mockStore = {
        getShimId: () => "abcd2345",
        getController: vi.fn().mockResolvedValue(mockRow),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const req = mockRequest("GET");
      const res = mockResponse();

      await routes.handleGetConfig(req, res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      const summary: TunnelConfigSummary = body.row;

      expect(summary.authMode).toBe("oauth2-cc");
      expect(summary.hasTunnelAuthToken).toBe(false);
      expect(summary.hasOauthClientSecret).toBe(true);
      expect(summary.oauthClientId).toBe("my-client-id");
      expect(summary.oauthTokenUrl).toBe("https://auth.example.com/token");
      expect(summary.hasRegistrationToken).toBe(false);
      expect(summary.lastConnectedAt).toBeNull();
      expect(summary.lastDisconnectReason).toBe("timeout");

      // Secrets should NOT appear
      expect(summary).not.toHaveProperty("oauthClientSecret");
    });

    it("returns 500 on DB error", async () => {
      const mockStore = {
        getShimId: () => "abcd2345",
        getController: vi.fn().mockRejectedValue(new Error("connection lost")),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const req = mockRequest("GET");
      const res = mockResponse();

      await routes.handleGetConfig(req, res);

      expect(res._status).toBe(500);
      const body = JSON.parse(res._body);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("connection lost");
    });
  });

  describe("POST /internal/tunnel/creds", () => {
    it("INSERT: dials tunnel after upsert and returns {ok: true}", async () => {
      const mockRow: ControllerRow = {
        id: "new-id",
        name: "new-controller",
        controllerUrl: "https://new.example.com",
        connectorName: "new-connector",
        environment: null,
        authMode: "static-bearer",
        tunnelAuthToken: "token123",
        oauthClientId: null,
        oauthClientSecret: null,
        oauthTokenUrl: null,
        registrationToken: null,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastConnectedAt: null,
        lastDisconnectReason: null,
      };

      const mockStore = {
        getShimId: () => "abcd2345",
        getController: vi.fn().mockResolvedValue(null),  // INSERT: no prior row
        upsertController: vi.fn().mockResolvedValue(mockRow),
        deleteController: vi.fn(),
      } as unknown as ConfigStore;

      const dialTunnel = vi.fn().mockResolvedValue(undefined);
      const cycleTunnel = vi.fn().mockResolvedValue(undefined);

      const routes = createTunnelRoutes({ configStore: mockStore, dialTunnel, cycleTunnel });

      const payload: ControllerInput = {
        name: "new-controller",
        controllerUrl: "https://new.example.com",
        connectorName: "new-connector",
        environment: null,
        authMode: "static-bearer",
        tunnelAuthToken: "token123",
      };

      const req = mockRequest("POST", payload);
      (req as any).url = "/internal/tunnel/creds";
      const res = mockResponse();

      await routes.handlePostCreds(req, res);

      expect(res._status).toBe(200);
      expect(JSON.parse(res._body).ok).toBe(true);
      // INSERT path: dialTunnel is called with the new row; cycleTunnel is NOT called
      expect(dialTunnel).toHaveBeenCalledWith(mockRow);
      expect(cycleTunnel).not.toHaveBeenCalled();
    });

    it("UPDATE: cycles tunnel after upsert and returns {ok: true}", async () => {
      const priorRow: ControllerRow = {
        id: "existing-id",
        name: "old-controller",
        controllerUrl: "https://old.example.com",
        connectorName: "old-connector",
        environment: null,
        authMode: "static-bearer",
        tunnelAuthToken: "old-token",
        oauthClientId: null,
        oauthClientSecret: null,
        oauthTokenUrl: null,
        registrationToken: "reg-token",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastConnectedAt: null,
        lastDisconnectReason: null,
      };
      const updatedRow: ControllerRow = { ...priorRow, tunnelAuthToken: "new-token" };

      const mockStore = {
        getShimId: () => "abcd2345",
        getController: vi.fn().mockResolvedValue(priorRow),  // UPDATE: prior row exists
        upsertController: vi.fn().mockResolvedValue(updatedRow),
        deleteController: vi.fn(),
      } as unknown as ConfigStore;

      const dialTunnel = vi.fn().mockResolvedValue(undefined);
      const cycleTunnel = vi.fn().mockResolvedValue(undefined);

      const routes = createTunnelRoutes({ configStore: mockStore, dialTunnel, cycleTunnel });

      const payload: ControllerInput = {
        name: "old-controller",
        controllerUrl: "https://old.example.com",
        connectorName: "old-connector",
        environment: null,
        authMode: "static-bearer",
        tunnelAuthToken: "new-token",
      };

      const req = mockRequest("POST", payload);
      (req as any).url = "/internal/tunnel/creds";
      const res = mockResponse();

      await routes.handlePostCreds(req, res);

      expect(res._status).toBe(200);
      expect(JSON.parse(res._body).ok).toBe(true);
      // UPDATE path: cycleTunnel is called with "credential-rotated"; dialTunnel is NOT called
      expect(cycleTunnel).toHaveBeenCalledWith("credential-rotated");
      expect(dialTunnel).not.toHaveBeenCalled();
    });

    it("accepts valid OAuth2 payload (INSERT case, dials tunnel)", async () => {
      const mockRow: ControllerRow = {
        id: "oauth-id",
        name: "oauth-controller",
        controllerUrl: "https://oauth.example.com",
        connectorName: "oauth-connector",
        environment: "prod",
        authMode: "oauth2-cc",
        tunnelAuthToken: null,
        oauthClientId: "client-id",
        oauthClientSecret: "client-secret",
        oauthTokenUrl: "https://auth.example.com/token",
        registrationToken: null,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastConnectedAt: null,
        lastDisconnectReason: null,
      };

      const mockStore = {
        getShimId: () => "abcd2345",
        getController: vi.fn().mockResolvedValue(null),
        upsertController: vi.fn().mockResolvedValue(mockRow),
        deleteController: vi.fn(),
      } as unknown as ConfigStore;

      const dialTunnel = vi.fn().mockResolvedValue(undefined);
      const cycleTunnel = vi.fn().mockResolvedValue(undefined);

      const routes = createTunnelRoutes({ configStore: mockStore, dialTunnel, cycleTunnel });

      const payload: ControllerInput = {
        name: "oauth-controller",
        controllerUrl: "https://oauth.example.com",
        connectorName: "oauth-connector",
        environment: "prod",
        authMode: "oauth2-cc",
        oauthClientId: "client-id",
        oauthClientSecret: "client-secret",
        oauthTokenUrl: "https://auth.example.com/token",
      };

      const req = mockRequest("POST", payload);
      (req as any).url = "/internal/tunnel/creds";
      const res = mockResponse();

      await routes.handlePostCreds(req, res);

      expect(res._status).toBe(200);
      expect(JSON.parse(res._body).ok).toBe(true);
      expect(dialTunnel).toHaveBeenCalledWith(mockRow);
    });

    it("INSERT: on dial rejection, rolls back the row and returns 409", async () => {
      const mockRow: ControllerRow = {
        id: "new-id",
        name: "bad-controller",
        controllerUrl: "https://bad.example.com",
        connectorName: "bad-connector",
        environment: null,
        authMode: "static-bearer",
        tunnelAuthToken: "bad-token",
        oauthClientId: null,
        oauthClientSecret: null,
        oauthTokenUrl: null,
        registrationToken: null,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastConnectedAt: null,
        lastDisconnectReason: null,
      };

      const deleteController = vi.fn().mockResolvedValue(true);
      const mockStore = {
        getShimId: () => "abcd2345",
        getController: vi.fn().mockResolvedValue(null),  // INSERT case
        upsertController: vi.fn().mockResolvedValue(mockRow),
        deleteController,
      } as unknown as ConfigStore;

      const dialTunnel = vi.fn().mockRejectedValueOnce(new Error("bearer rejected"));
      const cycleTunnel = vi.fn();

      const routes = createTunnelRoutes({ configStore: mockStore, dialTunnel, cycleTunnel });

      const req = mockRequest("POST", {
        name: "bad-controller",
        controllerUrl: "https://bad.example.com",
        connectorName: "bad-connector",
        authMode: "static-bearer",
        tunnelAuthToken: "bad-token",
      });
      (req as any).url = "/internal/tunnel/creds";
      const res = mockResponse();

      await routes.handlePostCreds(req, res);

      expect(res._status).toBe(409);
      expect(JSON.parse(res._body).error).toContain("bearer rejected");
      // INSERT rollback: deleteController was invoked
      expect(deleteController).toHaveBeenCalledTimes(1);
    });

    it("UPDATE: on dial rejection, keeps the row and returns 409", async () => {
      const priorRow: ControllerRow = {
        id: "existing-id",
        name: "controller",
        controllerUrl: "https://a.example.com",
        connectorName: "connector",
        environment: null,
        authMode: "static-bearer",
        tunnelAuthToken: "old-token",
        oauthClientId: null,
        oauthClientSecret: null,
        oauthTokenUrl: null,
        registrationToken: null,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastConnectedAt: null,
        lastDisconnectReason: null,
      };

      const deleteController = vi.fn();
      const mockStore = {
        getShimId: () => "abcd2345",
        getController: vi.fn().mockResolvedValue(priorRow),  // UPDATE case
        upsertController: vi.fn().mockResolvedValue({ ...priorRow, tunnelAuthToken: "new-token" }),
        deleteController,
      } as unknown as ConfigStore;

      const dialTunnel = vi.fn();
      const cycleTunnel = vi.fn().mockRejectedValueOnce(new Error("controller unreachable"));

      const routes = createTunnelRoutes({ configStore: mockStore, dialTunnel, cycleTunnel });

      const req = mockRequest("POST", {
        name: "controller",
        controllerUrl: "https://a.example.com",
        connectorName: "connector",
        authMode: "static-bearer",
        tunnelAuthToken: "new-token",
      });
      (req as any).url = "/internal/tunnel/creds";
      const res = mockResponse();

      await routes.handlePostCreds(req, res);

      expect(res._status).toBe(409);
      expect(JSON.parse(res._body).error).toContain("controller unreachable");
      // UPDATE path: row is NOT rolled back
      expect(deleteController).not.toHaveBeenCalled();
    });

    it("returns 400 on malformed JSON", async () => {
      const routes = createTunnelRoutes({
        configStore: {} as ConfigStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const req = {
        method: "POST",
        url: "/internal/tunnel/creds",
        headers: {
          "content-type": "application/json",
          "x-inspector-request": "1",
        },
        on: vi.fn(),
        [Symbol.asyncIterator]: async function* () {
          // Invalid JSON
          yield Buffer.from("{not valid json", "utf8");
        },
      } as unknown as IncomingMessage;

      const res = mockResponse();

      await routes.handlePostCreds(req, res);

      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error).toContain("malformed JSON");
    });

    it("returns 400 when body is not an object", async () => {
      const routes = createTunnelRoutes({
        configStore: {} as ConfigStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const req = mockRequest("POST", "not-an-object");
      (req as any).url = "/internal/tunnel/creds";
      const res = mockResponse();

      await routes.handlePostCreds(req, res);

      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error).toContain("body must be an object");
    });

    it("returns 400 on missing required fields", async () => {
      const mockStore = {} as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const req = mockRequest("POST", { name: "test" }); // missing controllerUrl, connectorName
      (req as any).url = "/internal/tunnel/creds";
      const res = mockResponse();

      await routes.handlePostCreds(req, res);

      expect(res._status).toBe(400);
      const body = JSON.parse(res._body);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("missing required fields");
    });

    it("INSERT: returns 400 when static-bearer is missing tunnelAuthToken (no prior row to preserve)", async () => {
      const mockStore = {
        getShimId: () => "abcd2345",
        getController: vi.fn().mockResolvedValue(null),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const req = mockRequest("POST", {
        name: "test",
        controllerUrl: "https://example.com",
        connectorName: "test",
        authMode: "static-bearer",
        // missing tunnelAuthToken
      });
      (req as any).url = "/internal/tunnel/creds";
      const res = mockResponse();

      await routes.handlePostCreds(req, res);

      expect(res._status).toBe(400);
      const body = JSON.parse(res._body);
      expect(body.error).toContain("tunnelAuthToken is required");
    });

    it("INSERT: returns 400 when oauth2-cc is missing plaintext oauth fields (no prior row to preserve)", async () => {
      const mockStore = {
        getShimId: () => "abcd2345",
        getController: vi.fn().mockResolvedValue(null),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const req = mockRequest("POST", {
        name: "test",
        controllerUrl: "https://example.com",
        connectorName: "test",
        authMode: "oauth2-cc",
        oauthClientId: "id",
        // missing oauthClientSecret and oauthTokenUrl
      });
      (req as any).url = "/internal/tunnel/creds";
      const res = mockResponse();

      await routes.handlePostCreds(req, res);

      expect(res._status).toBe(400);
      const body = JSON.parse(res._body);
      // Plaintext-field check fires first when tokenUrl is missing; missing
      // clientSecret alone (with tokenUrl present) would surface the
      // "oauthClientSecret is required" message instead.
      expect(body.error).toContain("oauthClientId and oauthTokenUrl are required");
    });

    it("INSERT: returns 400 when oauth2-cc is missing only oauthClientSecret (no prior row to preserve)", async () => {
      const mockStore = {
        getShimId: () => "abcd2345",
        getController: vi.fn().mockResolvedValue(null),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const req = mockRequest("POST", {
        name: "test",
        controllerUrl: "https://example.com",
        connectorName: "test",
        authMode: "oauth2-cc",
        oauthClientId: "id",
        oauthTokenUrl: "https://auth.example.com/token",
        // missing oauthClientSecret only
      });
      (req as any).url = "/internal/tunnel/creds";
      const res = mockResponse();

      await routes.handlePostCreds(req, res);

      expect(res._status).toBe(400);
      const body = JSON.parse(res._body);
      expect(body.error).toContain("oauthClientSecret is required");
    });

    // Pins the regression observed 2026-07-20: the Edit Tunnel modal renders
    // "Tunnel auth token (leave blank to keep existing)" and the frontend
    // omits tunnelAuthToken from the POST body when the field is blank. The
    // backend used to reject that with 400, forcing operators to re-paste
    // their token every time they wanted to rename the row or fix a URL
    // typo. The fix: when the prior row has a sealed secret for the same
    // authMode, treat the blank field as "keep existing" and let the SQL
    // COALESCE in upsertController preserve the value.
    describe("UPDATE with omitted secret (leave blank to keep existing)", () => {
      const priorStaticRow: ControllerRow = {
        id: "existing-id",
        name: "Convo Agent",
        controllerUrl: "http://localhost:3001",
        connectorName: "convo-agent",
        environment: null,
        authMode: "static-bearer",
        tunnelAuthToken: "ts_existing_secret",
        oauthClientId: null,
        oauthClientSecret: null,
        oauthTokenUrl: null,
        registrationToken: "reg-token",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastConnectedAt: null,
        lastDisconnectReason: null,
      };

      const priorOauthRow: ControllerRow = {
        ...priorStaticRow,
        authMode: "oauth2-cc",
        tunnelAuthToken: null,
        oauthClientId: "existing-client-id",
        oauthClientSecret: "existing-client-secret",
        oauthTokenUrl: "https://auth.example.com/token",
      };

      it("static-bearer + same authMode + blank token → 200 (upsert omits tunnelAuthToken; SQL preserves it)", async () => {
        const upsertController = vi.fn().mockResolvedValue({ ...priorStaticRow, name: "Convo Agent Renamed" });
        const mockStore = {
          getShimId: () => "abcd2345",
          getController: vi.fn().mockResolvedValue(priorStaticRow),
          upsertController,
          deleteController: vi.fn(),
        } as unknown as ConfigStore;

        const routes = createTunnelRoutes({
          configStore: mockStore,
          dialTunnel: vi.fn(),
          cycleTunnel: vi.fn().mockResolvedValue(undefined),
        });

        // Body matches what the frontend sends when the operator edits the
        // display name only and leaves the auth-token field blank.
        const req = mockRequest("POST", {
          name: "Convo Agent Renamed",
          controllerUrl: "http://localhost:3001",
          authMode: "static-bearer",
          // no tunnelAuthToken
        });
        (req as any).url = "/internal/tunnel/creds";
        const res = mockResponse();

        await routes.handlePostCreds(req, res);

        expect(res._status).toBe(200);
        expect(JSON.parse(res._body).ok).toBe(true);
        // The critical assertion: upsertController must NOT receive a
        // tunnelAuthToken. If a future change accidentally forwards an
        // empty-string token, the SQL branch would seal that empty string
        // as the row's auth token and break the WS handshake.
        expect(upsertController).toHaveBeenCalledOnce();
        const upsertInput = upsertController.mock.calls[0][0] as ControllerInput;
        expect(upsertInput.tunnelAuthToken).toBeUndefined();
      });

      it("oauth2-cc + same authMode + blank clientSecret → 200 (upsert omits oauthClientSecret)", async () => {
        const upsertController = vi.fn().mockResolvedValue(priorOauthRow);
        const mockStore = {
          getShimId: () => "abcd2345",
          getController: vi.fn().mockResolvedValue(priorOauthRow),
          upsertController,
          deleteController: vi.fn(),
        } as unknown as ConfigStore;

        const routes = createTunnelRoutes({
          configStore: mockStore,
          dialTunnel: vi.fn(),
          cycleTunnel: vi.fn().mockResolvedValue(undefined),
        });

        const req = mockRequest("POST", {
          name: "renamed",
          controllerUrl: "https://oauth.example.com",
          authMode: "oauth2-cc",
          oauthClientId: "existing-client-id",
          oauthTokenUrl: "https://auth.example.com/token",
          // no oauthClientSecret
        });
        (req as any).url = "/internal/tunnel/creds";
        const res = mockResponse();

        await routes.handlePostCreds(req, res);

        expect(res._status).toBe(200);
        const upsertInput = upsertController.mock.calls[0][0] as ControllerInput;
        expect(upsertInput.oauthClientSecret).toBeUndefined();
      });

      it("authMode switch (oauth2-cc → static-bearer) + blank token → 400 (no matching prior secret to preserve)", async () => {
        const mockStore = {
          getShimId: () => "abcd2345",
          getController: vi.fn().mockResolvedValue(priorOauthRow),
          upsertController: vi.fn(),
          deleteController: vi.fn(),
        } as unknown as ConfigStore;

        const routes = createTunnelRoutes({
          configStore: mockStore,
          dialTunnel: vi.fn(),
          cycleTunnel: vi.fn(),
        });

        const req = mockRequest("POST", {
          controllerUrl: "https://oauth.example.com",
          authMode: "static-bearer",
          // no tunnelAuthToken — but prior row was oauth2-cc, so nothing to preserve
        });
        (req as any).url = "/internal/tunnel/creds";
        const res = mockResponse();

        await routes.handlePostCreds(req, res);

        expect(res._status).toBe(400);
        expect(JSON.parse(res._body).error).toContain("tunnelAuthToken is required");
      });
    });

    it("returns 500 on DB error during upsert", async () => {
      const mockStore = {
        getShimId: () => "abcd2345",
        getController: vi.fn().mockResolvedValue(null),
        upsertController: vi.fn().mockRejectedValue(new Error("DB write failed")),
        deleteController: vi.fn(),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const req = mockRequest("POST", {
        name: "test",
        controllerUrl: "https://example.com",
        connectorName: "test",
        authMode: "static-bearer",
        tunnelAuthToken: "token",
      });
      (req as any).url = "/internal/tunnel/creds";
      const res = mockResponse();

      await routes.handlePostCreds(req, res);

      expect(res._status).toBe(500);
      const body = JSON.parse(res._body);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("DB write failed");
    });
  });

  describe("POST /internal/tunnel/force-reregister", () => {
    it("returns 409 when no row exists", async () => {
      const mockStore = {
        getShimId: () => "abcd2345",
        getController: vi.fn().mockResolvedValue(null),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const req = mockRequest("POST");
      (req as any).url = "/internal/tunnel/force-reregister";
      const res = mockResponse();

      await routes.handleForceReregister(req, res);

      expect(res._status).toBe(409);
      const body = JSON.parse(res._body);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("no controller row configured");
    });

    it("clears registration token and cycles tunnel when row exists", async () => {
      const mockRow: ControllerRow = {
        id: "test-id",
        name: "test-controller",
        controllerUrl: "https://example.com",
        connectorName: "test-connector",
        environment: null,
        authMode: "static-bearer",
        tunnelAuthToken: "token",
        oauthClientId: null,
        oauthClientSecret: null,
        oauthTokenUrl: null,
        registrationToken: "old-token",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastConnectedAt: null,
        lastDisconnectReason: null,
      };

      const clearRegistrationToken = vi.fn().mockResolvedValue(undefined);
      const cycleTunnel = vi.fn().mockResolvedValue(undefined);

      const mockStore = {
        getShimId: () => "abcd2345",
        getController: vi.fn().mockResolvedValue(mockRow),
        clearRegistrationToken,
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel,
      });

      const req = mockRequest("POST");
      (req as any).url = "/internal/tunnel/force-reregister";
      const res = mockResponse();

      await routes.handleForceReregister(req, res);

      expect(clearRegistrationToken).toHaveBeenCalledWith("test-id");
      expect(cycleTunnel).toHaveBeenCalledWith("force-reregister");
      expect(res._status).toBe(200);
      expect(JSON.parse(res._body).ok).toBe(true);
    });

    it("returns 500 on DB error", async () => {
      const mockStore = {
        getShimId: () => "abcd2345",
        getController: vi.fn().mockRejectedValue(new Error("DB error")),
      } as unknown as ConfigStore;

      const routes = createTunnelRoutes({
        configStore: mockStore,
        dialTunnel: vi.fn(),
        cycleTunnel: vi.fn(),
      });

      const req = mockRequest("POST");
      (req as any).url = "/internal/tunnel/force-reregister";
      const res = mockResponse();

      await routes.handleForceReregister(req, res);

      expect(res._status).toBe(500);
      const body = JSON.parse(res._body);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("DB error");
    });
  });
});

describe("normalizeControllerUrl", () => {
  // The controller UI's "Copy Controller URL" button hands the operator the
  // full WS endpoint (…/mcp-tunnel/tunnel), but the connector expects the
  // base URL and appends /mcp-tunnel itself. These tests pin the strip
  // behavior — anything ending in /mcp-tunnel[/…] gets trimmed, plus any
  // trailing slashes.

  it("leaves a bare base URL untouched", () => {
    expect(normalizeControllerUrl("https://tap-des.ngrok.dev")).toBe("https://tap-des.ngrok.dev");
  });

  it("strips a single trailing /mcp-tunnel", () => {
    expect(normalizeControllerUrl("https://tap-des.ngrok.dev/mcp-tunnel"))
      .toBe("https://tap-des.ngrok.dev");
  });

  it("strips /mcp-tunnel/tunnel (the exact string the controller copy button emits)", () => {
    expect(normalizeControllerUrl("https://tap-des.ngrok.dev/mcp-tunnel/tunnel"))
      .toBe("https://tap-des.ngrok.dev");
  });

  it("strips /mcp-tunnel with a trailing slash", () => {
    expect(normalizeControllerUrl("https://tap-des.ngrok.dev/mcp-tunnel/"))
      .toBe("https://tap-des.ngrok.dev");
  });

  it("strips a plain trailing slash on a base URL", () => {
    expect(normalizeControllerUrl("https://tap-des.ngrok.dev/"))
      .toBe("https://tap-des.ngrok.dev");
  });

  it("strips multiple trailing slashes", () => {
    expect(normalizeControllerUrl("https://tap-des.ngrok.dev///"))
      .toBe("https://tap-des.ngrok.dev");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeControllerUrl("  https://tap-des.ngrok.dev/mcp-tunnel  "))
      .toBe("https://tap-des.ngrok.dev");
  });

  it("preserves an unrelated path so it can fail loudly on dial (rather than silently mangled)", () => {
    // Someone pastes .../v2 or .../api — we DON'T assume that's wrong. Only
    // /mcp-tunnel is the known-bad-suffix pattern. Unrelated paths pass
    // through and error at dial time with a clear ECONNREFUSED / 404.
    expect(normalizeControllerUrl("https://tap-des.ngrok.dev/api"))
      .toBe("https://tap-des.ngrok.dev/api");
  });

  it("is idempotent (safe to run twice)", () => {
    const once = normalizeControllerUrl("https://tap-des.ngrok.dev/mcp-tunnel/tunnel");
    const twice = normalizeControllerUrl(once);
    expect(twice).toBe(once);
  });

  it("case-insensitive match on /mcp-tunnel", () => {
    expect(normalizeControllerUrl("https://tap-des.ngrok.dev/MCP-Tunnel/Tunnel"))
      .toBe("https://tap-des.ngrok.dev");
  });
});

describe("POST /internal/tunnel/creds — URL normalization integrated", () => {
  it("stores the normalized (stripped) URL when the operator pastes the full WS endpoint", async () => {
    let upsertedUrl: string | undefined;
    const mockStore = {
      getShimId: () => "abcd2345",
      getController: vi.fn().mockResolvedValue(null),
      upsertController: vi.fn().mockImplementation(async (input: ControllerInput) => {
        upsertedUrl = input.controllerUrl;
        return {
          id: "row-id",
          name: input.name,
          controllerUrl: input.controllerUrl,
          connectorName: input.connectorName,
          environment: input.environment,
          authMode: input.authMode,
          tunnelAuthToken: input.tunnelAuthToken ?? null,
          oauthClientId: null,
          oauthClientSecret: null,
          oauthTokenUrl: null,
          registrationToken: null,
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastConnectedAt: null,
          lastDisconnectReason: null,
        } as ControllerRow;
      }),
      deleteController: vi.fn(),
    } as unknown as ConfigStore;

    const routes = createTunnelRoutes({
      configStore: mockStore,
      dialTunnel: vi.fn().mockResolvedValue(undefined),
      cycleTunnel: vi.fn(),
    });

    // Operator pastes the full WS endpoint (what the controller UI copies).
    const req = mockRequest("POST", {
      name: "test-row",
      controllerUrl: "https://tap-des.ngrok.dev/mcp-tunnel/tunnel",
      connectorName: "my-conn",
      environment: "dev",
      authMode: "static-bearer",
      tunnelAuthToken: "ts_test",
    });
    (req as any).url = "/internal/tunnel/creds";
    const res = mockResponse();

    await routes.handlePostCreds(req, res);

    expect(res._status).toBe(200);
    expect(upsertedUrl).toBe("https://tap-des.ngrok.dev");
  });
});
