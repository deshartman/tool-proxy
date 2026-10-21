# Delivery path: volume mount

One of two supported ways to ship customer-authored **Type 1** MCPs into a
running connector. Sibling doc: [DERIVED-IMAGE.md](./DERIVED-IMAGE.md).

## When to use

- You want to add or edit a Type 1 MCP without rebuilding the container
  image.
- Dev / staging environments where the edit-and-refresh loop matters.
- You want the controller's **Refresh local MCPs** button (W-L2 hot
  rescan) to actually surface new MCPs live.
- You're already provisioning persistent storage (PVCs / Fly volumes /
  EFS) for other reasons and adding one more mount is cheap.

Not the right fit when reproducibility matters more than iteration
speed — use [DERIVED-IMAGE.md](./DERIVED-IMAGE.md) for that.

## The mount point

`/var/lib/tool-proxy/customer-mcps/` — this is `PROD_DEFAULT` in
[`src/dropin.ts`](../connector/src/dropin.ts). Each
subdirectory is one MCP; the folder name is the server name.

The connector's drop-in scanner (`discoverDropins`) walks this path at
boot and again on every `local-mcps-rescan` frame. No branching by
delivery path — a derived-image `COPY` and a bind-mount hit the same
code.

## File ownership — mount must be readable by UID `mcp`

The connector runtime container runs as the non-root user `mcp:mcp`
(created in the Alpine runtime stage of `connector/Dockerfile`). A
volume mount whose files are owned by a different UID may be
unreadable, causing `discoverDropins` to silently skip the folder.

**Symptom:** `local-mcps-rescan` returns zero `added`; the drop-in
scanner log shows `permission denied` on the folder or its `tools/`
subdir.

**Fixes, ordered by platform ergonomics:**

