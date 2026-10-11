import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Inspector, startInspector } from "@connector/inspector/server.js";
import { createNetworkAccessRoutes } from "@connector/inspector/network-access-routes.js";
import { openTempStore, type StoreFixture } from "../helpers/config-store.js";

// Regression pin for a crash found by the first two-workspace browser run of
// Phase 6. With two controllers configured, opening the inspector GETs
// /internal/network-access/trusted-issuer; that route still asked the store
// for "the" trusted issuer, the store (correctly) refused to guess between
// two, and the throw escaped a `void`ed route promise — exiting the whole
// connector and every tenant's tunnel with it.
//
// Two layers pinned: the route itself handles several controllers, and ANY
// route that rejects costs one request (a 500), never the process.

let fixture: StoreFixture;
let server: Server;
let port: number;
let inspector: Inspector;

const controller = (name: string) => ({
  name, controllerUrl: `https://${name}.example.com`, connectorName: name, environment: null,
  authMode: "static-bearer" as const, tunnelAuthToken: `ts_${name}`,
});
const issuer = (aud: string) => ({ issuer: "https://idp.example.com", jwksUrl: "https://idp.example.com/jwks", audience: aud });
const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-inspector-request": "1" },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  fixture = await openTempStore();
  inspector = new Inspector();
  inspector.wireNetworkAccessRoutes(createNetworkAccessRoutes({ configStore: fixture.store, rebindNonLoopback: () => {} }));
  server = startInspector(0, inspector);
  await new Promise<void>((r) => server.once("listening", () => r()));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fixture.cleanup();
});

describe("network-access routes with several controllers", () => {
  it("GET trusted-issuer with no controllerId answers with every entry's config (no crash)", async () => {
    const a = await fixture.store.addController(controller("a"));
    const b = await fixture.store.addController(controller("b"));
    await fixture.store.setTrustedIssuerConfig(issuer("aud-a"), a.id);
    const res = await fetch(`http://127.0.0.1:${port}/internal/network-access/trusted-issuer`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configs).toEqual([{ ...issuer("aud-a"), controllerId: a.id }]);
    // And a per-controller read still works.
    const one = await (await fetch(`http://127.0.0.1:${port}/internal/network-access/trusted-issuer?controllerId=${b.id}`)).json();
    expect(one.config).toBeNull();
  });

  it("set / clear name their controller; omitting it with several is a 400, not a crash", async () => {
    const a = await fixture.store.addController(controller("a"));
    await fixture.store.addController(controller("b"));
    expect((await post("/internal/network-access/trusted-issuer", issuer("x"))).status).toBe(400);
    expect((await post("/internal/network-access/trusted-issuer", { ...issuer("x"), controllerId: a.id })).status).toBe(200);
    expect(await fixture.store.getTrustedIssuerConfig(a.id)).toEqual(issuer("x"));
    expect((await post("/internal/network-access/trusted-issuer/clear", {})).status).toBe(400);
    expect((await post("/internal/network-access/trusted-issuer/clear", { controllerId: a.id })).status).toBe(200);
  });

  it("the same iss + aud on a second controller is a 409", async () => {
    const a = await fixture.store.addController(controller("a"));
    const b = await fixture.store.addController(controller("b"));
    await post("/internal/network-access/trusted-issuer", { ...issuer("same"), controllerId: a.id });
    expect((await post("/internal/network-access/trusted-issuer", { ...issuer("same"), controllerId: b.id })).status).toBe(409);
  });

  it("adding an API client names its controller; the list shows the binding", async () => {
    await fixture.store.addController(controller("a"));
    const b = await fixture.store.addController(controller("b"));
    expect((await post("/internal/network-access/clients", { name: "ci" })).status).toBe(400);
    expect((await post("/internal/network-access/clients", { name: "ci", controllerId: b.id })).status).toBe(200);
    const list = await (await fetch(`http://127.0.0.1:${port}/internal/network-access/clients`)).json();
    expect(list.clients.map((c: { controllerId: string }) => c.controllerId)).toEqual([b.id]);
  });
});

describe("a failing route never takes the process down", () => {
  it("a handler that throws gets a 500, and the server keeps serving", async () => {
    inspector.wireOauthToken(async () => { throw new Error("boom"); });
    const res = await fetch(`http://127.0.0.1:${port}/oauth/token`, { method: "POST", body: "" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("boom");
    // Still alive.
    expect((await fetch(`http://127.0.0.1:${port}/internal/network-access/status`)).status).toBe(200);
  });
});
