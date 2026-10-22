import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, chmodSync, mkdirSync, rmdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolveMasterKey } from "../../src/config-store/master-key.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tool-proxy-master-key-test-" + Date.now());

describe("resolveMasterKey", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    delete process.env.CONNECTOR_KEY_FILE;
  });

  afterEach(() => {
    try {
      const files = readdirSync(TEST_DIR);
      for (const f of files) {
        unlinkSync(join(TEST_DIR, f));
      }
      rmdirSync(TEST_DIR);
    } catch {}
    delete process.env.CONNECTOR_KEY_FILE;
  });

  it("throws when CONNECTOR_KEY_FILE is not set", () => {
    delete process.env.CONNECTOR_KEY_FILE;
    expect(() => resolveMasterKey()).toThrow(/CONNECTOR_KEY_FILE is required/);
  });

  it("throws when key file is missing", () => {
    process.env.CONNECTOR_KEY_FILE = "/nonexistent/path/master.key";
    expect(() => resolveMasterKey()).toThrow(/ENOENT/);
  });

  it("throws when file has wrong mode (0644)", () => {
    const path = join(TEST_DIR, "master.key");
    writeFileSync(path, Buffer.alloc(32, 0x42));
    chmodSync(path, 0o644);
    process.env.CONNECTOR_KEY_FILE = path;
    expect(() => resolveMasterKey()).toThrow(/must be 0600/);
  });

  it("throws when key has wrong length (16 bytes)", () => {
    const path = join(TEST_DIR, "master.key");
    writeFileSync(path, Buffer.alloc(16, 0x42));
    chmodSync(path, 0o600);
    process.env.CONNECTOR_KEY_FILE = path;
    expect(() => resolveMasterKey()).toThrow(/must be exactly 32 bytes \(got 16\)/);
  });

  it("throws when key has wrong length (64 bytes)", () => {
    const path = join(TEST_DIR, "master.key");
    writeFileSync(path, Buffer.alloc(64, 0x42));
    chmodSync(path, 0o600);
    process.env.CONNECTOR_KEY_FILE = path;
    expect(() => resolveMasterKey()).toThrow(/must be exactly 32 bytes \(got 64\)/);
  });

  it("returns MasterKey with correct 32-byte file mode 0600", () => {
    const path = join(TEST_DIR, "master.key");
    const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    writeFileSync(path, keyBytes);
    chmodSync(path, 0o600);
    process.env.CONNECTOR_KEY_FILE = path;

    const result = resolveMasterKey();

    expect(result.bytes.length).toBe(32);
    expect(result.bytes.equals(keyBytes)).toBe(true);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    // Fingerprint should be SHA-256 hex
    const expectedFingerprint = createHash("sha256")
      .update(keyBytes)
      .digest("hex");
    expect(result.fingerprint).toBe(expectedFingerprint);
  });

  it("returns different fingerprints for different keys", () => {
    const path1 = join(TEST_DIR, "master1.key");
    const path2 = join(TEST_DIR, "master2.key");

    const key1 = Buffer.alloc(32, 0x42);
    const key2 = Buffer.alloc(32, 0x43);

    writeFileSync(path1, key1);
    writeFileSync(path2, key2);
    chmodSync(path1, 0o600);
    chmodSync(path2, 0o600);

    process.env.CONNECTOR_KEY_FILE = path1;
    const result1 = resolveMasterKey();

    process.env.CONNECTOR_KEY_FILE = path2;
    const result2 = resolveMasterKey();

    expect(result1.fingerprint).not.toBe(result2.fingerprint);
  });
});
