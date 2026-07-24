# Delivery path: derived image

One of two supported ways to ship customer-authored **Type 1** MCPs into a
running connector. Sibling doc: [VOLUME-MOUNT.md](./VOLUME-MOUNT.md).

## When to use

- Enterprise environments with signed-image policies or air-gapped registries.
- Shops that already CI-build and scan every image before it hits prod.
- Reproducible prod runbooks where "same image tag → same behavior" matters.
- Deployments where the extra image-build step per MCP change is acceptable.

Not the right fit when you want to iterate on a Type 1 MCP without a
build-and-push cycle — use [VOLUME-MOUNT.md](./VOLUME-MOUNT.md) for that.

## How it works

The base image `twilio/mcp-connector:<tag>` bakes the connector, `tsx`,
`mcp/` tree, and Python venvs for Type 3 bundles into a runtime layer.
Your derived image copies your Type 1 MCPs into the well-known drop-in
path — the same path the volume-mount path bind-mounts into — and the
connector's drop-in scanner picks them up at boot with **zero connector
changes**.

Mount point: `/var/lib/mcp-connector/customer-mcps/` (the `PROD_DEFAULT`
in [`src/dropin.ts`](../connector/src/dropin.ts)). Folder name
= MCP name.

## Prerequisites

- Docker or a compatible builder (Buildah, Podman, kaniko, etc.).
- Access to pull `twilio/mcp-connector:<tag>` from your registry.
- Somewhere to push the derived image (your registry).

## The Dockerfile

Minimum viable derived image:

```dockerfile
FROM twilio/mcp-connector:1.0

# Drop your Type 1 MCPs into the well-known path. Each subdirectory
# becomes an MCP; the folder name is the server name announced on the
# manifest.
COPY ./my-mcps/ /var/lib/mcp-connector/customer-mcps/
```

That's it — the base image's `ENTRYPOINT` and `CMD` are inherited, so
`docker run <your-tag>` boots the connector with your MCPs already
discovered. Approval-gated per CLAUDE.md's "Customer drop-ins gated by
controller approval" invariant — the controller operator has to click
Approve before the tools land on the manifest.

### Optional: bake a curated `connector.yaml`

Only useful if you're pinning yaml-listed Type 3 bundles or legacy
hand-written Type 1 entries. Customer creds should still come from the
controller, not build-time env.

```dockerfile
COPY ./connector.yaml /etc/mcp-connector/config.yaml
```

Set `CONNECTOR_CONFIG=/etc/mcp-connector/config.yaml` at runtime, or rely
on the default resolution from CWD.

### Optional: install third-party Node deps per MCP

If any of your Type 1 MCPs declare `dependencies` in their `package.json`
(e.g. an SDK the connector's workspace root doesn't hoist), run
`npm install` inside each folder at image-build time — the connector
won't do it for you at boot in a derived image:

```dockerfile
RUN find /var/lib/mcp-connector/customer-mcps -maxdepth 2 -name package.json \
    -execdir sh -c 'test "$(node -e "console.log(Object.keys(require(\"./package.json\").dependencies||{}).length)")" != "0" \
      && npm install --omit=dev --no-package-lock' \;
```

If none of your Type 1 folders declare third-party deps (framework deps
like `zod` and `@mcp-shim/connector/sdk` resolve up to the base image's
workspace `node_modules`), this step is unnecessary.

## Build + push

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t your-registry/mcp-connector:1.0-with-my-mcps \
  --push .
```

Match the base image's architecture set. If your target cluster is
single-arch, drop the `--platform` flag.

## Deploy

Retarget your existing manifests to your derived image tag — nothing else
changes. All four `mcp-connector deploy init --target` outputs
(`fargate` / `gke` / `aca` / `compose` / `fly`) accept a customer-owned
image tag; there's no branching in the connector's runtime behavior.

Examples:

- **Kubernetes** — `spec.template.spec.containers[0].image` in your
  Deployment or the Helm chart's `image.repository` / `image.tag`.
- **Fly.io** — `image = "your-registry/mcp-connector:1.0-with-my-mcps"` in
  `fly.toml`.
- **AWS Fargate** — `containerDefinitions[0].image` in your task def, or
  the Terraform module's `image` variable.
- **Azure Container Apps** — `containers[0].image` in the app spec.

## Update loop trade-off

**New Type 1 MCP or edit to an existing one → new image build → redeploy.**
That's the cost of the derived-image path.

For teams already running CI-per-commit against an internal container
registry, this is often invisible: push, image builds, deploy pipeline
triggers, connector restarts. For teams iterating on a Type 1 MCP mid-
authoring, use the volume-mount path instead — it's specifically designed
for the edit-and-refresh flow.

## Interaction with W-L2 controller rescan

The controller UI exposes **Refresh local MCPs** (Connector detail →
MCPs tab), which pushes a `local-mcps-rescan` frame down the tunnel. On
receipt the connector re-runs `discoverDropins` against
`MCP_DROPIN_DIR`.

In a **derived image**, the drop-in tree is baked into the image layer —
files can't change while the container runs. Clicking Refresh will
re-list the same folders and produce no manifest delta. This is
expected: **hot-reload is a volume-mount feature**, not a derived-image
feature. To pick up new MCPs on a derived image, rebuild + redeploy.

## Verified example

Live-fired against Fly.io on 2026-07-23 with the exact commands below.
The connector booted, discovered the drop-in, tunneled to the controller,
and emitted `mcp-discovered` for the new MCP — the approval + tool-call
last mile is a controller-side flow that works identically regardless of
delivery path.

### Directory layout

```
test/deploy/derived-image/            # gitignored
├── Dockerfile                        # FROM mcp-connector:local-npm-pivot + COPY
├── connector.yaml                    # tunnel: block + empty mcp_servers + policy
├── fly.toml                          # env-mode, no [[services]], volume at /data
└── hello-derived/                    # this is the customer's MCP folder
    └── tools/
        └── hello.ts                  # one Tool that returns a message
