// Prepends `#!/usr/bin/env node` and chmod +x on dist/index.js so it can run
// directly as the `mcp-connector` bin. tsc strips/ignores shebangs in source,
// so we patch the compiled output.
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "..", "dist", "index.js");
const SHEBANG = "#!/usr/bin/env node\n";

const body = readFileSync(target, "utf8");
if (!body.startsWith(SHEBANG)) {
  writeFileSync(target, SHEBANG + body, "utf8");
}
chmodSync(target, 0o755);
