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
2. Reach the inspector — `ssh -L 9090:127.0.0.1:9090 <host>`, `docker exec`,
   or `kubectl port-forward`. **Never** expose the inspector port to a public
   LB — the Webhooks panel surfaces bcrypt-protected URLs by design.
   On **Fly.io** `fly proxy` does NOT work for this step; see the note below.
3. Fill in the modal: **Controller URL**, **Connector Name** (must match
   the Tunnel Security row Name in your controller UI, case-sensitive),
   auth posture (static bearer OR OAuth2).
4. Save. The inspector pill transitions closed → connecting → **open**.

No `.env` edits. No `connector.yaml`. No shell access after the initial
port-forward.

#### Why only those three, and why Fly is different

Every route except four machine-API paths requires a **loopback** caller, and
there is no login, token, or opt-in that changes it. So a port-forward is not
merely convenient — it is the mechanism. The three above work because each one
presents a genuine loopback origin: `ssh -L` has the remote sshd dial
`localhost` from the host, `kubectl port-forward` enters the pod's network
namespace, and `docker exec` runs inside the container.

A forward that merely reaches the host's port from outside is **not** enough.
Fly's `fly proxy` is exactly that case — it routes over the private 6PN mesh to
the Machine's `fdaa:` address without entering its namespace, and `fly ssh` has
no `-L`. So on Fly every dashboard route answers:

```
403 {"ok":false,"error":"forbidden: loopback only"}
```

Because step 2 above is the only way to configure the tunnel — there is no CLI
subcommand and no env var for it — **a fresh Fly deployment cannot complete
first-connect without supplying that missing loopback hop yourself.** The
recipe, and the exposure it trades away while it runs, are in
[deploy/fly/README.md](deploy/fly/README.md#reach-the-inspector-dashboard).

This is platform coverage, not a flaw in the model: the loopback rule is
deliberate ([CLAUDE.md](CLAUDE.md), [docs/INSPECTOR.md](docs/INSPECTOR.md)), and
Fly is the one supported target that offers no loopback-origin forward. Widening
the bind does not help — `INSPECTOR_BIND_ADDR` decides whether the process
accepts the connection; the gate then judges where it came from.

## Bundled MCPs (Twilio-shipped)

| Name                    | Kind          | Status                          |
|-------------------------|---------------|---------------------------------|
| `agentic-memory`        | Type 1 (Node) | Mock memory + identity provider |

**Always on** — no allowlist, no env-var gate. To disable, remove the folder
from your derived image or unmount it. Creds arrive via the controller UI
(production) or the inspector's session-creds paste (dev).

Third-party MCPs (Twilio, Segment, etc.) live outside this repo as standalone
npm packages loaded as Type 2 controller-config entries — added via the
controller UI, no code change.

## How MCPs reach the connector

Two patterns, and only two. Which one you want depends on who runs the process.

| | **Type 1 — drop-in** | **Type 2 — external** |
|---|---|---|
| Who runs it | The connector spawns it | You already run it |
| Language | Node/TypeScript | Any |
| You provide | A folder of `tools/*.ts` | A URL or command, plus an auth shape |
| Registered by | Dropping the folder in `/var/lib/mcp-connector/customer-mcps/` | The controller UI |
| Transport | HTTP child on a localhost port the connector assigns | streamable-http, SSE, or stdio |
| Credentials | Controller pushes them; declare key *names* via `envKeys` | Request headers, or env for stdio |
| Operator approval | **Required** — tools stay off the manifest until approved | Not needed; adding it in the UI *is* the approval |

Everything the connector can talk to is one of these. A retrieval system, an
inference server, a database-backed service, an internal API — each runs in its
own process as an MCP, and the connector dispatches to it. Nothing heavy is ever
compiled into the connector itself.

Anything non-Node is Type 2. That is not a limitation to work around — it is the
supported path, and it costs you nothing beyond running your own process, which
you were doing anyway.

If what you need is retrieval over your own documents, the tool contract to
implement is in
[docs/KNOWLEDGE-MCP-INTERFACE.md](docs/KNOWLEDGE-MCP-INTERFACE.md).

## Docs

Architecture + protocol:
- [CLAUDE.md](CLAUDE.md) — authoritative architecture doc (topology, wire
  protocol, load-bearing invariants).
- [docs/MCP-PROTOCOL.md](docs/MCP-PROTOCOL.md) — wire-format reference.
- [docs/INSPECTOR.md](docs/INSPECTOR.md) — inspector UI walkthrough.
- [docs/ENV-VARS.md](docs/ENV-VARS.md) — every env var the connector reads.
- [docs/AUTHOR-LOCAL-MCP.md](docs/AUTHOR-LOCAL-MCP.md) — how to write a drop-in.
- [docs/KNOWLEDGE-MCP-INTERFACE.md](docs/KNOWLEDGE-MCP-INTERFACE.md) — the MCP
  contract to implement if you need retrieval over your own documents.

Machine API (the JWT-bearer-gated routes an external system calls directly):
- [docs/NETWORK-ACCESS.md](docs/NETWORK-ACCESS.md) — minting credentials,
  non-loopback reachability, federated (own-IdP) bearers.
- [docs/OUTBOUND-CALLS.md](docs/OUTBOUND-CALLS.md) — `POST /v1/outbound/calls`,
  trigger a real outbound call or message.
- [docs/MEMORY-EVENTS.md](docs/MEMORY-EVENTS.md) — `POST /v1/identity/list` and
  `/v1/memory/events`: resolve a customer, then tell an agent something out of
  band.

Deployment:
- [deploy/README.md](deploy/README.md) — decision matrix + prereqs.
- [deploy/DERIVED-IMAGE.md](deploy/DERIVED-IMAGE.md) / [deploy/VOLUME-MOUNT.md](deploy/VOLUME-MOUNT.md) — delivery paths.
- Per-platform: [deploy/fly/](deploy/fly/README.md), [deploy/terraform/](deploy/terraform/README.md), [deploy/helm/](deploy/helm/README.md), [deploy/aca/](deploy/aca/README.md), [deploy/compose/](deploy/compose/README.md).
- **Fly.io operators:** the inspector dashboard is not reachable via `fly proxy` — see
  [Reach the inspector dashboard](deploy/fly/README.md#reach-the-inspector-dashboard).

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
