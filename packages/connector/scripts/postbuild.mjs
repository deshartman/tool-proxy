// Two build fix-ups on `packages/connector/`:
//
//   1. Prepend `#!/usr/bin/env node` + chmod +x on dist/index.js so it can
//      run directly as the `mcp-connector` bin. tsc strips/ignores shebangs
//      in source, so we patch the compiled output.
//   2. Copy the repo-root template files (`.env.example`,
//      `connector.yaml.example`) into `packages/connector/` so they ship in
//      the npm tarball via the `files:` allowlist. Source-of-truth lives at
//      the repo root (dev's view — next to the live `.env` / `connector.yaml`
//      they edit); this step propagates them to the package before publish.
//      The `packages/connector/` copies are gitignored build artifacts.
//
// This runs after `tsc -b`. `npm pack` / `npm publish` see the copies in
// place. Customers post-`npm i` find them at `node_modules/@mcp-shim/
// connector/{.env,connector.yaml}.example`, which is what `findShippedEnvExample`
// resolves via `import.meta.url`.
import { readFileSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");           // packages/connector/
const repoRoot = resolve(pkgRoot, "..", "..");  // repo root

// (1) shebang + chmod on the bin
const target = resolve(pkgRoot, "dist", "index.js");
const SHEBANG = "#!/usr/bin/env node\n";
const body = readFileSync(target, "utf8");
if (!body.startsWith(SHEBANG)) {
  writeFileSync(target, SHEBANG + body, "utf8");
}
chmodSync(target, 0o755);

// (2) copy repo-root template files into packages/connector/ so `files:`
// ships them. Failure to find a source is a build-time error — the templates
// are load-bearing for `mcp-connector init`.
for (const name of [".env.example", "connector.yaml.example"]) {
  copyFileSync(resolve(repoRoot, name), resolve(pkgRoot, name));
}