- **Kubernetes** — set `securityContext.fsGroup: 65534` (or match the
  `mcp` group's actual GID in the image) on the pod spec; the kubelet
  reassigns ownership on mount. Or set `fsGroupChangePolicy: OnRootMismatch`
  for large mounts.
- **Fly.io volumes** — bind-mount is initialized empty; the connector
  creates files as `mcp` so nothing to chown.
- **AWS EFS / Azure Files** — set `uid=<mcp UID>,gid=<mcp GID>` in the
  CSI driver's volume attributes, OR run an `initContainer` that
  `chown -R mcp:mcp` the mount before the connector starts.
- **docker-compose bind-mount** — `chown -R <mcp UID>:<mcp GID>` on
  the host directory before `docker compose up`. The `mcp` user's
  numeric UID/GID is stable across image versions once fixed; check
  with `docker run --rm ghcr.io/twilio/tool-proxy id mcp`.

Don't relax the container's non-root stance to work around a mount
permission issue — the non-root UID is a load-bearing security
property (see [`../CLAUDE.md`](../CLAUDE.md) "Distribution" section).

## Per-platform recipes

### Kubernetes — ConfigMap projection (small MCPs)

Good for a handful of `.ts` files with no third-party deps.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: customer-mcps
data:
  hello-tools-hello.ts: |
    import { z } from "zod";
    import type { Tool } from "@gtmi/toolproxy-connector/sdk";
    const hello: Tool = { /* ... */ };
    export default hello;
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tool-proxy
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: connector
          image: twilio/tool-proxy:1.0
          volumeMounts:
            - name: customer-mcps
              mountPath: /var/lib/tool-proxy/customer-mcps
              readOnly: true
      volumes:
        - name: customer-mcps
          configMap:
            name: customer-mcps
            items:
              - key: hello-tools-hello.ts
                path: hello/tools/hello.ts
```

The `items[].path` mapping is how you materialize a
`<mcp-name>/tools/<tool>.ts` tree from a flat ConfigMap. Re-apply the
ConfigMap and the volume re-projects on the next kubelet sync — click
**Refresh local MCPs** in the controller UI to pick up the change
without a pod restart.

Limits: ConfigMap size cap is 1 MiB per resource, no `node_modules`,
projected files are read-only.

### Kubernetes — PersistentVolumeClaim (deps + iteration)

Good when Type 1 MCPs need their own `node_modules` or when you want a
long-lived writable staging area.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: customer-mcps
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
```

Mount at the same path:

```yaml
      volumes:
        - name: customer-mcps
          persistentVolumeClaim:
            claimName: customer-mcps
```

Populate the volume via an initContainer that pulls from git / a
tarball / an object store, or via a sidecar job that periodically
rsyncs from a source of truth. Common shapes:

- **Git-clone initContainer** — clones your customer-mcps repo into the
  volume before the connector container starts.
- **rsync sidecar** — periodic pull loop against S3 / GCS.
- **Manual `kubectl cp`** — quickest for staging, not for prod.

### Kubernetes — emptyDir + initContainer (immutable per pod)

If you don't want persistence but do want deps, an initContainer that
tarball-extracts into an `emptyDir` at pod-start is the simplest shape:

```yaml
      initContainers:
        - name: fetch-mcps
          image: curlimages/curl:8.5.0
          command:
            - sh
            - -c
            - |
              curl -fsSL https://internal.example.com/customer-mcps.tar.gz \
                | tar -xzf - -C /var/lib/tool-proxy/customer-mcps
          volumeMounts:
            - name: customer-mcps
              mountPath: /var/lib/tool-proxy/customer-mcps
      volumes:
        - name: customer-mcps
          emptyDir: {}
```

Refresh requires a pod restart in this shape (the initContainer only
runs at pod-start).

### Fly.io

Use a Fly volume attached to the machine. Note that Fly volumes are
per-machine — the multi-region story is friction-heavy, and for teams
running the connector across regions the [derived-image
path](./DERIVED-IMAGE.md) is usually simpler on Fly specifically.

```toml
# fly.toml
[[mounts]]
  source = "customer_mcps"
  destination = "/var/lib/tool-proxy/customer-mcps"
```

Provision + populate:

```bash
fly volumes create customer_mcps --size 1 --region <region> -a <app>
fly deploy -a <app>
fly ssh sftp shell -a <app>
# put -r my-mcps /var/lib/tool-proxy/customer-mcps
```

After every SFTP change, click **Refresh local MCPs** in the controller
UI to trigger a W-L2 rescan.

### AWS Fargate — EFS

Bind-mount an EFS file system into the task via
`volumes[].efsVolumeConfiguration`:

```json
{
  "volumes": [{
    "name": "customer-mcps",
    "efsVolumeConfiguration": {
      "fileSystemId": "fs-01234567",
      "rootDirectory": "/customer-mcps"
    }
  }],
  "containerDefinitions": [{
    "name": "connector",
    "image": "twilio/tool-proxy:1.0",
    "mountPoints": [{
      "sourceVolume": "customer-mcps",
      "containerPath": "/var/lib/tool-proxy/customer-mcps",
      "readOnly": true
    }]
  }]
}
```

Prerequisites: an EFS file system with a mount target in each subnet the
Fargate task can reach, plus a security group opening NFS (TCP 2049) from
the task's SG to the EFS mount target's SG. Populate EFS by mounting it
on an EC2 bastion or via DataSync.

### Azure Container Apps — Azure Files

Attach an Azure Files share to the environment, then mount it in the app:

```yaml
properties:
  configuration:
    ingress: { external: false }   # inspector is loopback-only
  template:
    containers:
      - image: twilio/tool-proxy:1.0
        volumeMounts:
          - volumeName: customer-mcps
            mountPath: /var/lib/tool-proxy/customer-mcps
    volumes:
      - name: customer-mcps
        storageType: AzureFile
        storageName: my-mcps-share   # matches the env-level storage entry
```

Populate via `az storage file upload-batch` against the Azure Files
share; refresh via the controller's **Refresh local MCPs** button.

### docker-compose (single VM)

Simplest recipe — bind-mount a host directory:

```yaml
services:
  connector:
    image: twilio/tool-proxy:1.0
    volumes:
      - ./mcp/local:/var/lib/tool-proxy/customer-mcps:ro
    ports:
      - "127.0.0.1:9090:9090"   # inspector loopback-only, do NOT bridge to 0.0.0.0
```

Edit files under `./mcp/local` on the host, click **Refresh local MCPs**
in the controller UI, tools appear live. This is the fastest iteration
loop of any deployment target.

## Verifying the mount worked

```bash
# Kubernetes
kubectl exec deploy/tool-proxy -- ls /var/lib/tool-proxy/customer-mcps

# Fly
fly ssh console -a <app> -C 'ls /var/lib/tool-proxy/customer-mcps'

# docker-compose
docker compose exec connector ls /var/lib/tool-proxy/customer-mcps

# Fargate — one-shot task with the same image + volume, or check via
# Session Manager on a bastion that mounts the same EFS path.
```

After confirming the directory has your MCP folder(s), click **Refresh
local MCPs** in the controller UI (Connector detail → MCPs tab). The
frame flows down the tunnel, the connector re-runs its drop-in scanner,
and any new / removed / renamed folders reconcile against the running
supervisor. Approval-gated per CLAUDE.md's "Customer drop-ins gated by
controller approval" invariant — the operator has to click Approve on
each newly-discovered MCP before its tools land on the manifest.

## Interaction with W-L2 rescan

This is where the volume-mount path earns its keep. Two triggers:

- **Controller UI** — Connector detail → MCPs tab → **Refresh local
  MCPs**. Emits a `local-mcps-rescan` frame; connector re-runs
  `discoverDropins`; manifest changes ride the existing `manifest-delta`
  path.
- **Inspector loopback** — <http://localhost:9090/> → **MCP Status**
  panel → **Refresh local MCPs**. Same coordinator method, no controller
  round-trip. Useful when iterating locally.

Operator-driven only — there is no filesystem watcher. See
`connector/README.md` §"Refresh without a restart" for the
rationale.

## Verified example

Live-fired against Fly.io on 2026-07-23 with the exact commands below.
Boots empty, W-L2 rescan picks up `hello-volume` after upload, second
rescan picks up `world-late` — no machine restart, no redeploy.

### Directory layout

```
test/deploy/volume-mount/            # gitignored
├── connector.yaml                   # tunnel: block + empty mcp_servers + policy
├── fly.toml                         # env-mode, volume at drop-in path
├── hello-volume/                    # uploaded first
│   └── tools/
│       └── hello.ts
└── world-late/                      # uploaded after boot to prove hot rescan
    └── tools/
        └── world.ts
```

### fly.toml (relevant excerpts)

```toml
app = "tool-proxy-volume-test"
primary_region = "iad"

[env]
  CONNECTOR_CONFIG = "/etc/tool-proxy/config.yaml"
  INSPECTOR_PORT = "9090"
  INSPECTOR_BIND_ADDR = "::"

# Mount the volume AT the drop-in path — this is the whole point.
[[mounts]]
  source = "customer_mcps"
  destination = "/var/lib/tool-proxy/customer-mcps"

[[files]]
  guest_path = "/etc/tool-proxy/config.yaml"
  local_path = "connector.yaml"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "512mb"

[deploy]
  strategy = "immediate"
```

### Deploy

```bash
# 1. Base image (from this repo's root)
IMAGE=tool-proxy:local-npm-pivot PLATFORMS=linux/amd64 ./scripts/build-image.sh

# 2. Fly app + secrets + volume
cd test/deploy/volume-mount
fly apps create tool-proxy-volume-test --org personal
fly secrets set \
  CONTROLLER_URL="$CONTROLLER_URL" \
  CONNECTOR_NAME=tool-proxy-volume-test \
  TUNNEL_AUTH_TOKEN="$TUNNEL_AUTH_TOKEN" \
  -a tool-proxy-volume-test
fly volumes create customer_mcps --size 1 --region iad -a tool-proxy-volume-test -y

# 3. Deploy the base image (no derived layer — customer MCPs land via volume)
fly deploy --local-only --image tool-proxy:local-npm-pivot -a tool-proxy-volume-test
```

Boot log shows 0 MCPs (volume is empty), tunnel connected, register-ack OK.

### Upload first MCP (hello-volume)

Fly's SFTP shim doesn't support recursive `put` or `mkdir`, so pre-create
the target directory with a one-shot SSH command, then upload each file.

```bash
fly ssh console -a tool-proxy-volume-test \
  -C 'mkdir -p /var/lib/tool-proxy/customer-mcps/hello-volume/tools'

fly ssh sftp shell -a tool-proxy-volume-test <<'EOF'
put hello-volume/tools/hello.ts /var/lib/tool-proxy/customer-mcps/hello-volume/tools/hello.ts
EOF
```

### Trigger W-L2 rescan

Two equivalent triggers — pick whichever fits your workflow.

**Option A — Controller UI.** Connector detail → MCPs tab → **Refresh
local MCPs**. Sends a `local-mcps-rescan` frame down the tunnel.

**Option B — the inspector's loopback route.** No controller round-trip. This
is what the tests below use. `/mcp/rescan-local` is not one of the four
allowlisted machine-API paths, so it needs a loopback caller like every other
inspector route — on Fly that means a relay, not just `fly proxy` (see
[deploy/fly/README.md](fly/README.md#reach-the-inspector-dashboard)).

```bash
# Terminal 1 — leave running; prints the URL and its port.
./scripts/fly-inspector.sh tool-proxy-volume-test

# Terminal 2 — use the port it printed.
curl -sS -X POST http://localhost:9099/mcp/rescan-local
# → {"ok":true,"added":[{"name":"hello-volume","toolsCount":0}],"removed":[],"unchanged":[],"errors":[]}
```

`toolsCount: 0` at the rescan-response layer is expected — the drop-in
approval gate withholds the tools from the manifest until the operator
approves. In the connector logs you'll see the child spawn and the
`mcp-discovered` frame emit with `toolCount: 1`.

### Upload second MCP (world-late) and rescan hot

```bash
fly ssh console -a tool-proxy-volume-test \
  -C 'mkdir -p /var/lib/tool-proxy/customer-mcps/world-late/tools'

fly ssh sftp shell -a tool-proxy-volume-test <<'EOF'
put world-late/tools/world.ts /var/lib/tool-proxy/customer-mcps/world-late/tools/world.ts
EOF

curl -sS -X POST http://localhost:9090/mcp/rescan-local
# → {"ok":true,"added":[{"name":"world-late","toolsCount":0}],"removed":[],"unchanged":["hello-volume"],"errors":[]}
```

The `unchanged: ["hello-volume"]` field confirms the coordinator
reconciled correctly against the already-spawned entry.

### Verify from logs

```bash
fly logs -a tool-proxy-volume-test --no-tail | grep -E \
  'spawning MCP child|mcp-discovered emitted|local-mcps rescan applied'
```

Expected sequence (per rescan):

```
… spawning MCP child … "name":"hello-volume","dropin":true
… "component":"hello-volume" … "tools":["hello"] … listening
… mcp-discovered emitted … "mcp":"hello-volume","toolCount":1
… local-mcps rescan applied … "added":["hello-volume"]

… spawning MCP child … "name":"world-late","dropin":true
… "component":"world-late" … "tools":["world"] … listening
… mcp-discovered emitted … "mcp":"world-late","toolCount":1
… local-mcps rescan applied … "added":["world-late"] … "unchanged":["hello-volume"]
```

Both children keep running; no machine restart between uploads.

### Cleanup

```bash
fly apps destroy tool-proxy-volume-test -y
```

The volume goes with the app.

