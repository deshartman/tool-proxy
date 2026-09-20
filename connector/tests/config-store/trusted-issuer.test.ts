import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { ConfigStore } from "../../src/config-store/index.js";
import { openTempStore, type StoreFixture } from "../helpers/config-store.js";

// FEDERATED-JWT-MODE — trusted_issuer_config round trip against a real
// Postgres schema (no mocking), mirroring network-access-state.test.ts.
// Presence of all three columns = configured; absence = undefined. Not
// sealed — issuer/JWKS URL/audience are public IdP metadata.

describe("ConfigStore — trusted issuer config", () => {
  let fixture: StoreFixture;
  let store: ConfigStore | undefined;

  const sample = { issuer: "https://idp.example.com", jwksUrl: "https://idp.example.com/.well-known/jwks.json", audience: "mcp-connector" };

  beforeEach(async () => {
    fixture = await openTempStore();
    store = fixture.store;
  });

  afterEach(async () => {
    await fixture.cleanup();
    store = undefined;
  });

  it("getTrustedIssuerConfig() returns undefined when unset", async () => {
    expect(await store!.getTrustedIssuerConfig()).toBeUndefined();
  });

  it("setTrustedIssuerConfig() persists and round-trips", async () => {
    await store!.setTrustedIssuerConfig(sample);
    expect(await store!.getTrustedIssuerConfig()).toEqual(sample);
  });

  it("a second setTrustedIssuerConfig() overwrites (upsert, not duplicate insert)", async () => {
    await store!.setTrustedIssuerConfig(sample);
    const next = { issuer: "https://other.example.com", jwksUrl: "https://other.example.com/jwks", audience: "other-aud" };
    await store!.setTrustedIssuerConfig(next);
    expect(await store!.getTrustedIssuerConfig()).toEqual(next);
  });

  it("clearTrustedIssuerConfig() returns it to undefined", async () => {
    await store!.setTrustedIssuerConfig(sample);
    expect(await store!.getTrustedIssuerConfig()).toEqual(sample);
    await store!.clearTrustedIssuerConfig();
    expect(await store!.getTrustedIssuerConfig()).toBeUndefined();
  });
});
