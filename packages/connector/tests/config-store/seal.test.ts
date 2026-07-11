import { describe, it, expect, beforeAll } from "vitest";
import { initSodium, seal, open } from "../../src/config-store/seal.js";

describe("seal / open", () => {
  beforeAll(async () => {
    await initSodium();
  });

  it("round-trips plaintext", () => {
    const key = Buffer.alloc(32, 0x42);
    const plaintext = Buffer.from("hello world");
    const sealed = seal(plaintext, key);
    const opened = open(sealed, key);
    expect(opened.toString()).toBe("hello world");
  });

  it("round-trips with random key", () => {
    const key = Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)));
    const plaintext = Buffer.from("secret data for the tunnel");
    const sealed = seal(plaintext, key);
    const opened = open(sealed, key);
    expect(opened.toString()).toBe("secret data for the tunnel");
  });

  it("throws on tampered ciphertext", () => {
    const key = Buffer.alloc(32, 0x42);
    const plaintext = Buffer.from("hello world");
    const sealed = seal(plaintext, key);
    // Tamper with the ciphertext portion (after the nonce). libsodium's
    // crypto_secretbox_open_easy throws directly on tag-verify failure with
    // "wrong secret key for the given ciphertext" — our seal.ts fallback
    // throw ("authentication tag mismatch") is dead code because libsodium
    // never returns null in this case.
    sealed[30] ^= 0xFF;
    expect(() => open(sealed, key)).toThrow(/wrong secret key/);
  });

  it("throws on truncated ciphertext", () => {
    const key = Buffer.alloc(32, 0x42);
    const plaintext = Buffer.from("hello world");
    const sealed = seal(plaintext, key);
    const truncated = sealed.subarray(0, sealed.length - 5);
    expect(() => open(truncated, key)).toThrow();
  });

  it("throws with wrong key", () => {
    const key1 = Buffer.alloc(32, 0x42);
    const key2 = Buffer.alloc(32, 0x43);
    const plaintext = Buffer.from("hello world");
    const sealed = seal(plaintext, key1);
    expect(() => open(sealed, key2)).toThrow(/wrong secret key/);
  });
});
