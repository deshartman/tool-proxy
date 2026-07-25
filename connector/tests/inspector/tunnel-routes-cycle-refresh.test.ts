import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createTunnelRoutes } from "../../src/inspector/tunnel-routes.js";
import type { ConfigStore, ControllerInput, ControllerRow } from "../../src/config-store/index.js";

// Regression test for the credential-rotated cycle refresh bug caught
// in real dev-loop use (2026-07-12).
//
// Symptom: operator rotates the Tunnel Security row on the controller,
// pastes the new bearer via the connector's Edit modal, clicks Save &
// reconnect. The DB row's tunnel_auth_token_ct is correctly rewritten
// with the new sealed value, and cycleTunnel("credential-rotated") fires
// — but the connector's next WS upgrade presents the STALE bearer from
// the initial boot. Controller returns 401 because it doesn't recognize
// the stale bearer anymore.
//
// Root cause: the tunnel-routes handler calls cycleTunnel(reason) after
// an UPDATE upsert, but doesn't thread the fresh row through. The
// cycleTunnel closure in bootFromDb must re-read the row from Postgres
// before calling reconnect — otherwise reconnect uses the stale
// in-memory `row`/`auth`/`tunnelDialUrl` from the outer bootFromDb
// scope.
//
// This test exercises the routes-level contract: after handlePostCreds
// completes the UPDATE path, cycleTunnel MUST fire. The bootFromDb-side
// refresh is tested against real db-mode boot flow in the lifecycle
// integration tests (out of scope here — those need a live Postgres).
// What we can pin here is that the routes call the right closure at the
// right time, so any regression that stops calling cycleTunnel on
// UPDATE would fail this test.

function mockRequest(method: string, body?: unknown): IncomingMessage {
  return {
    method,
    url: "/internal/tunnel/creds",
    headers: {},
    on: vi.fn(),
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), "utf8");
    },
  } as unknown as IncomingMessage;
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
    id: "row-id",
    name: "test",
    controllerUrl: "https://old.example.com",
    connectorName: "old-name",
    environment: null,
    authMode: "static-bearer",
    tunnelAuthToken: "ts_old_bearer",
    oauthClientId: null,
    oauthClientSecret: null,
    oauthTokenUrl: null,
    registrationToken: null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastConnectedAt: null,
    lastDisconnectReason: null,
    ...overrides,
  };
}

describe("tunnel-routes — UPDATE fires cycleTunnel (regression pin for stale-cred cycle bug)", () => {
  it("credential-rotated cycle: POST /creds on an existing row calls cycleTunnel exactly once", async () => {
    const priorRow = makeRow();
    const updatedRow = makeRow({ tunnelAuthToken: "ts_new_bearer" });

    const cycleTunnel = vi.fn().mockResolvedValue(undefined);
    const dialTunnel = vi.fn().mockResolvedValue(undefined);

    const mockStore = {
      getController: vi.fn().mockResolvedValue(priorRow),
      upsertController: vi.fn().mockResolvedValue(updatedRow),
      deleteController: vi.fn(),
    } as unknown as ConfigStore;

    const routes = createTunnelRoutes({ configStore: mockStore, dialTunnel, cycleTunnel });

    const req = mockRequest("POST", {
      controllerUrl: "https://old.example.com",
      authMode: "static-bearer",
      tunnelAuthToken: "ts_new_bearer",
    });
    const res = mockResponse();

    await routes.handlePostCreds(req, res);

    expect(res._status).toBe(200);
    expect(cycleTunnel).toHaveBeenCalledTimes(1);
    expect(cycleTunnel).toHaveBeenCalledWith("credential-rotated");
    // dialTunnel is NOT called on UPDATE — that's the INSERT path.
    expect(dialTunnel).not.toHaveBeenCalled();
  });

  it("cycleTunnel receives a reason string, not the row — the reason is how bootFromDb knows to refresh", async () => {
    // Contract note: cycleTunnel's signature is (reason: string) => Promise<void>.
    // The row is intentionally NOT threaded through — the bootFromDb-side
    // closure re-reads from ConfigStore before dialing so it picks up the
    // freshly-upserted values (including any that other operators wrote
    // concurrently). Threading a row through here would tempt callers to
    // trust it as the source of truth, which is subtly wrong.
    const priorRow = makeRow();
    const updatedRow = makeRow({ tunnelAuthToken: "ts_new" });

    let capturedArgs: unknown[] = [];
    const cycleTunnel = vi.fn().mockImplementation(async (...args) => {
      capturedArgs = args;
    });

    const mockStore = {
      getController: vi.fn().mockResolvedValue(priorRow),
      upsertController: vi.fn().mockResolvedValue(updatedRow),
      deleteController: vi.fn(),
    } as unknown as ConfigStore;

    const routes = createTunnelRoutes({
      configStore: mockStore,
      dialTunnel: vi.fn(),
      cycleTunnel,
    });

    await routes.handlePostCreds(
      mockRequest("POST", {
        controllerUrl: "https://x.example.com",
        authMode: "static-bearer",
        tunnelAuthToken: "ts_new",
      }),
      mockResponse(),
    );

    expect(capturedArgs).toEqual(["credential-rotated"]);
    expect(capturedArgs.length).toBe(1);  // No row/auth threaded through — bootFromDb refreshes.
  });
});
