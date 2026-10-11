import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Inspector, startInspector } from "@connector/inspector/server.js";
import { createTunnelRoutes } from "@connector/inspector/tunnel-routes.js";
import { openTempStore, type StoreFixture } from "../helpers/config-store.js";

// MULTI-PLATFORM-MCP §5.1 / §5.8 — the controller list over HTTP, against a
// real store. Adding an entry starts a workspace, editing one by id cycles
// THAT one, removing one stops it; a failed add rolls back only itself.

let fixture: StoreFixture;
let server: Server;
let port: number;
const dialTunnel = vi.fn();
const cycleTunnel = vi.fn();
const removeTunnel = vi.fn();

beforeEach(async () => {
  fixture = await openTempStore();
  dialTunnel.mockReset().mockResolvedValue(undefined);
  cycleTunnel.mockReset().mockResolvedValue(undefined);
  removeTunnel.mockReset().mockResolvedValue(undefined);
  const inspector = new Inspector();
  inspector.wireTunnelRoutes(createTunnelRoutes({ configStore: fixture.store, dialTunnel, cycleTunnel, removeTunnel }));
  server = startInspector(0, inspector);
  await new Promise<void>((r) => server.once("listening", () => r()));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fixture.cleanup();
});

const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-inspector-request": "1" },
  body: JSON.stringify(body),
});
const entry = (host: string) => ({ controllerUrl: `https://${host}.example.com`, authMode: "static-bearer", tunnelAuthToken: `ts_${host}` });

describe("tunnel list routes", () => {
  it("/internal/tunnel/add always adds a new entry and starts its workspace", async () => {
    const a = await (await post("/internal/tunnel/add", entry("a"))).json();
    const b = await (await post("/internal/tunnel/add", entry("b"))).json();
    expect(a.ok && b.ok).toBe(true);
    expect(a.id).not.toBe(b.id);
    expect(dialTunnel).toHaveBeenCalledTimes(2);

    const list = await (await fetch(`http://127.0.0.1:${port}/internal/tunnels`)).json();
    expect(list.rows.map((r: { name: string }) => r.name)).toEqual(["a", "b"]);
    // Secrets never ride the list — only presence flags.
    expect(JSON.stringify(list)).not.toContain("ts_a");
  });

  it("/internal/tunnel/creds with an id edits THAT entry and cycles only it", async () => {
    await post("/internal/tunnel/add", entry("a"));
    const { id: idB } = await (await post("/internal/tunnel/add", entry("b"))).json();
    const res = await post("/internal/tunnel/creds", { ...entry("b"), id: idB, tunnelAuthToken: "ts_rotated" });
    expect(res.status).toBe(200);
    expect(cycleTunnel).toHaveBeenCalledWith("credential-rotated", idB);
    expect((await fixture.store.getControllerById(idB))!.tunnelAuthToken).toBe("ts_rotated");
    expect((await fixture.store.listControllers())[0].tunnelAuthToken).toBe("ts_a");
  });

  it("/internal/tunnel/creds with an unknown id is a 404 and changes nothing", async () => {
    const res = await post("/internal/tunnel/creds", { ...entry("x"), id: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(404);
    expect(await fixture.store.listControllers()).toEqual([]);
  });

  it("a failed add rolls back only the new entry", async () => {
    await post("/internal/tunnel/add", entry("a"));
    dialTunnel.mockRejectedValueOnce(new Error("handshake refused"));
    const res = await post("/internal/tunnel/add", entry("b"));
    expect(res.status).toBe(409);
    expect((await fixture.store.listControllers()).map((r) => r.name)).toEqual(["a"]);
  });

  it("/internal/tunnel/remove stops the workspace, then removes the entry", async () => {
    const { id } = await (await post("/internal/tunnel/add", entry("a"))).json();
    await post("/internal/tunnel/add", entry("b"));
    const res = await post("/internal/tunnel/remove", { id });
    expect(res.status).toBe(200);
    expect(removeTunnel).toHaveBeenCalledWith(id);
    expect((await fixture.store.listControllers()).map((r) => r.name)).toEqual(["b"]);
  });

  it("/internal/tunnel/remove needs an id that exists", async () => {
    expect((await post("/internal/tunnel/remove", {})).status).toBe(400);
    expect((await post("/internal/tunnel/remove", { id: "nope" })).status).toBe(404);
    expect(removeTunnel).not.toHaveBeenCalled();
  });

  it("force-reregister with an id clears and cycles only that entry", async () => {
    const { id: idA } = await (await post("/internal/tunnel/add", entry("a"))).json();
    const { id: idB } = await (await post("/internal/tunnel/add", entry("b"))).json();
    await fixture.store.updateRegistrationToken(idA, "tok-a");
    await fixture.store.updateRegistrationToken(idB, "tok-b");
    expect((await post("/internal/tunnel/force-reregister", { id: idB })).status).toBe(200);
    expect(cycleTunnel).toHaveBeenCalledWith("force-reregister", idB);
    expect((await fixture.store.getControllerById(idA))!.registrationToken).toBe("tok-a");
    expect((await fixture.store.getControllerById(idB))!.registrationToken).toBeNull();
  });

  it("regenerating the shimId redials EVERY workspace", async () => {
    const { id: idA } = await (await post("/internal/tunnel/add", entry("a"))).json();
    const { id: idB } = await (await post("/internal/tunnel/add", entry("b"))).json();
    expect((await post("/internal/identity/regenerate", {})).status).toBe(200);
    expect(cycleTunnel.mock.calls).toEqual([["shim-id-regenerated", idA], ["shim-id-regenerated", idB]]);
  });
});
