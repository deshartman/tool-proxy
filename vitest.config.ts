import { defineConfig } from "vitest/config";

// Vitest skeleton — no tests yet. Step 4 of the code-hygiene plan
// (`.claude/plans/CODE_HYGINE.md`) only wires the toolchain; the actual
// suite comes in a follow-up so the structural PR stays purely
// structural. `npm test` from packages/connector currently exits 0 with
// "no tests found" — that's the intended state until tests land.
//
// When tests do land, they should sit at packages/connector/src/**/*.test.ts
// alongside the source they exercise — vitest's default colocation pattern.
// Globals are off; tests should explicitly import { describe, it, expect }
// from "vitest" so it's obvious where the runtime comes from.
export default defineConfig({
  test: {
    include: ["packages/connector/src/**/*.test.ts"],
    environment: "node",
  },
});
