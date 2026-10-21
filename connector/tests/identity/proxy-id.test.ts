import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { isProxyId, mintProxyId } from "../../src/identity/proxy-id.js";
import { makeMasterKey, openTempStore, type StoreFixture } from "../helpers/config-store.js";

// MULTI-PLATFORM-MCP §3.1. The proxy id names this proxy in every tool name on
// every platform it connects to, so its LIFETIME is the property that matters:
// minted once, kept across restarts and key rotation, never silently re-minted,
// changed only by the operator's deliberate regenerate. A silent re-mint would
// break every procedure ref to this proxy's tools with no error anywhere.

describe("mintProxyId", () => {
  it("produces 8 lowercase Crockford base32 characters", () => {
    for (let i = 0; i < 500; i++) {
      const id = mintProxyId();
      expect(id).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{8}$/);
      expect(isProxyId(id)).toBe(true);
    }
  });

  it("never emits the excluded letters i l o u", () => {
    const all = Array.from({ length: 2000 }, mintProxyId).join("");
    expect(all).not.toMatch(/[ilou]/);
  });

  it("is effectively unique", () => {
    const ids = new Set(Array.from({ length: 5000 }, mintProxyId));
    expect(ids.size).toBe(5000);
  });

  it("rejects malformed ids", () => {
    for (const bad of ["", "ABCD2345", "abcd234", "abcd23456", "abcd234i", "abcd-234", 42, null]) {
      expect(isProxyId(bad)).toBe(false);
    }
  });
});

describe("ConfigStore proxyId lifetime", () => {
  let fixture: StoreFixture;
  afterEach(async () => { await fixture.cleanup(); });

  it("is minted on a fresh store and persisted to disk", async () => {
    fixture = await openTempStore();
    const id = fixture.store.getProxyId();
    expect(isProxyId(id)).toBe(true);
    expect(JSON.parse(readFileSync(fixture.path, "utf8")).proxyId).toBe(id);
  });

  it("survives a reopen (connector restart)", async () => {
    fixture = await openTempStore();
    const id = fixture.store.getProxyId();
    const reopened = await fixture.reopen();
    expect(reopened.getProxyId()).toBe(id);
  });

  it("is back-filled exactly once for a store written before the field existed", async () => {
    fixture = await openTempStore();
    const doc = JSON.parse(readFileSync(fixture.path, "utf8"));
    delete doc.shimId;
    delete doc.proxyId;
    writeFileSync(fixture.path, JSON.stringify(doc));

    const first = (await fixture.reopen()).getProxyId();
    expect(isProxyId(first)).toBe(true);
    // A second open must keep the back-filled id, not mint another.
    expect((await fixture.reopen()).getProxyId()).toBe(first);
  });

  it("is not version-bumped, so an older connector can still read the store", async () => {
    fixture = await openTempStore();
    expect(JSON.parse(readFileSync(fixture.path, "utf8")).version).toBe(1);
  });

  it("does not change when the master key is rotated", async () => {
    // Rotation re-seals under a new key; the id is unsealed and not derived from
    // the key, so it must be untouched. Simulated by re-stamping the fingerprint.
    fixture = await openTempStore();
    const id = fixture.store.getProxyId();
    const next = makeMasterKey();
    const doc = JSON.parse(readFileSync(fixture.path, "utf8"));
    doc.keyFingerprint = next.fingerprint;
    writeFileSync(fixture.path, JSON.stringify(doc));
    expect((await fixture.reopen(next)).getProxyId()).toBe(id);
  });

  it("changes only on regenerate, and the new id persists", async () => {
    fixture = await openTempStore();
    const before = fixture.store.getProxyId();
    const after = await fixture.store.regenerateProxyId();
    expect(after).not.toBe(before);
    expect(isProxyId(after)).toBe(true);
    expect((await fixture.reopen()).getProxyId()).toBe(after);
  });

  it("re-mints a hand-corrupted id rather than trusting it", async () => {
    fixture = await openTempStore();
    const doc = JSON.parse(readFileSync(fixture.path, "utf8"));
    doc.proxyId = "NOT.A.VALID.ID";
    doc.shimId = "NOT.A.VALID.ID";
    writeFileSync(fixture.path, JSON.stringify(doc));
    expect(isProxyId((await fixture.reopen()).getProxyId())).toBe(true);
  });
});

// RENAME-TOOL-PROXY §4.2. A store written before the rename carries `shimId`.
// The value must move to `proxyId` VERBATIM (it names the proxy in every tool
// name), both keys are written for one release so a rollback keeps its id, and
// `proxyId` is read first.
describe("ConfigStore shimId -> proxyId migration", () => {
  let fixture: StoreFixture;
  afterEach(async () => { await fixture.cleanup(); });
  const rewrite = (doc: Record<string, unknown>) => writeFileSync(fixture.path, JSON.stringify(doc));
  const readJson = () => JSON.parse(readFileSync(fixture.path, "utf8"));

  it("only shimId: value preserved verbatim into proxyId, shimId kept", async () => {
    fixture = await openTempStore();
    const doc = readJson();
    delete doc.proxyId;
    doc.shimId = "cra85py8";
    rewrite(doc);
    const store = await fixture.reopen();
    expect(store.getProxyId()).toBe("cra85py8");
    expect(readJson().proxyId).toBe("cra85py8");
    expect(readJson().shimId).toBe("cra85py8");
  });

  it("only proxyId: unchanged, and shimId is dual-written to match", async () => {
    fixture = await openTempStore();
    const doc = readJson();
    delete doc.shimId;
    doc.proxyId = "cra85py8";
    rewrite(doc);
    expect((await fixture.reopen()).getProxyId()).toBe("cra85py8");
    expect(readJson().proxyId).toBe("cra85py8");
    expect(readJson().shimId).toBe("cra85py8");
  });

  it("neither: minted once, into both keys, and stable across reopen", async () => {
    fixture = await openTempStore();
    const doc = readJson();
    delete doc.shimId;
    delete doc.proxyId;
    rewrite(doc);
    const first = (await fixture.reopen()).getProxyId();
    expect(isProxyId(first)).toBe(true);
    expect(readJson().shimId).toBe(first);
    expect((await fixture.reopen()).getProxyId()).toBe(first);
  });

  it("both present and different: proxyId wins", async () => {
    fixture = await openTempStore();
    const doc = readJson();
    doc.proxyId = "cra85py8";
    doc.shimId = "abcd2345";
    rewrite(doc);
    expect((await fixture.reopen()).getProxyId()).toBe("cra85py8");
    expect(readJson().shimId).toBe("cra85py8");
  });

  it("regenerate writes both keys", async () => {
    fixture = await openTempStore();
    const next = await fixture.store.regenerateProxyId();
    expect(readJson().proxyId).toBe(next);
    expect(readJson().shimId).toBe(next);
  });

  it("a corrupt file throws and is never read as a fresh install", async () => {
    fixture = await openTempStore();
    writeFileSync(fixture.path, "{ not json");
    await expect(fixture.reopen()).rejects.toThrow();
  });
});
