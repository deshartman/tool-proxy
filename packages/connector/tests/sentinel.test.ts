import { describe, it, expect } from "vitest";

// Sentinel: proves vitest discovers files under packages/connector/tests/
// and the explicit "vitest" import resolves. Delete or rewrite once a real
// defensive test lands. See `.claude/plans/TEST-SUITE.md`.
describe("vitest wiring", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
