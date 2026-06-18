import { defineConfig } from "vitest/config";

// Tests live in a peer `packages/connector/tests/` directory mirroring `src/`,
// not colocated `*.test.ts` files. Reasoning is documented in
// `.claude/plans/TEST-SUITE.md` — short version: the connector's
// `tsconfig.json` has `rootDir: "src"`, so colocated tests would compile into
// `dist/` and ship in the OCI image. Peer `tests/` lives outside `rootDir`
// and `tsc -b` ignores it entirely; vitest compiles tests on the fly via tsx.
//
// Globals are off; tests should explicitly import { describe, it, expect }
// from "vitest" so it's obvious where the runtime comes from.
//
// `unstubEnvs: true` auto-restores vi.stubEnv() mutations between test cases.
// Many connector surfaces read process.env directly (see TEST-SUITE.md
// "Env-var surface — coverage map"); without this, a stub leaks into the
// next case. Set globally so individual tests don't need afterEach plumbing.
export default defineConfig({
  test: {
    include: ["packages/connector/tests/**/*.test.ts"],
    environment: "node",
    unstubEnvs: true,
  },
});
