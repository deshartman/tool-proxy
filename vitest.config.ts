import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

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
//
// `resolve.alias` mirrors the `paths` block in `tsconfig.base.json` so a
// test at `packages/connector/tests/mcp-tools/apis/email/email_fetch.test.ts`
// can write `import { emailFetch } from "@mcp/bundled/twilio/email/tools/email_fetch.js"`
// instead of an unreadable `../../../../../../mcp/bundled/...` chain. Vitest
// resolves these via Vite at test runtime; the matching tsconfig paths give
// the IDE / `tsc --noEmit` the same understanding. The trailing `.js` extension
// is preserved (NodeNext convention — see tsconfig.base.json `module: NodeNext`).
const here = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  test: {
    include: ["packages/connector/tests/**/*.test.ts"],
    environment: "node",
    unstubEnvs: true,
  },
  resolve: {
    alias: [
      // Source trees we test against. Order matters: more specific first so
      // `@connector/sdk` does not match `@mcp/...`.
      { find: /^@connector\/(.*)$/, replacement: `${here}packages/connector/src/$1` },
      { find: /^@mcp\/(.*)$/, replacement: `${here}mcp/$1` },
    ],
  },
});
