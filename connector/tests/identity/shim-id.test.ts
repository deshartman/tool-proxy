import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { isShimId, mintShimId } from "../../src/identity/shim-id.js";
import { makeMasterKey, openTempStore, type StoreFixture } from "../helpers/config-store.js";

// MULTI-PLATFORM-MCP §3.1. The shim id names this shim in every tool name on
// every platform it connects to, so its LIFETIME is the property that matters:
// minted once, kept across restarts and key rotation, never silently re-minted,
// changed only by the operator's deliberate regenerate. A silent re-mint would
// break every procedure ref to this shim's tools with no error anywhere.

describe("mintShimId", () => {
  it("produces 8 lowercase Crockford base32 characters", () => {
    for (let i = 0; i < 500; i++) {
      const id = mintShimId();
      expect(id).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{8}$/);
      expect(isShimId(id)).toBe(true);
    }
  });

  it("never emits the excluded letters i l o u", () => {
    const all = Array.from({ length: 2000 }, mintShimId).join("");
    expect(all).not.toMatch(/[ilou]/);
  });

  it("is effectively unique", () => {
    const ids = new Set(Array.from({ length: 5000 }, mintShimId));
    expect(ids.size).toBe(5000);
  });

  it("rejects malformed ids", () => {
    for (const bad of ["", "ABCD2345", "abcd234", "abcd23456", "abcd234i", "abcd-234", 42, null]) {
      expect(isShimId(bad)).toBe(false);
    }
  });
});

describe("ConfigStore shimId lifetime", () => {
  let fixture: StoreFixture;
  afterEach(async () => { await fixture.cleanup(); });

  it("is minted on a fresh store and persisted to disk", async () => {
    fixture = await openTempStore();
    const id = fixture.store.getShimId();
    expect(isShimId(id)).toBe(true);
    expect(JSON.parse(readFileSync(fixture.path, "utf8")).shimId).toBe(id);
  });

  it("survives a reopen (connector restart)", async () => {
    fixture = await openTempStore();
    const id = fixture.store.getShimId();
    const reopened = await fixture.reopen();
    expect(reopened.getShimId()).toBe(id);
  });

  it("is back-filled exactly once for a store written before the field existed", async () => {
    fixture = await openTempStore();
    const doc = JSON.parse(readFileSync(fixture.path, "utf8"));
    delete doc.shimId;
    writeFileSync(fixture.path, JSON.stringify(doc));

    const first = (await fixture.reopen()).getShimId();
    expect(isShimId(first)).toBe(true);
    // A second open must keep the back-filled id, not mint another.
    expect((await fixture.reopen()).getShimId()).toBe(first);
  });

  it("is not version-bumped, so an older connector can still read the store", async () => {
    fixture = await openTempStore();
    expect(JSON.parse(readFileSync(fixture.path, "utf8")).version).toBe(1);
  });

  it("does not change when the master key is rotated", async () => {
    // Rotation re-seals under a new key; the id is unsealed and not derived from
    // the key, so it must be untouched. Simulated by re-stamping the fingerprint.
    fixture = await openTempStore();
    const id = fixture.store.getShimId();
    const next = makeMasterKey();
    const doc = JSON.parse(readFileSync(fixture.path, "utf8"));
    doc.keyFingerprint = next.fingerprint;
    writeFileSync(fixture.path, JSON.stringify(doc));
    expect((await fixture.reopen(next)).getShimId()).toBe(id);
  });

  it("changes only on regenerate, and the new id persists", async () => {
    fixture = await openTempStore();
    const before = fixture.store.getShimId();
    const after = await fixture.store.regenerateShimId();
    expect(after).not.toBe(before);
    expect(isShimId(after)).toBe(true);
    expect((await fixture.reopen()).getShimId()).toBe(after);
  });

  it("re-mints a hand-corrupted id rather than trusting it", async () => {
    fixture = await openTempStore();
    const doc = JSON.parse(readFileSync(fixture.path, "utf8"));
    doc.shimId = "NOT.A.VALID.ID";
    writeFileSync(fixture.path, JSON.stringify(doc));
    expect(isShimId((await fixture.reopen()).getShimId())).toBe(true);
  });
});