```

### Dockerfile

```dockerfile
FROM mcp-connector:local-npm-pivot
COPY ./hello-derived/ /var/lib/mcp-connector/customer-mcps/hello-derived/
```

### fly.toml (relevant excerpts)

```toml
app = "mcp-shim-derived-test"
primary_region = "iad"

[env]
  CONNECTOR_CREDS_SOURCE = "env"
  CONNECTOR_CONFIG = "/etc/mcp-connector/config.yaml"
  # State volume mounted at /data so it doesn't mask the derived-image's
  # drop-in path baked in at /var/lib/mcp-connector/customer-mcps/.
  CONNECTOR_STATE_PATH = "/data/.connector-state.json"
  INSPECTOR_PORT = "9090"
  INSPECTOR_BIND_ADDR = "::"

[[mounts]]
  source = "state"
  destination = "/data"

[[files]]
  guest_path = "/etc/mcp-connector/config.yaml"
  local_path = "connector.yaml"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "512mb"

[deploy]
  strategy = "immediate"
```

> **Fly volume masking pitfall.** If you mount a Fly volume at
> `/var/lib/mcp-connector` (the connector image's default state dir), the
> mount masks any subdirectories the derived image COPYed into that path
> — the drop-in scanner will find zero MCPs. Two fixes: (1) mount the
> volume at a sibling path like `/data` and set `CONNECTOR_STATE_PATH`
> accordingly, as shown above; or (2) override `MCP_DROPIN_DIR` to a path
> outside the mount and have your Dockerfile COPY there instead.

### Build + deploy

```bash
# 1. Build the base image (from this repo's root)
IMAGE=mcp-connector:local-npm-pivot PLATFORMS=linux/amd64 ./scripts/build-image.sh

# 2. Build the derived image
cd test/deploy/derived-image
docker build --platform linux/amd64 -t mcp-shim-derived:test .

# 3. Create Fly app + secrets + state volume
fly apps create mcp-shim-derived-test --org personal
fly secrets set \
  CONNECTOR_CREDS_SOURCE=env \
  CONTROLLER_URL="$CONTROLLER_URL" \
  CONNECTOR_NAME=mcp-shim-derived-test \
  TUNNEL_AUTH_TOKEN="$TUNNEL_AUTH_TOKEN" \
  -a mcp-shim-derived-test
fly volumes create state --size 1 --region iad -a mcp-shim-derived-test -y

# 4. Deploy the pre-built local image (bypasses Fly's remote builder)
fly deploy --local-only --image mcp-shim-derived:test -a mcp-shim-derived-test
```

### Verify

```bash
# Inspector
fly proxy 9090:9090 -a mcp-shim-derived-test
# open http://localhost:9090/ → hello-derived visible under MCP Server

# Boot logs — grep the sequence
fly logs -a mcp-shim-derived-test --no-tail | grep -E \
  'name.*hello-derived|tunnel connected|register-ack|mcp-discovered'
```

Expected log sequence:

```
… mcp spawn env-sources … "name":"hello-derived"
… connected to local servers … "servers":["hello-derived"]
… tunnel connected …
… register-ack ok — bound to existing record …
… mcp-discovered emitted … "mcp":"hello-derived","toolCount":1
```

In the controller UI, `hello-derived` appears in the connector's Pending
Approval lane. Click Approve; call `hello-derived.hello`; receive
`{ message: "hello from derived-image path, <who>" }`.

### Cleanup

```bash
fly apps destroy mcp-shim-derived-test -y
```

The volume goes with the app.

