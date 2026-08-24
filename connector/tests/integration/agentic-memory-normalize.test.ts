import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";

// Coverage for bundled-mcps/agentic-memory/normalize.ts, which had none — added
// because MCP-AUDIT #26 rewrote normalizePhone's body and `bundled-mcps/` is
// OUTSIDE the tsc project (tsx runs it), so a mistake there builds clean and only
// a test that imports the module can catch it.
//
// #26 removed a ternary whose two branches were textually identical, and with it
// the `stripped` intermediate:
//
//   before: trimmed.replace(/[^\d+]/g, "").replace(/\D/g, "")
//   after:  trimmed.replace(/\D/g, "")
//
// Those are equivalent — the first pass keeps digits and `+`, the second then
// drops the `+` — but "equivalent by inspection" is exactly the claim worth
// pinning, so the cases below cover input with and without `+`, with separators,
// and at both digit-count boundaries.

const AM = resolve(__dirname, "../../..", "bundled-mcps/agentic-memory");

let normalizePhone: (raw: string) => string;
let normalizeEmail: (raw: string) => string;

beforeAll(async () => {
  const mod = await import(`${AM}/normalize.ts`);
  normalizePhone = mod.normalizePhone;
  normalizeEmail = mod.normalizeEmail;
});

describe("normalizePhone", () => {
  it("keeps an existing + and yields one + exactly", () => {
    expect(normalizePhone("+15551234567")).toBe("+15551234567");
  });

  it("prepends + when the input has none", () => {
    expect(normalizePhone("15551234567")).toBe("+15551234567");
  });

  it("strips separators, spaces and parentheses", () => {
    for (const raw of ["+1 (555) 123-4567", "1-555-123-4567", " +1.555.123.4567 "]) {
      expect(normalizePhone(raw), raw).toBe("+15551234567");
    }
  });

  it("does not double the + on an already-prefixed value", () => {
    expect(normalizePhone("++15551234567")).toBe("+15551234567");
  });

  it("accepts the E.164 digit-count boundaries", () => {
    expect(normalizePhone("12345678")).toBe("+12345678");            // 8
    expect(normalizePhone("123456789012345")).toBe("+123456789012345"); // 15
  });

  it("rejects outside the boundaries, naming the count", () => {
    expect(() => normalizePhone("1234567")).toThrow(/7 digits/);
    expect(() => normalizePhone("1234567890123456")).toThrow(/16 digits/);
  });

  it("rejects an empty or whitespace-only value", () => {
    for (const raw of ["", "   "]) {
      expect(() => normalizePhone(raw)).toThrow(/empty phone value|0 digits/);
    }
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Des@Example.COM ")).toBe("des@example.com");
  });

  it("rejects values without exactly one usable @", () => {
    for (const bad of ["nope", "@example.com", "des@", "a@b@c.com"]) {
      expect(() => normalizeEmail(bad), bad).toThrow();
    }
  });
});
