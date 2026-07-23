# Pivot away from the NPM-package delivery model

> **Status: TODO.** Drafted 2026-07-23. The `packages/connector` package.json has been publish-ready since day one (`bin`, `exports`, `files`, `name` all wired; only `"private": true` blocks publish). This plan retires the "customer imports the npm package into their existing Node service" story and commits fully to the container/k8s drop-in shape, offering customers **two first-class delivery paths**: derived image and volume mount.

## Background & rationale (what this plan is about)

The connector is a **daemon**, not a library. It opens a long-lived WSS to the controller, spawns and supervises child MCP processes, holds sealed secrets in memory, binds an inspector HTTP server on `INSPECTOR_PORT` (9090), and handles SIGTERM to reap children. Daemons don't want to be `import`ed into someone else's Node service — they want a process boundary, a filesystem, and an orchestrator.

Historically this repo carried "customer runs `npm install @mcp-shim/connector` on their own Node.js server" as a co-equal delivery model alongside the OCI image. Every load-bearing decision in the codebase actually points at the container path:

- OCI image is the primary artifact (`packages/connector/Dockerfile`, multi-arch, signed)
- Deploy scaffolding targets 5 container platforms (`mcp-connector deploy init --target {fargate|gke|aca|compose|fly|fly-mock}`)
- Type 3 bundles are Python venvs installed at `/opt/bundled-mcps/<name>/.venv/` by a Dockerfile stage — cannot be materialized by `npm install` on a customer host
- Helm chart, Terraform module, docker-compose.prod.yml all ship in-repo
- Native modules (`libsodium-wrappers`, `pg`) build cleanly in the image but hit cross-platform grief on a customer host
- Inspector-on-9090 (loopback-only, carries webhook secrets) has no meaningful home inside a customer's Express server

Meanwhile, the "npm-consumer" mental model added:
- A parallel doc voice ("post `npm i` layout", "next to `node_modules/`") that competed with the container voice
- An aspirational "publish flip" narrative in CLAUDE.md that was never going to happen
- Customer confusion about which path was primary

**The pivot: docs + framing change, not a code purge.** Zero wire-format changes, zero supervisor changes, zero test-fixture changes. The connector already boots identically regardless of whether the container was assembled by pure `npm ci` or `npm ci` + a customer `COPY`. This plan changes what we *tell* customers, not what the code does.

**Two first-class customer paths** for how customer-authored Type 1 MCPs enter a running connector:

1. **Derived image** — customer writes `FROM twilio/mcp-connector:1.0` + `COPY ./my-mcps/ /var/lib/mcp-connector/customer-mcps/`, builds their own image. Enterprise-friendly, image-signing shops, prod runbooks.
2. **Volume mount** — customer bind-mounts a host / K8s PVC / Fly volume / EFS at `/var/lib/mcp-connector/customer-mcps/`. Faster dev loop, unlocks the existing W-L2 controller-triggered "Refresh local MCPs" hot-rescan feature.

Both paths hit the same mount point and the same discovery code path in [`src/dropin.ts`](../packages/connector/src/dropin.ts). No branching in the connector.

## How to execute (read first)

