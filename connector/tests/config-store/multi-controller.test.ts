import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { ConfigStore, type ControllerInput } from "../../src/config-store/index.js";
import { openTempStore, type StoreFixture } from "../helpers/config-store.js";

// MULTI-PLATFORM-MCP Phase 6 (§5.2, §5.6). The store holds one entry per
// controller — one TunnelWorkspace each — and the per-controller settings that
// used to be process-wide (API clients, the trusted issuer) are bound to an
// entry. Pinned here: entries are independent, the single-controller
// shorthand refuses to guess once there are several, and a pre-Phase-6 store
// is migrated onto its one controller exactly.

const input = (name: string, url = `https://${name}.example.com`): ControllerInput => ({
  name,
  controllerUrl: url,
  connectorName: name,
  environment: null,
  authMode: "static-bearer",
  tunnelAuthToken: `ts_${name}_bearer`,
});

const issuer = (aud: string) => ({ issuer: "https://idp.example.com", jwksUrl: "https://idp.example.com/jwks", audience: aud });

describe("ConfigStore — several controllers", () => {
  let fixture: StoreFixture;
  let store: ConfigStore;

  beforeEach(async () => {
    fixture = await openTempStore();
    store = fixture.store;
  });
  afterEach(async () => { await fixture.cleanup(); });

  it("addController appends independent entries with distinct ids", async () => {
    const a = await store.addController(input("a"));
    const b = await store.addController(input("b"));
    expect(a.id).not.toBe(b.id);
    expect((await store.listControllers()).map((c) => c.name)).toEqual(["a", "b"]);
    expect((await store.getControllerById(b.id))!.tunnelAuthToken).toBe("ts_b_bearer");
  });

  it("updateController changes one entry and keeps its id and registration token", async () => {
    const a = await store.addController(input("a"));
    const b = await store.addController(input("b"));
    await store.updateRegistrationToken(a.id, "tok-a");
    const rotated = await store.updateController(a.id, { ...input("a"), tunnelAuthToken: "ts_a_rotated" });
    expect(rotated.id).toBe(a.id);
    expect(rotated.registrationToken).toBe("tok-a");
    expect(rotated.tunnelAuthToken).toBe("ts_a_rotated");
    expect((await store.getControllerById(b.id))!.tunnelAuthToken).toBe("ts_b_bearer");
  });

  it("removeController drops only that entry", async () => {
    const a = await store.addController(input("a"));
    const b = await store.addController(input("b"));
    expect(await store.removeController(a.id)).toBe(true);
    expect((await store.listControllers()).map((c) => c.id)).toEqual([b.id]);
    expect(await store.removeController(a.id)).toBe(false);
  });

  it("concurrent addController calls each land (the mutex holds for appends too)", async () => {
    await Promise.all(["a", "b", "c"].map((n) => store.addController(input(n))));
    expect((await store.listControllers()).map((c) => c.name).sort()).toEqual(["a", "b", "c"]);
  });

  describe("API clients are bound to a controller", () => {
    it("a client minted with one controller is bound to it", async () => {
      const a = await store.addController(input("a"));
      const { clientId } = await store.mintApiClient("ci");
      expect(await store.apiClientController(clientId)).toBe(a.id);
      expect((await store.listApiClients())[0].controllerId).toBe(a.id);
    });

    it("with several controllers a client must name one — the shorthand never guesses", async () => {
      await store.addController(input("a"));
      const b = await store.addController(input("b"));
      await expect(store.mintApiClient("ci")).rejects.toThrow(/several controllers/);
      const { clientId } = await store.mintApiClient("ci", b.id);
      expect(await store.apiClientController(clientId)).toBe(b.id);
    });

    it("a client minted before any controller is bound to the first one added", async () => {
      const { clientId } = await store.mintApiClient("early");
      expect(await store.apiClientController(clientId)).toBeUndefined();
      const a = await store.addController(input("a"));
      await store.addController(input("b"));
      expect(await store.apiClientController(clientId)).toBe(a.id);
    });

    it("a revoked client resolves to no controller", async () => {
      await store.addController(input("a"));
      const { clientId } = await store.mintApiClient("ci");
      await store.revokeApiClient(clientId);
      expect(await store.apiClientController(clientId)).toBeUndefined();
    });
  });

  describe("trusted issuers are per controller", () => {
    it("each entry has its own, and a token is routed by iss + aud", async () => {
      const a = await store.addController(input("a"));
      const b = await store.addController(input("b"));
      await store.setTrustedIssuerConfig(issuer("aud-a"), a.id);
      await store.setTrustedIssuerConfig(issuer("aud-b"), b.id);
      expect(await store.getTrustedIssuerConfig(a.id)).toEqual(issuer("aud-a"));
      expect(await store.findControllerByIssuer("https://idp.example.com", "aud-b")).toBe(b.id);
      expect(await store.findControllerByIssuer("https://idp.example.com", "aud-x")).toBeUndefined();
    });

    it("refuses the same iss + aud on two controllers (one IdP must not drive two tunnels)", async () => {
      const a = await store.addController(input("a"));
      const b = await store.addController(input("b"));
      await store.setTrustedIssuerConfig(issuer("shared"), a.id);
      await expect(store.setTrustedIssuerConfig(issuer("shared"), b.id)).rejects.toThrow(/already trusted/);
    });

    it("re-setting the same pair on the SAME controller is fine", async () => {
      const a = await store.addController(input("a"));
      await store.setTrustedIssuerConfig(issuer("x"), a.id);
      await store.setTrustedIssuerConfig(issuer("x"), a.id);
      expect(await store.getTrustedIssuerConfig(a.id)).toEqual(issuer("x"));
    });

    it("rotating a controller's credential keeps its trusted issuer", async () => {
      const a = await store.addController(input("a"));
      await store.setTrustedIssuerConfig(issuer("x"), a.id);
      await store.updateController(a.id, { ...input("a"), tunnelAuthToken: "rotated" });
      expect(await store.getTrustedIssuerConfig(a.id)).toEqual(issuer("x"));
    });

    it("an issuer set before any controller moves into the first one added", async () => {
      await store.setTrustedIssuerConfig(issuer("early"));
      const a = await store.addController(input("a"));
      expect(await store.getTrustedIssuerConfig(a.id)).toEqual(issuer("early"));
      expect(JSON.parse(readFileSync(fixture.path, "utf8")).trustedIssuer).toBeNull();
    });
  });

  it("migrates a pre-Phase-6 store onto its one controller at open()", async () => {
    const a = await store.addController(input("a"));
    // Hand-write the legacy shape: top-level issuer, an unbound client.
    const doc = JSON.parse(readFileSync(fixture.path, "utf8"));
    doc.trustedIssuer = issuer("legacy");
    doc.apiClients = [{ clientId: "c1", clientSecretCt: "x", name: null, createdAt: new Date().toISOString(), revokedAt: null }];
    delete doc.controllers[0].trustedIssuer;
    writeFileSync(fixture.path, JSON.stringify(doc));

    const reopened = await fixture.reopen();
    expect(await reopened.getTrustedIssuerConfig(a.id)).toEqual(issuer("legacy"));
    expect(await reopened.apiClientController("c1")).toBe(a.id);
    const after = JSON.parse(readFileSync(fixture.path, "utf8"));
    expect(after.trustedIssuer).toBeNull();
    expect(after.apiClients[0].controllerId).toBe(a.id);
  });
});
