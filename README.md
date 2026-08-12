# mcp-shim-connector

A customer-side **MCP connector**: dials out to a controller URL over WSS,
advertises locally-installed MCP servers as a `ToolManifest`, and dispatches
inbound `tools/call` requests to the right local server.

**No inbound ports.** **No LLM.** Just a tool dispatcher with policy — one
process behind your firewall, one WSS to the controller.

The controller is **outside this repo**. This repo is the customer side only.

## Choose your delivery path

Consume the connector as an OCI image (`ghcr.io/twilio/mcp-connector:<tag>`)
and drop your own Type 1 MCPs into a well-known path inside the container.
Two supported patterns land at the same path, use the same discovery code,
and reach the same running connector — pick by ergonomics:

|                    | Derived image                                     | Volume mount                              |
|--------------------|---------------------------------------------------|-------------------------------------------|
| Ergonomics         | Rebuild image to add an MCP                       | Edit file, click Refresh                  |
| Best fit           | Enterprise, image-signing shops, prod runbooks    | Dev, staging, small teams                 |
| Hot rescan         | No (rebuild required)                             | Yes (W-L2 refresh)                        |
| Version pinning    | Image tag is authoritative                        | Tag + mount contents can diverge          |
| Fly.io friendliness| Simple                                            | Volume/multi-region friction              |
| K8s friendliness   | Simple                                            | ConfigMap / PVC native                    |

Walkthroughs:
- [**Derived image**](deploy/DERIVED-IMAGE.md) — `FROM twilio/mcp-connector:<tag>` + `COPY ./my-mcps/ /var/lib/mcp-connector/customer-mcps/`, build, push, retarget your manifests.
- [**Volume mount**](deploy/VOLUME-MOUNT.md) — bind-mount a host directory / K8s PVC / Fly volume / AWS EFS / Azure Files at the same path.

There is no "customer runs `npm install` on their own Node server" path — the
connector is a daemon, not a library.

## What ships in the image