Self-contained. `/clear` → read this → execute end-to-end. Do NOT rely on conversation history — every fact needed is in this file (or in [`CLAUDE.md`](../CLAUDE.md), which you should skim if you haven't recently).

**Prereqs.**
- Clean working tree.
- `git` + `node` (>=22) + `npm` installed locally.
- `fly` CLI installed and authenticated (`fly auth whoami` returns a user). Only required for commits 4+5. Skip those if unavailable and mark them `TODO` at the bottom for a later execution pass.
- Read [`CLAUDE.md`](../CLAUDE.md) if unfamiliar with the repo — this plan assumes you know what Type 1 / Type 2 / Type 3 MCPs are, and what MCP_DROPIN_DIR means.

**Session bootstrap.**
```bash
# 1. Confirm you're in the right repo.
pwd    # should end in .../mcp-shim
cat package.json | grep '"name"'    # should be "mcp-shim-connector"

# 2. Confirm branch. Create if missing.
git branch --show-current
# If not on cleanup/remove-npm:
git checkout cleanup/remove-npm 2>/dev/null || git checkout -b cleanup/remove-npm

# 3. Confirm clean tree (the plan file itself may be modified — that's expected).
git status

# 4. (Optional) Refresh graphify so exploration is fast.
graphify query "npm-consumer framing points" 2>/dev/null || true
```

**Branch shape.** Single branch, five commits (three doc/code + two deploy-verify writeups). Local-only — do not push. The `--no-ff` merge commit on `main` is what carries history.

## What we're doing — and what we're NOT

**Doing (docs + framing pivot):**
- Retiring the "customer runs `npm install @mcp-shim/connector` on their own Node server" mental model everywhere it appears.
- Documenting two first-class ways customers ship their Type 1 MCPs into a running connector container:
  - **Derived image** — customer `FROM twilio/mcp-connector:1.0` + `COPY ./my-mcps/ /var/lib/mcp-connector/customer-mcps/`
  - **Volume mount** — customer mounts a host / K8s / Fly volume at `/var/lib/mcp-connector/customer-mcps/`
- Reframing `.env` + `connector.yaml` as **mounted config**, not "files next to `node_modules/`".
- End-to-end verifying both paths on Fly against a real controller.

**NOT doing (kept intact):**
- The `packages/` workspace layout — still gives us dep hoisting and clean CI, unchanged.
- The `mcp-connector` CLI (`bin` field) — customers exec it *inside* the container (`fly ssh console -C 'mcp-connector init'`, `docker exec ... mcp-connector doctor`).
- The `.example` templates — `mcp-connector init` still copies from them inside the container.
- `exports` / `files` fields — the SDK re-export (`@mcp-shim/connector/sdk`) is still needed by drop-ins, and `files` still controls what an eventual `npm pack` bundle would carry (kept as a hedge).
- `MCP_DROPIN_DIR` env var mechanism — unchanged; docs simply reframe it as a mount point.
- Per-Type-1 `package.json` files — still isolate third-party SDK deps per MCP, unchanged.
- Dockerfile's `npm ci` steps — the OCI image builds itself with npm, that's an internal detail.
- Zero wire-format changes. Zero controller-side changes. Zero test-fixture changes.

The pivot is a **framing change, not a code purge**. Most of the diff is docs.

## What to delete / rewrite

### Doc phrases to grep-and-retire

Run this once to see the surface area:
```bash
git grep -nE 'npm i @mcp-shim|npm install @mcp-shim|post `?npm i`?|customer project root post|next to `?node_modules|publish (to )?(the )?npm registry|package is publishable|publishable to the npm registry|when.*published to npm|publish flip' \
  ':(exclude)node_modules' ':(exclude)dist' ':(exclude)packages/connector/dist' \
  ':(exclude)architectural-plans/REMOVE-NPM.md' \
  ':(exclude).claude/plans'
```

Expected hits (docs only, not code):

- **`CLAUDE.md`** — highest concentration. Six explicit rewrites, quoted with before/after so the executor doesn't have to guess.

  **(a) Topology paragraph — opening section, near the top.**

  BEFORE (find via grep for `resolved from CWD`):
  > `(a) reads ./connector.yaml (resolved from CWD — repo root in dev, customer project root post npm i) listing yaml-managed MCPs;`

  AFTER:
  > `(a) reads ./connector.yaml (resolved from CWD — repo root in dev, /etc/mcp-connector/ or the customer's mounted config path in production) listing yaml-managed MCPs;`

  **(b) "Config files" section — the biggest chunk.**

  BEFORE (find via grep for `Live config sits at the`):
  > `Live config sits at the **root of the working directory** (repo root in dev, customer project root post \`npm i\`) — mirroring what a customer sees when they \`npm install @mcp-shim/connector\`: \`.env\` and \`connector.yaml\` sit next to \`node_modules/\`, not inside it. Templates ship inside the package (\`packages/connector/*.example\`) so \`mcp-connector init\` can copy them out.`

  AFTER:
  > `Live config sits at the **root of the working directory** (repo root in dev; the customer's mount path — typically \`/etc/mcp-connector/\` — in production containers). Templates ship inside the connector's runtime image at \`/app/packages/connector/*.example\` so \`mcp-connector init\` (run inside the container, e.g. via \`docker exec\` or \`fly ssh console\`) can copy them out to the customer's mounted config volume. The two customer-facing delivery paths (derived image / volume mount — see [docs/deploy/DERIVED-IMAGE.md](docs/deploy/DERIVED-IMAGE.md) and [docs/deploy/VOLUME-MOUNT.md](docs/deploy/VOLUME-MOUNT.md)) both land config files at this path; the connector's boot code doesn't distinguish.`

  **(c) Workspaces section — "publish flip" paragraph.**

  BEFORE (find via grep for `is publishable`):
  > `The \`@mcp-shim/connector\` package is publishable (\`exports\`, \`bin\`, and \`name\` are already set) — only \`private: true\` in [packages/connector/package.json](packages/connector/package.json) blocks publish. Flip when ready. The \`twilio-mcp-shim\` project consumes it via a \`file:\` dep in dev today; on publish, that flips to a registry pin with no consumer code change.`

  AFTER: delete entirely. Replace with:
  > `The \`packages/\` workspace shape is internal build machinery (dep hoisting via npm workspaces, TypeScript project references, dev-time \`file:\` linking with sibling repos). It is **not** a customer-facing delivery model — customers consume the OCI image, never the npm package. \`packages/connector/package.json\` stays \`"private": true\` permanently; the \`bin\`, \`exports\`, and \`files\` fields are retained because they're used by the \`mcp-connector\` CLI running *inside* the container and by the SDK re-export path for drop-in MCPs.`

  **(d) "Type 1 hand-written shape (legacy escape hatch)" trailing sentence.**

  BEFORE (find via grep for `today's hoist-from-workspace shape`):
  > `Today's hoist-from-workspace shape is the in-repo dev convenience; the registry pin is the customer-extracts-one-folder shape.`

  AFTER: delete the sentence (the paragraph reads fine without it — the preceding sentences already explain the shape).

  **(e) Workspaces section — "Publish flip" paragraph, second occurrence.**

  BEFORE (find via grep for `published to the npm registry`):
  > `When \`@mcp-shim/connector\` is published to the npm registry (the \`private: true\` in [packages/connector/package.json](packages/connector/package.json) gets flipped), each Type 1 \`package.json\` will need to *also* list \`"@mcp-shim/connector": "^<version>"\` so the SDK resolves from the registry instead of the workspace. Today's hoist-from-workspace shape is the in-repo dev convenience; the registry pin is the customer-extracts-one-folder shape.`

  AFTER: delete entirely. The paragraph is aspirational scaffolding for a pivot that isn't planned.

  **(f) Scan-and-fix.** After the five explicit edits above, grep the file once more for any surviving hits:
  ```bash
  grep -nE 'post `?npm i`?|npm install @mcp-shim|next to `?node_modules|registry pin|publish flip' CLAUDE.md
  ```
  Fix each hit in place. If the hit is inside an example block that the surrounding text explicitly labels as historical, leave a note; otherwise rewrite.

- **`packages/connector/README.md`** — Getting Started section almost certainly leads with `npm install`. Retarget to `docker run` / `fly deploy` / `helm install`.

- **`README.md`** (repo root) — check for the same framing.

- **`docs/AUTHOR-LOCAL-MCP.md`** — probably has "put your drop-in folder next to your `node_modules/`" or similar.

- **`docs/INSPECTOR.md`** — if it references `npm start`, retarget to `docker exec` / `fly ssh`.

- **`docs/MCP-PROTOCOL.md`** — likely clean, but sanity-check.

- **`packages/connector/.env.example`** + **`connector.yaml.example`** — banner comments should say "mount this at `/etc/mcp-connector/`" not "sits next to `node_modules/`".

- **`scripts/start-connector.sh`** header comment — currently says `mirrors the customer's post-\`npm i\` layout`. Rewrite to mention dev-only.

### Code touch-ups (small)

- **[packages/connector/src/dropin.ts:10-13](packages/connector/src/dropin.ts#L10-L13)** — the `MCP_DROPIN_DIR resolution:` comment names "Production (OCI image)" and "Local dev" — this stays accurate, but the "customer's project root" third case (implicit in npm-consumer thinking) should be explicitly ruled out here. Consider one-line clarification: "Customers running the OCI image drop their MCPs at this path via bind-mount, ConfigMap projection, PVC, or a derived-image `COPY`."

- **[packages/connector/src/dropin.ts:113-116](packages/connector/src/dropin.ts#L113-L116)** — `connectorPackageRoot()` is currently used only for the local-dev fallback. Keep, but doc-comment it as "dev-only fallback; production always sets `MCP_DROPIN_DIR` or bind-mounts at `PROD_DEFAULT`."

- **`packages/connector/scripts/postbuild.mjs`** — copies the two `.example` templates from repo root into the package dir. Still needed (the CLI's `init` reads them from `import.meta.url`); keep, but if its top-of-file comment mentions "npm tarball", rephrase to "runtime image".

- **`packages/connector/package.json`** — no field changes. Add an `"engines": { "node": ">=22" }` block so an accidental future `npm install` on Node 20 fails loudly. This is defensive; the image already pins Node 22.

- **[packages/connector/src/init.ts](packages/connector/src/init.ts)** — the wizard's prompts and hint text should assume container context. If it prints "run `mcp-connector start` next", that's still accurate (works inside the container). If it prints anything about `npm install`, retarget.

## What to add

Two new docs, one README section:

### `docs/deploy/DERIVED-IMAGE.md` (new)

Full worked example for the "customer builds their own image extending ours" path. Skeleton:

1. **When to use**: enterprise environments with signed-image policies, air-gapped registries, "we CI-build everything" shops.
2. **Prerequisites**: Docker or a compatible builder; access to the `twilio/mcp-connector` image.
3. **The Dockerfile**:
   ```dockerfile
   FROM twilio/mcp-connector:1.0

   # Drop your Type 1 MCPs into the well-known path. Each subdirectory
   # under customer-mcps/ becomes an MCP; the folder name is the server name.
   COPY ./my-mcps/ /var/lib/mcp-connector/customer-mcps/

   # (Optional) bake in a curated connector.yaml — but note customer creds
   # should still come from the controller, not build-time env.
   COPY ./connector.yaml /etc/mcp-connector/config.yaml

   # (Optional) declare additional dependencies your Type 1 MCPs need.
   # These install into each MCP's local node_modules/, not the base image's.
   RUN find /var/lib/mcp-connector/customer-mcps -maxdepth 2 -name package.json \
       -execdir sh -c 'test -n "$(node -e "console.log(Object.keys(require(\"./package.json\").dependencies||{}).length)")" && npm install --omit=dev --no-package-lock || true' \;
   ```
4. **Build + push**: `docker buildx build --platform linux/amd64,linux/arm64 -t registry/my-connector:1.0 --push .`
5. **Deploy**: retarget your existing k8s/Fly/Fargate manifests to your image tag.
6. **Update loop**: new MCPs = new image build. This is a trade-off — call it out honestly.
7. **Interaction with W-L2 controller rescan**: derived-image MCPs are baked at build time; the `local-mcps-rescan` frame will re-scan the same directory but no new MCPs will appear until the image is rebuilt. This is expected — call out that hot-reload is a volume-mount feature.
8. **Full example**: complete `Dockerfile` + one sample MCP folder + `docker-compose.yml` for local test.

### `docs/deploy/VOLUME-MOUNT.md` (new)

Per-platform recipes for mounting a directory of customer-authored MCPs into the running container. Skeleton:

1. **When to use**: dev velocity matters, W-L2 hot rescan wanted, no CI-build step tolerable.
2. **The mount point**: `/var/lib/mcp-connector/customer-mcps/` — this is `PROD_DEFAULT` in [dropin.ts:46](packages/connector/src/dropin.ts#L46).
3. **Kubernetes (ConfigMap projection)**:
   - ConfigMap for small drop-ins (single `.ts` file, no `node_modules`).
   - `emptyDir` + initContainer that `git clone`s or `curl`s a tarball for larger drop-ins with deps.
   - PVC + separate "sync" job for the write-and-refresh workflow.
   - Full worked example with a Deployment + ConfigMap YAML.
4. **Fly.io**: `[[mounts]]` in fly.toml, `fly volumes create`, `fly ssh sftp shell` to populate. Call out that Fly volumes are per-machine — for multi-region deploys the derived-image path is often simpler on Fly specifically. Two-line honest comparison.
5. **AWS Fargate**: EFS mount via task definition `volumes[].efsVolumeConfiguration`. Note the `File System ID` provisioning step.
6. **Azure Container Apps**: `azureFile` volume + storage account. Note the mount syntax.
7. **docker-compose**: bind mount `./mcp/local:/var/lib/mcp-connector/customer-mcps:ro`. Simplest for single-VM shape.
8. **Verifying the mount worked**: `fly ssh console -C 'ls /var/lib/mcp-connector/customer-mcps'`, then the "Refresh local MCPs" button in the controller UI.
9. **Interaction with W-L2 rescan**: this is where the hot-reload story earns its keep. Edit the file on the host / re-apply the ConfigMap / rsync to the volume, click Refresh in the controller, tools re-appear.

### `README.md` (repo root) — new "Choose your delivery path" section

Right below the one-liner project description. Two-column comparison of Derived Image vs Volume Mount, pointing at the two new docs. Lead with a matrix like:

| | Derived image | Volume mount |
|---|---|---|
| Ergonomics | Rebuild image to add MCPs | Edit file, click Refresh |
| Best fit | Enterprise, image-signing shops, prod runbooks | Dev, staging, small teams |
| Hot rescan | ❌ (rebuild required) | ✅ (W-L2 refresh) |
| Version pinning | ✅ Image tag | ⚠️ Tag + mount contents diverge |
| Fly.io friendliness | ✅ Easy | ⚠️ Volume/multi-region friction |
| K8s friendliness | ✅ Easy | ✅ ConfigMap/PVC native |

Then two "Getting Started in 5 minutes" links.

## Five-commit shape

**Commit 1: Retire npm-consumer framing across all docs.**
- `CLAUDE.md` sections listed above (six touch points).
- `packages/connector/README.md` Getting Started → container-first.
- `README.md` (repo root) — retire any "npm install" framing.
- `docs/AUTHOR-LOCAL-MCP.md`, `docs/INSPECTOR.md` — spot-fix any hits.
- `.env.example`, `connector.yaml.example` banner comments.
- `scripts/start-connector.sh` header comment.

Message: `docs: retire npm-consumer framing; container is the delivery shape`

**Commit 2: Add the two new deploy docs + README delivery-path section.**
- `docs/deploy/DERIVED-IMAGE.md` (new)
- `docs/deploy/VOLUME-MOUNT.md` (new)
- `README.md` (repo root) — new "Choose your delivery" section.

Message: `docs: add DERIVED-IMAGE and VOLUME-MOUNT — two first-class delivery paths`

**Commit 3: Code + config touch-ups.**
- `packages/connector/package.json` — add `"engines": { "node": ">=22" }` after `"main"`.
- `packages/connector/src/dropin.ts` — comment clarification at line 10-13 + 113-116 (see explicit edits below).
- `packages/connector/scripts/postbuild.mjs` — comment update if it says "tarball".
- `packages/connector/src/init.ts` — retarget any npm-consumer prompts.
- **`.gitignore`** — add `test/deploy/` so commits 4+5 scratch dirs don't get accidentally tracked.

Explicit `dropin.ts` edits:

Line 10-13, BEFORE:
```
// MCP_DROPIN_DIR resolution:
//   * Production (OCI image): /var/lib/mcp-connector/customer-mcps/
//   * Local dev: defaults to mcp/local/ relative to the connector package
//     so the bundled `sample` drop-in works without a new mount.
```

AFTER:
```
// MCP_DROPIN_DIR resolution:
//   * Production (OCI image): /var/lib/mcp-connector/customer-mcps/
//     Customers land Type 1 MCPs at this path via one of two supported
//     patterns: derived image (`FROM twilio/mcp-connector` + `COPY`) or
//     volume mount (K8s PVC, Fly volume, Fargate EFS, ACA azureFile,
//     docker-compose bind mount). See docs/deploy/DERIVED-IMAGE.md and
//     docs/deploy/VOLUME-MOUNT.md.
//   * Local dev: defaults to mcp/local/ relative to the connector package
//     so the bundled `sample` drop-in works without a new mount.
```

Line 111-116, BEFORE:
```
// Helper for callers that need to feed the supervisor a uniform list:
// returns the directory the connector package itself lives in, so the
// .env-default fallback works when MCP_DROPIN_DIR is unset.
export function connectorPackageRoot(): string {
```

AFTER:
```
// Helper for callers that need to feed the supervisor a uniform list:
// returns the directory the connector package itself lives in. Used as
// the dev-only fallback when MCP_DROPIN_DIR is unset; production
// customers always either set MCP_DROPIN_DIR or bind-mount at
// PROD_DEFAULT (see resolution comment above).
export function connectorPackageRoot(): string {
```

Message: `chore: comment cleanups matching the container-first pivot; engines pin`

**Commit 4: End-to-end deploy verify — derived image on Fly.**
- Build a local derived image with one sample customer MCP baked in via `COPY`.
- Deploy to a Fly app (throwaway name), confirm inspector reachable via `fly proxy`, confirm the sample MCP tool lists + `tools/call` roundtrips.
- Capture the exact commands + fly.toml + Dockerfile in `docs/deploy/DERIVED-IMAGE.md` "Verified example" section.

Message: `docs(deploy): live-verified derived-image path on Fly`

**Commit 5: End-to-end deploy verify — volume-mounted MCPs.**
- Deploy the base image to Fly with a `[[mounts]]` volume pre-populated via `fly ssh sftp shell` with two sample MCPs.
- Confirm inspector shows both, confirm `tools/call` works.
- Add one MCP via `fly ssh sftp`, click "Refresh local MCPs" in the controller UI, confirm it appears live via W-L2 rescan.
- Capture the exact commands in `docs/deploy/VOLUME-MOUNT.md` "Verified example" section.

Message: `docs(deploy): live-verified volume-mount path on Fly with W-L2 rescan`

## Verify after each commit

```bash
cd packages/connector
npx tsc --noEmit    # typecheck clean (should be no-op for commits 1, 2, 4, 5)
npm test            # vitest passes; expect the same pre-branch test count (no test changes in this branch)
npm run build       # dist rebuilds
```

**Expected outcomes per commit:**
- **Commit 1** (docs framing): tsc clean, tests pass, no diff in `dist/`.
- **Commit 2** (new docs): tsc clean, tests pass, no diff in `dist/`.
- **Commit 3** (code touch-ups): tsc clean, tests pass, `dist/` regenerates (comment changes flow through). The `engines` field in package.json triggers no runtime behavior on Node 22, only guards Node <22.
- **Commit 4** (derived-image verify): the added `docs/deploy/DERIVED-IMAGE.md` "Verified example" section reflects the exact commands that worked. The Fly app is destroyed by the end.
- **Commit 5** (volume-mount verify): same for `VOLUME-MOUNT.md`. Both throwaway Fly apps destroyed by end.

For commits 4 and 5 additionally:
```bash
# from repo root — verify the OCI image still builds clean before deploying
./scripts/build-image.sh
```

## Deployment test scope (commits 4 + 5)

Both live-fire against the existing Fly controller setup (a controller URL and Tunnel Security bearer must exist ahead of time — this plan does not stand up a new controller).

### Prereqs for commits 4 + 5

- Fly CLI installed + authenticated (`fly auth whoami`).
- A `CONTROLLER_URL` and `TUNNEL_AUTH_TOKEN` (or OAuth2 triple) obtained from an existing controller. Both throwaway apps will re-use the same controller — they register as distinct connectors.
- A base image tag published or locally built (`./scripts/build-image.sh`). Assume tag `mcp-connector:local-npm-pivot` throughout.

### Derived image path (commit 4)

**Scratch dir layout.** All test artifacts under `test/deploy/derived-image/` — gitignored via a `.gitignore` line added in commit 3.

**Step 1: throwaway MCP source.** Write `test/deploy/derived-image/hello-derived/tools/hello.ts`:

```ts
import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

const hello: Tool<{ who?: string }> = {
  name: "hello",
  description: "Return a greeting confirming the derived-image path works.",
  inputSchema: z.object({ who: z.string().optional() }),
  outputSchema: z.object({ message: z.string() }),
  async run({ who }) {
    return { message: `hello from derived-image path, ${who ?? "friend"}` };
  },
};

export default hello;
```

**Step 2: customer-shaped Dockerfile.** Write `test/deploy/derived-image/Dockerfile`:

```dockerfile
FROM mcp-connector:local-npm-pivot
COPY ./hello-derived/ /var/lib/mcp-connector/customer-mcps/hello-derived/
```

**Step 3: connector.yaml + .env.** Write `test/deploy/derived-image/connector.yaml`:

```yaml
mcp_servers: []
policy:
  reconnect:
    enabled: true
    initial_backoff_ms: 1000
```

(Drop-in discovery picks up `hello-derived/` automatically — no yaml entry needed.)

Write `test/deploy/derived-image/.env`:

```dotenv
CONNECTOR_CREDS_SOURCE=env
CONTROLLER_URL=<from prereqs>
CONNECTOR_NAME=mcp-shim-derived-test
TUNNEL_AUTH_TOKEN=<from prereqs>
```

**Step 4: scaffold fly.toml.**

```bash
cd test/deploy/derived-image
node ../../../packages/connector/dist/index.js deploy init \
  --target fly \
  --name mcp-shim-derived-test \
  --controller-url "$CONTROLLER_URL" \
  --yes
```

**Step 5: build + deploy.**

```bash
fly apps create mcp-shim-derived-test --org personal
fly secrets set \
  CONTROLLER_URL="$CONTROLLER_URL" \
  CONNECTOR_NAME=mcp-shim-derived-test \
  TUNNEL_AUTH_TOKEN="$TUNNEL_AUTH_TOKEN" \
  -a mcp-shim-derived-test
fly deploy --dockerfile ./Dockerfile -a mcp-shim-derived-test
```

**Step 6: verify.**
- `fly logs -a mcp-shim-derived-test | head -50` — confirm boot + register-ack + `hello-derived` discovered.
- `fly proxy 9090:9090 -a mcp-shim-derived-test` — open inspector in another shell. Confirm `hello-derived` visible in MCP Server panel with tool `hello`.
- In the controller UI, approve `hello-derived` (customer drop-in — approval-gated per CLAUDE.md's "Customer drop-ins gated by controller approval" property).
- Call `hello-derived.hello` from the controller. Expect `{ message: "hello from derived-image path, friend" }`.

**Step 7: cleanup.**
```bash
fly apps destroy mcp-shim-derived-test -y
```

### Volume mount path (commit 5)

**Scratch dir layout.** `test/deploy/volume-mount/` — also gitignored.

**Step 1: config only.** No Dockerfile in the customer scratch dir — we use the base image directly.

Write `test/deploy/volume-mount/fly.toml` (generate via `deploy init` first, then hand-edit to add the mount):

```bash
cd test/deploy/volume-mount
node ../../../packages/connector/dist/index.js deploy init \
  --target fly \
  --name mcp-shim-volume-test \
  --controller-url "$CONTROLLER_URL" \
  --yes
```

Then hand-add this block to the generated `fly.toml`:

```toml
[[mounts]]
  source = "customer_mcps"
  destination = "/var/lib/mcp-connector/customer-mcps"
```

**Step 2: throwaway MCP sources.** Prepare two locally:

`test/deploy/volume-mount/hello-volume/tools/hello.ts`:
```ts
import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

const hello: Tool<{}> = {
  name: "hello",
  description: "Return a greeting confirming the volume-mount path works.",
  inputSchema: z.object({}),
  outputSchema: z.object({ message: z.string() }),
  async run() {
    return { message: "hello from volume-mount path" };
  },
};

export default hello;
```

`test/deploy/volume-mount/world-late/tools/world.ts`:
```ts
import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

const world: Tool<{}> = {
  name: "world",
  description: "Added via W-L2 rescan after boot — confirms hot-reload works.",
  inputSchema: z.object({}),
  outputSchema: z.object({ message: z.string() }),
  async run() {
    return { message: "world added live via W-L2 rescan" };
  },
};

export default world;
```

**Step 3: create volume + first deploy (with only `hello-volume/` present).**

```bash
fly apps create mcp-shim-volume-test --org personal
fly secrets set \
  CONTROLLER_URL="$CONTROLLER_URL" \
  CONNECTOR_NAME=mcp-shim-volume-test \
  TUNNEL_AUTH_TOKEN="$TUNNEL_AUTH_TOKEN" \
  -a mcp-shim-volume-test
fly volumes create customer_mcps --size 1 --region iad -a mcp-shim-volume-test -y
fly deploy -i mcp-connector:local-npm-pivot -a mcp-shim-volume-test
```

**Step 4: upload `hello-volume/` to the volume.**

```bash
fly ssh sftp shell -a mcp-shim-volume-test
# In the sftp shell:
put -r hello-volume /var/lib/mcp-connector/customer-mcps/hello-volume
exit
fly machine restart -a mcp-shim-volume-test
```

**Step 5: verify boot with `hello-volume`.**
- `fly logs`, approve in controller, call `hello-volume.hello`. Expect `{ message: "hello from volume-mount path" }`.

**Step 6: hot-add `world-late/` via W-L2 rescan.**

```bash
fly ssh sftp shell -a mcp-shim-volume-test
put -r world-late /var/lib/mcp-connector/customer-mcps/world-late
exit
```

**Step 7: click "Refresh local MCPs" in the controller UI.**
- The controller sends a `local-mcps-rescan` frame.
- Confirm in inspector (`fly proxy 9090:9090`) that `world-late` appears WITHOUT a machine restart.
- Approve `world-late` in the controller (approval-gated, same as `hello-volume`).
- Call `world-late.world`. Expect `{ message: "world added live via W-L2 rescan" }`.

**Step 8: cleanup.**
```bash
fly apps destroy mcp-shim-volume-test -y
# The volume goes with the app; no separate destroy needed.
```

### Global test rules

- Fresh throwaway app per test. Never touch a shared/production Fly app.
- If either test fails, the deploy is a docs bug — update the corresponding `docs/deploy/*.md` in the same commit to reflect what actually works, then re-run.
- Do NOT commit anything under `test/deploy/**` — that's why commit 3 adds the `.gitignore` entry. The verified commands land in `docs/deploy/DERIVED-IMAGE.md` and `VOLUME-MOUNT.md` as the "Verified example" section, not as tracked test fixtures.

## Branch wrap-up

1. Final `npm test` + `npm run build` clean.
2. Update CLAUDE.md "Distribution" section — reflect that the two delivery paths are now first-class. Per the "Docs update before merge" project rule, this is part of commit 1, not a follow-up.
3. Squash-or-not: don't squash. Five commits reflect five distinct pieces of work.
4. Merge with `--no-ff` into main:
   ```bash
   git checkout main && git merge --no-ff cleanup/remove-npm
   ```
5. Don't push the feature branch to origin — per project convention, feature branches stay local; the `--no-ff` merge commit on main is what carries history.
6. Keep the branch ref locally after merge (do NOT `git branch -d` — project convention says preserve).

## Branch success criteria (the whole branch is "done" when all are true)

- [ ] `git log main..cleanup/remove-npm --oneline` shows exactly 5 commits.
- [ ] `git grep -nE 'post \`?npm i\`?|npm install @mcp-shim|next to \`?node_modules|registry pin|publish flip' ':(exclude)architectural-plans' ':(exclude)node_modules' ':(exclude)dist' ':(exclude)packages/connector/dist'` returns zero hits (or only clearly-labeled historical mentions).
- [ ] `docs/deploy/DERIVED-IMAGE.md` and `docs/deploy/VOLUME-MOUNT.md` both exist and both carry a "Verified example" section with the exact commands from commits 4 + 5.
- [ ] `README.md` at repo root has the "Choose your delivery path" decision matrix.
- [ ] `npx tsc --noEmit && npm test && npm run build` all clean.
- [ ] Both throwaway Fly apps (`mcp-shim-derived-test`, `mcp-shim-volume-test`) are destroyed (`fly apps list | grep mcp-shim-.*-test` returns nothing).
- [ ] `packages/connector/package.json` has `"engines": { "node": ">=22" }`.
- [ ] `.gitignore` includes `test/deploy/`.
- [ ] CLAUDE.md's Distribution section reflects the two-path story.

## If you get stuck

- **Fly CLI missing or unauthenticated.** Skip commits 4 + 5. Land commits 1-3, note in this file's status line that commits 4-5 are `TODO` for a later pass, and don't merge to main until they land.
- **Live Fly deploy fails mid-flight.** Destroy the throwaway app (`fly apps destroy <name> -y`), fix the plan step that failed (usually a docs bug in the sequence), commit the plan update, restart from step 1 of that section.
- **tsc breaks unexpectedly on commit 3.** The comment-only changes cannot cause type errors; if tsc fails, you edited the wrong lines. `git diff packages/connector/src/dropin.ts` to compare against the explicit edits above.
- **`docs/deploy/*.md` already exists for one of the paths.** The plan assumes both are new. If either exists, merge rather than overwrite — preserve any existing content and add the new sections.
- **The controller rejects the register frame with `unknown_registration_token`.** The throwaway apps are minting registration tokens against an existing controller row. If the controller UI has a stale row with the same name, delete it in the controller UI first, then let the connector re-mint. If the controller uses OAuth2, swap `TUNNEL_AUTH_TOKEN` for `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` / `OAUTH_TOKEN_URL` in the secrets set.
- **You accidentally push the branch to origin.** Per project rule feature branches are local-only. `git push origin --delete cleanup/remove-npm` to undo; the local ref survives.
- **`git grep` still shows npm-consumer hits after commit 1.** Iterate: rewrite the file, `git add`, amend commit 1 with `git commit --amend --no-edit`. Only amend before commit 2 lands on top.
- **The plan itself is wrong about a file location.** File paths in this plan reflect the state at drafting time (2026-07-23). If a file has moved or been renamed, update the plan in the same commit as the fix — don't just work around it.

## Decisions log

1. **Docs-only pivot; no wire-format change, no code purge.** The connector already boots identically regardless of whether the container was built by npm alone or npm-plus-COPY. This pivot changes what we *tell* customers, not what the code does.

2. **Keep `packages/`, `bin`, `exports`, `files` in package.json.** They're internal build machinery + the CLI-inside-container use case. Deleting them would break `mcp-connector init` and the SDK re-export. Retain forever.

3. **Add `engines: { node: ">=22" }` defensively.** Not because we expect anyone to run npm outside the image, but so if someone tries, they fail loudly rather than silently on Node 20's missing native APIs.

4. **Lead with BOTH delivery paths, not one.** Customer diversity means dev-velocity shops want volume mount; enterprise/compliance shops want derived image. A one-path-only doc alienates half the audience. Both paths reach the same running connector — the only difference is the authoring workflow.

5. **Live-verify both paths on Fly, not just one.** Testing derived image only would leave volume-mount as untested advice. Two throwaway apps, ~20 minutes total.

6. **Don't touch `MCP_DROPIN_DIR` default.** `/var/lib/mcp-connector/customer-mcps` is exactly the right container-mount path; only the mental model around it changes.

7. **Preserve `mcp-connector init` in-container.** The wizard still works — it copies `.example` files into the customer's mounted config directory. Fully compatible with the container-first pivot.

8. **Retire the "publish flip" narrative from CLAUDE.md.** It was aspirational scaffolding; the actual delivery model is (and always was) the OCI image. Keeping the narrative implies a future pivot back that isn't planned.

9. **No changes to `authorOf()`, wire-format, or supervisor logic.** All connector-internal contracts hold.

10. **Fly-specific volume-mount friction gets an honest callout, not silence.** For customers deploying to Fly with multi-region, derived image is usually simpler. K8s/EKS shops have the opposite ergonomic — volumes are cheap there.

## Risk / rollback

- **Risk: docs drift.** New customer docs (`DERIVED-IMAGE.md`, `VOLUME-MOUNT.md`) are the surface for two full customer paths. If they omit a platform-specific gotcha, the customer hits it in prod. Mitigation: live-verify both on Fly (commits 4+5); explicitly call out per-platform quirks as they surface.
- **Risk: an in-repo caller I missed relies on the "customer project root post `npm i`" mental model in code, not docs.** Mitigation: run the grep in "What to delete" above and read every hit; the code touch-points are a small closed set (see graphify orient above).
- **Risk: someone tries to publish the package post-merge.** Mitigation: `"private": true` stays in place. The plan explicitly does not flip it.
- **Risk: customer confusion from the two-path story.** Mitigation: lead the README with a decision matrix, not a "one true way". Both paths reach the same running connector — the only difference is authoring workflow.
- **Rollback:** `git revert` the five commits. Zero on-disk state change on customer side.

## Post-merge follow-ups (out of scope for this branch)

- Consider adding a `mcp-connector deploy init --target derived-image` verb that scaffolds a customer-side `Dockerfile` with the `FROM` line pre-filled. Would round out the CLI story — but is genuinely new functionality, not cleanup.
- Consider adding a `mcp-connector doctor` check that warns if the customer is running the base image with an empty `MCP_DROPIN_DIR` — likely a mistake.
- The `docs/deploy/` directory currently has one file per cloud target (`aws-fargate.md`, `azure-container-apps.md`, `gke.md`, `fly.md`, `docker-compose.md`). After this branch, each of those should get a two-line note pointing at DERIVED-IMAGE.md and VOLUME-MOUNT.md as the customer-MCP authoring layer.
