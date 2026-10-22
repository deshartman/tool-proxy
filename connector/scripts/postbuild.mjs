// Prepend `#!/usr/bin/env node` + chmod +x on dist/index.js so it can run
// directly as the `tool-proxy` bin. tsc strips/ignores shebangs in source,
// so we patch the compiled output. This runs after `tsc -b`.
//
// The template-copy loop that used to live here (propagating .env.example +
// connector.yaml.example into connector/ for the runtime image) retired with
// the `init` subcommand in the customer-repo carve-out: the deployment
// platform provides secrets via its own mechanism, so there are no
// customer-authored templates to copy anymore.
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");  // connector/
const target = resolve(pkgRoot, "dist", "index.js");
const SHEBANG = "#!/usr/bin/env node\n";
const body = readFileSync(target, "utf8");
if (!body.startsWith(SHEBANG)) {
  writeFileSync(target, SHEBANG + body, "utf8");
}
chmodSync(target, 0o755);