| Path in image                              | Purpose                                                                                                    |
|--------------------------------------------|------------------------------------------------------------------------------------------------------------|
| `/app/connector/`                          | Compiled connector runtime (Node)                                                                          |
| `/app/bundled-mcps/agentic-memory/`        | Type 1 Node bundle — mock memory + identity provider                                                       |
| `/app/bundled-mcps/enterprise-knowledge/`  | Type 3 config stub (Python venv installed under `/opt/bundled-mcps/enterprise-knowledge/.venv/`)           |
| `/opt/bundled-mcps/<name>/.venv/`          | Pre-installed Python venvs for Type 3 bundles                                                              |
| `/var/lib/mcp-connector/customer-mcps/`    | Runtime drop-zone for customer-authored Type 1 MCPs (via derived-image `COPY` or volume mount)             |
| `/etc/mcp-connector/connector.key`         | libsodium master key (mounted from your platform's secret store)                                           |

## Your first drop-in — one folder, one file

```bash
mkdir -p customer-mcps/hello/tools
```

`customer-mcps/hello/tools/greet.ts`:

```ts
import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

const tool: Tool<{ name: string }, { greeting: string }> = {
  name: "greet",
  description: "Say hello",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ greeting: z.string() }),
  async invoke({ name }) {
    return { greeting: `Hello, ${name}!` };
  },
};
export default tool;
```

Reboot the connector (or click **Refresh local MCPs** in the controller UI —
volume-mount only). The tool arrives on the manifest as `hello.greet`, gated
behind operator approval in the controller. Approve it and it's callable.

More depth: [docs/AUTHOR-LOCAL-MCP.md](docs/AUTHOR-LOCAL-MCP.md). Prompt +
resource authoring follow the same default-export shape.

## Deploy

Three shapes, in order of increasing surface area:

1. **Single VM / docker compose.** See [`deploy/compose/README.md`](deploy/compose/README.md).
2. **CLI-driven deploy.** Two commands: `mcp-connector deploy init --target
   {fargate|gke|aca|compose|fly}` emits manifests with your `CONNECTOR_NAME` +
   `CONTROLLER_URL` substituted in; then `mcp-connector deploy apply --target
   <t>` actually applies to the cloud. `apply` is implemented for `--target
   fly` today (spawns Fly's CLI directly with idempotency guards); other
   targets return "not yet implemented" — apply their emitted manifests
   manually with `aws` / `kubectl` / `az` / `docker compose`.
3. **IaC modules.** [`deploy/terraform/aws-fargate/`](deploy/terraform/aws-fargate/README.md)
   and [`deploy/helm/mcp-connector/`](deploy/helm/mcp-connector/README.md) for
   teams whose infrastructure is already declared in Terraform / Helm.

Per-cloud walkthroughs: [Fly.io](deploy/fly/README.md), [AWS Fargate](deploy/terraform/README.md), [Azure Container Apps](deploy/aca/README.md), [GCP GKE](deploy/helm/README.md).

Umbrella: [deploy/README.md](deploy/README.md).

### First-connect flow (all deploy paths)

1. Container boots. Postgres is empty. The inspector renders "Configure
   Tunnel".
2. Reach the inspector — `ssh -L 9090:127.0.0.1:9090 <host>`, `fly proxy
   9090:9090`, or `kubectl port-forward`. **Never** expose the inspector
   port to a public LB — the Webhooks panel surfaces bcrypt-protected
   URLs by design.
3. Fill in the modal: **Controller URL**, **Connector Name** (must match
   the Tunnel Security row Name in your controller UI, case-sensitive),
   auth posture (static bearer OR OAuth2).
4. Save. The inspector pill transitions closed → connecting → **open**.

No `.env` edits. No `connector.yaml`. No shell access after the initial
port-forward.

## Bundled MCPs (Twilio-shipped)

| Name                    | Kind          | Status                          |
|-------------------------|---------------|---------------------------------|
| `agentic-memory`        | Type 1 (Node) | Mock memory + identity provider |
| `enterprise-knowledge`  | Type 3 (Python venv) | LlamaIndex-backed RAG    |

Both are **always on** — no allowlist, no env-var gate. To disable, remove
the folder from your derived image or unmount it. Creds arrive via the
controller UI (production) or the inspector's session-creds paste (dev).

Third-party MCPs (Twilio, Segment, etc.) live outside this repo as standalone
npm packages loaded as Type 2 controller-config entries — added via the
controller UI, no code change.

## Docs

Architecture + protocol:
- [CLAUDE.md](CLAUDE.md) — authoritative architecture doc (topology, wire
  protocol, load-bearing invariants).
- [docs/MCP-PROTOCOL.md](docs/MCP-PROTOCOL.md) — wire-format reference.
- [docs/INSPECTOR.md](docs/INSPECTOR.md) — inspector UI walkthrough.
- [docs/ENV-VARS.md](docs/ENV-VARS.md) — every env var the connector reads.
- [docs/BUNDLES.md](docs/BUNDLES.md) — Twilio-shipped MCP inventory.
- [docs/AUTHOR-LOCAL-MCP.md](docs/AUTHOR-LOCAL-MCP.md) — how to write a drop-in.

Machine API (the JWT-bearer-gated routes an external system calls directly):
- [docs/NETWORK-ACCESS.md](docs/NETWORK-ACCESS.md) — minting credentials,
  non-loopback reachability, federated (own-IdP) bearers.
- [docs/OUTBOUND-CALLS.md](docs/OUTBOUND-CALLS.md) — `POST /v1/outbound/calls`,
  trigger a real outbound call or message.
- [docs/MEMORY-EVENTS.md](docs/MEMORY-EVENTS.md) — `POST /v1/identity/find`,
  `/v1/identity/list` and `/v1/memory/events`: resolve a customer, then tell an
  agent something out of band.

Deployment:
- [deploy/README.md](deploy/README.md) — decision matrix + prereqs.
- [deploy/DERIVED-IMAGE.md](deploy/DERIVED-IMAGE.md) / [deploy/VOLUME-MOUNT.md](deploy/VOLUME-MOUNT.md) — delivery paths.
- Per-platform: [deploy/fly/](deploy/fly/README.md), [deploy/terraform/](deploy/terraform/README.md), [deploy/helm/](deploy/helm/README.md), [deploy/aca/](deploy/aca/README.md), [deploy/compose/](deploy/compose/README.md).

## Building the image

```bash
./scripts/build-image.sh                                # local single-arch
IMAGE=registry/mcp-connector:0.1.0 PUSH=1 ./scripts/build-image.sh   # multi-arch + push
```

Multi-arch defaults are `linux/amd64,linux/arm64` (Graviton + ARM Macs).

## Verifying a deployment

```bash
docker exec <container> mcp-connector doctor
```

Exit 0 = all preflight checks pass (Postgres reachable, master key readable,
required env vars set). Exit 1 = something's wrong; exit 2 = warn-only.
Designed for `doctor && start` runbooks in your entrypoint.

## Contributing (in-repo development)

```bash
npm install
npm run build
./scripts/start-connector.sh
```

You'll need a local Postgres (or `docker compose -f deploy/compose/docker-compose.prod.yml
up postgres`) and a master key at `$CONNECTOR_KEY_FILE`. Tests: `cd connector && npm test`.
