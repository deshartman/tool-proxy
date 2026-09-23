// Deploy scaffold templates. One entry per target, each a map of
// relativePath → template string. Substitution is `String.replaceAll` on
// `{{NAME}}`, `{{APP_NAME}}`, `{{IMAGE}}` — plain, no engine.
//
// Adding a new target: append a key to TEMPLATES with the file map;
// add the target to the TARGETS union in scaffold.ts.
//
// These are LITERAL cloud manifests, not exhaustive infrastructure — they
// cover the connector container, its config mount, its state volume, and
// its secrets. Everything else (cluster, network, DNS) the customer
// supplies. See deploy/**/*.md for the reasoning.

// `gke` was removed. It rendered raw Kubernetes manifests that duplicated
// deploy/helm/mcp-connector, and duplicated it badly: no master-key Secret at
// all (so the pod could not boot), no resource requests or limits (so it was
// scheduled anywhere and OOM-killed under the 493 MB floor), a placeholder
// `mcp_servers` entry pointing at a service that never existed, and — the one
// that needed a redesign rather than a patch — a read-only ConfigMap mounted at
// /etc/mcp-connector, which is exactly where entrypoint.sh must WRITE the key
// it decodes from CONNECTOR_KEY_B64.
//
// Kubernetes has one path now: the Helm chart. `helm template` produces raw
// manifests for anyone whose policy forbids installing releases. Keeping both
// was the mistake DB-TO-FILE's Stage 3 diagnosed — two artifacts per platform
// drift independently, and the drift is invisible because each one is
// internally valid.
export type ScaffoldTarget = "fargate" | "aca" | "compose" | "fly" | "fly-mock";

export interface ScaffoldVars {
  name: string;
  // Fly-only: the Fly.io app name for the connector Machine. (It used to also
  // name an attached Postgres at `{{APP_NAME}}-db`; the connector needs no
  // database now, so `deploy apply` creates no such app — the fly-mock target
  // provisions its own.) Defaults are computed by scaffold.ts based
  // on target — `mcp-connector-<name>` for fly, `mock-customers-<name>` for
  // fly-mock. Non-Fly targets ignore this field (their prefixes are baked
  // into the template — ECS task family, K8s namespace, etc.).
  appName: string;
  image: string;
}

// `controllerUrl` and `auth` were removed from this interface, and the CLI no
// longer prompts for them. No template referenced {{CONTROLLER_URL}} or
// {{AUTH}} once ENV-TO-DB retired CONTROLLER_URL and made the auth posture a
// choice in the inspector's Configure Tunnel modal — so `deploy init --yes` was
// REQUIRING --controller-url and then discarding it. That is the same defect
// this work removed from the Helm chart (four dead `required` values) and the
// Terraform module (an ignored controller_url input); leaving it in the CLI
// would have been inconsistent.
//
// `targetNeedsControllerUrl` went with them: it existed only to skip the prompt
// for fly-mock, and there is no prompt now.

interface TemplateFile {
  path: string;
  content: string;
}

export interface RenderedTarget {
  files: TemplateFile[];
  readmeAppendix: string;
}

export function render(target: ScaffoldTarget, vars: ScaffoldVars): RenderedTarget {
  const template = TEMPLATES[target];
  const files = template.files.map((f) => ({
    path: f.path,
    content: substitute(f.content, vars),
  }));
  return { files, readmeAppendix: substitute(template.readmeAppendix, vars) };
}

function substitute(template: string, vars: ScaffoldVars): string {
  return template
    .replaceAll("{{APP_NAME}}", vars.appName)
    .replaceAll("{{NAME}}", vars.name)
    .replaceAll("{{IMAGE}}", vars.image);
}

interface Template {
  files: TemplateFile[];
  readmeAppendix: string;
}

// ---------- fargate ----------

const FARGATE_TASK_DEF = `{
  "family": "mcp-connector-{{NAME}}",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "512",
  "memory": "2048",
  "containerDefinitions": [
    {
      "name": "connector",
      "image": "{{IMAGE}}",
      "essential": true,
      "environment": [
        { "name": "CONNECTOR_CONFIG",    "value": "/etc/mcp-connector/config.yaml" },
        { "name": "CONNECTOR_KEY_FILE",  "value": "/etc/mcp-connector/connector.key" },
        { "name": "INSPECTOR_PORT",      "value": "9090" },
        { "name": "HEALTH_PORT",         "value": "9100" }
      ],
      "secrets": [
        { "name": "CONNECTOR_KEY_B64", "valueFrom": "REPLACE_WITH_SECRETS_MANAGER_ARN" }
      ],
      "mountPoints": [
        { "containerPath": "/var/lib/mcp-connector", "sourceVolume": "state" }
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "wget -qO- http://127.0.0.1:9100/readyz >/dev/null 2>&1 || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 90
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/mcp-connector-{{NAME}}",
          "awslogs-region": "REPLACE_WITH_REGION",
          "awslogs-stream-prefix": "connector"
        }
      }
    }
  ],
  "volumes": [
    {
      "name": "state",
      "efsVolumeConfiguration": {
        "fileSystemId": "REPLACE_WITH_EFS_FILESYSTEM_ID",
        "transitEncryption": "ENABLED",
        "authorizationConfig": {
          "accessPointId": "REPLACE_WITH_EFS_ACCESS_POINT_ID",
          "iam": "ENABLED"
        }
      }
    }
  ]
}
`;

// Companion: Secrets Manager + EFS stubs. Not applied — the customer decides
// how they populate the ARN and which VPC the filesystem lives in. Emitted as
// comment blocks, not runnable TF.
const FARGATE_SECRETS_HINT = `# Secrets Manager stub — populate before applying the task definition.
#
# The connector needs exactly ONE secret: the 32-byte libsodium master key that
# seals its config store. Mint it with a command; never paste key bytes into a
# ticket, a chat, or a terminal you do not control.
#
# aws secretsmanager create-secret \\
#   --name mcp-connector/{{NAME}}/connector-key-b64 \\
#   --secret-string "$(head -c 32 /dev/urandom | base64)"
#
# Then paste the returned ARN into task-definition.json under
# containerDefinitions[0].secrets[0].valueFrom (replacing REPLACE_WITH_SECRETS_MANAGER_ARN).
#
# The task EXECUTION role needs secretsmanager:GetSecretValue on that ARN — not
# the task role. Secret injection happens before the container starts, so it is
# the agent's credential that is used, not the application's.
#
# RETIRED: earlier versions of this file created four secrets here — a tunnel
# auth token, or an OAuth client id / secret / token URL. Those are entered in
# the inspector's Configure Tunnel modal and sealed into the state volume. If a
# runbook still tells you to create them, it predates ENV-TO-DB.
#
# Losing this key means losing the store: ConfigStore.open() compares a
# fingerprint and refuses to start against a store sealed with a different key.
# Keep it in a password manager and treat key + volume as one unit.
`;

const FARGATE_EFS_HINT = `# EFS stub — the state volume MUST be persistent.
#
# This is not a durability nicety. /var/lib/mcp-connector/state/config.json holds
# the sealed tunnel bearer and the registration token the controller issued. On a
# bare Fargate volume ("host": {}) that file is created fresh on every task
# start, so:
#   - the operator is asked to re-run Configure Tunnel after every restart, and
#   - the re-register collides on \`name_taken\` against the controller's
#     surviving row, which is STICKY: auto-reconnect is suppressed and a human
#     must click Reconnect. Unattended recovery is impossible.
#
# A task definition can reference an EFS filesystem but cannot create one:
#
# aws efs create-file-system \\
#   --encrypted \\
#   --performance-mode generalPurpose \\
#   --tags Key=Name,Value=mcp-connector-{{NAME}}-state
#
# # The access point pins the POSIX identity, which is what makes the mount
# # writable by the container's non-root user. The image runs as mcp:mcp
# # (uid/gid 1000); entrypoint.sh then creates and chowns state/ beneath it.
# aws efs create-access-point \\
#   --file-system-id <FS-ID> \\
#   --posix-user Uid=1000,Gid=1000 \\
#   --root-directory 'Path=/mcp-connector-{{NAME}},CreationInfo={OwnerUid=1000,OwnerGid=1000,Permissions=0755}'
#
# Paste both IDs into task-definition.json under volumes[0].efsVolumeConfiguration.
#
# Also required, and easy to miss:
#   - Mount targets in every subnet the task runs in.
#   - A security group on those mount targets allowing NFS (2049) from the
#     task's security group.
#   - elasticfilesystem:ClientMount + ClientWrite on the TASK role (iam: ENABLED
#     above makes the mount use it).
`;

// ---------- aca (Azure Container Apps) ----------

const ACA_CONTAINERAPP = `// Azure Container Apps — bicep. Deploy with:
//   az deployment group create --resource-group <rg> --template-file containerapp.bicep
//
// Prerequisites this file does NOT create (see the README appendix):
//   - the Container Apps managed environment (pass its id as environmentId)
//   - an Azure Files share + a storage mount registered on that environment,
//     named by storageName below. THE CONNECTOR'S IDENTITY LIVES ON IT.
//   - a Key Vault secret holding the base64 master key
//   - the system-assigned identity's Key Vault access

param location string = resourceGroup().location
param environmentId string
param imageRef string = '{{IMAGE}}'
param connectorName string = '{{NAME}}'
// Name of the storage mount already registered on the managed environment
// (az containerapp env storage set). Must be backed by Azure Files, not
// ephemeral storage: state/config.json holds the sealed tunnel bearer and the
// registration token, so losing it on a revision restart means re-running
// Configure Tunnel AND clearing a sticky name_taken row on the controller.
param stateStorageName string = 'mcp-connector-state'

resource app 'Microsoft.App/containerApps@2023-05-01' = {
  name: 'mcp-connector-\${connectorName}'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      // The connector needs exactly one secret: the 32-byte libsodium master
      // key that seals its config store, base64-encoded. The four that used to
      // be here — a tunnel auth token, or three OAUTH_* values — are entered in
      // the inspector's Configure Tunnel modal and sealed at rest.
      secrets: [
        { name: 'connector-key-b64', keyVaultUrl: 'REPLACE_WITH_KEYVAULT_SECRET_URL', identity: 'system' }
      ]
      ingress: null // outbound-only: the connector opens no inbound port
    }
    template: {
      containers: [
        {
          name: 'connector'
          image: imageRef
          env: [
            { name: 'CONNECTOR_CONFIG',   value: '/etc/mcp-connector/config.yaml' }
            // The one variable requireEnv() demands. The entrypoint decodes
            // CONNECTOR_KEY_B64 into this path at 0400 and unsets it before
            // dropping privileges, so nothing mounts a key file — and nothing
            // may mount over /etc/mcp-connector either, or the write fails.
            { name: 'CONNECTOR_KEY_FILE', value: '/etc/mcp-connector/connector.key' }
            { name: 'INSPECTOR_PORT',     value: '9090' }
            // Orchestrator probes on their own server, bound 0.0.0.0 with two
            // GET-only routes. The inspector cannot be probed — it binds
            // 127.0.0.1 and 403s every non-loopback caller.
            { name: 'HEALTH_PORT',        value: '9100' }
            { name: 'CONNECTOR_KEY_B64',  secretRef: 'connector-key-b64' }
          ]
          // Measured floor is 493 MB: the connector plus four bundled MCPs,
          // each Type 1 child being three processes (tsx wrapper node, real
          // node, resident esbuild). The previous 0.5Gi could not boot the
          // shipped image. ACA requires cpu:memory in fixed ratios — 0.5 vCPU
          // pairs with 1Gi, 1.0 with 2Gi.
          resources: { cpu: json('1.0'), memory: '2Gi' }
          // Liveness must NOT consult the tunnel: one controller outage would
          // otherwise make every replica in the fleet restart at once.
          // Readiness DOES, which is why a fresh deploy is deliberately not
          // ready until Configure Tunnel is completed — hence the long
          // failureThreshold, and hence liveness being separate so the app
          // survives long enough to be configured.
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/livez', port: 9100 }
              initialDelaySeconds: 15
              periodSeconds: 20
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/readyz', port: 9100 }
              initialDelaySeconds: 20
              periodSeconds: 10
              failureThreshold: 30
            }
          ]
          volumeMounts: [
            { volumeName: 'state', mountPath: '/var/lib/mcp-connector' }
          ]
        }
      ]
      volumes: [
        { name: 'state', storageType: 'AzureFile', storageName: stateStorageName }
      ]
      // Single connector — no HPA. Identity binds (tenant, name) at register
      // time, so a second replica collides on the controller's duplicate-name
      // guard. minReplicas must also stay >= 1: scale-to-zero kills the WSS.
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}
`;

// ---------- compose (single-VM prod shape) ----------

const COMPOSE_YML = `# Production docker-compose for a single-VM shape.
# Run with: docker compose up -d
#
# One container. The config store is a sealed JSON file on the state volume,
# so there is no database service and no DSN.
#
# Before boot:
#   mkdir -p secrets
#   head -c 32 /dev/urandom > ./secrets/connector.key && chmod 400 ./secrets/connector.key
#   printf 'mcp_servers: []\\n' > ./connector.yaml   # the bind-mount SOURCE must
#                                                   # exist as a FILE, or Docker
#                                                   # creates a DIRECTORY here

services:
  connector:
    image: {{IMAGE}}
    env_file:
      # Long form with required:false. The short form (env_file: .env) makes
      # "docker compose up" FAIL when the file is absent, and there is nothing
      # mandatory in it any more.
      - path: .env
        required: false
    environment:
      # The only required env var. Controller URL, connector name and auth
      # posture are entered in the inspector's Configure Tunnel modal and
      # sealed into the state volume — there are no env vars for them.
      CONNECTOR_KEY_FILE: /etc/mcp-connector/connector.key
      CONNECTOR_CONFIG: /etc/mcp-connector/config.yaml
      INSPECTOR_PORT: "9090"
    volumes:
      # Holds state/config.json — the sealed tunnel bearer and registration
      # token. This volume IS the connector's identity; destroy it and the
      # operator re-runs Configure Tunnel.
      - state:/var/lib/mcp-connector
      - ./connector.yaml:/etc/mcp-connector/config.yaml:ro
      - ./secrets/connector.key:/etc/mcp-connector/connector.key:ro
    # NO ports: mapping. The connector binds 127.0.0.1:9090 INSIDE the
    # container's namespace, so publishing the port forwards to an interface
    # nothing listens on and the host gets connection refused. Widening
    # INSPECTOR_BIND_ADDR does not help either: the request gate judges the
    # caller's source address, Docker's NAT rewrites it, and the dashboard
    # answers 403 "forbidden: loopback only". Both measured.
    #
    # Reach the dashboard with a forward that originates inside the box:
    #   docker compose exec connector wget -qO- http://127.0.0.1:9090/
    #   ssh -L 9090:127.0.0.1:9090 <vm-host>      # on a remote VM
    restart: unless-stopped

volumes:
  state:
`;

const COMPOSE_ENV = `# Copy to .env before \`docker compose up\`. Nothing here is required.
#
# There are no credentials to paste. The connector needs exactly one secret,
# the 32-byte master key, and it arrives as the read-only file mount at
# /etc/mcp-connector/connector.key declared in docker-compose.yml.
#
# TUNNEL_AUTH_TOKEN and the OAUTH_* trio used to live here. Both postures are
# now configured in the inspector's Configure Tunnel modal and sealed at rest;
# setting them here does nothing.

# Optional overrides:
# INSPECTOR_PORT=9090
# LOG_LEVEL=info
# HTTPS_PROXY=http://proxy.corp:3128   # honoured on the WSS dial
`;

// ---------- fly.io ----------
//
// Outbound-only, single-Machine, no [[services]]. Master key arrives as
// CONNECTOR_KEY_B64 secret (env-only secret store) and the runtime
// entrypoint decodes it to CONNECTOR_KEY_FILE. See
// CODE-DEPLOY design record for the design record.

const FLY_TOML = `# mcp-connector — Fly.io deployment
# Generated by \`mcp-connector deploy init --target fly\`.
#
# Load-bearing invariants (see CODE-DEPLOY design record):
#   - No [[services]] or [http_service] — connector is outbound-only.
#     NOTE: \`fly proxy\` does NOT reach the inspector DASHBOARD — it
#     arrives from the Machine's fdaa: mesh address and the request gate
#     requires a loopback caller (403 "forbidden: loopback only"). See
#     deploy/fly/README.md "Reach the inspector dashboard".
#   - \`fly ips list -a {{APP_NAME}}\` MUST be empty.
#   - Single Machine per CONNECTOR_NAME — do not \`fly scale count > 1\`.
#   - Do not set \`auto_stop_machines\` — would kill the outbound WSS.

app = "{{APP_NAME}}"
primary_region = "iad"

[build]
  # Two build shapes — pick ONE, comment the other:
  #   image = "{{IMAGE}}"                          # pull a published OCI image
  dockerfile = "connector/Dockerfile"    # build from source in this repo
  # As of 2026-07 the connector image is not published to a public registry —
  # source-build is the only working path. Flip to \`image =\` (and drop the
  # \`dockerfile\` line) once your registry publishes the image.

[env]
  CONNECTOR_KEY_FILE = "/etc/mcp-connector/connector.key"
  CONNECTOR_CONFIG = "/etc/mcp-connector/config.yaml"
  INSPECTOR_PORT = "9090"
  # Bind on all IPv6 interfaces so the machine API is reachable over Fly's
  # private mesh (the controller calls /oauth/token and the /v1/* routes at
  # <app>.internal:9090). Safe here because this app has no public IP —
  # \`fly ips list -a {{APP_NAME}}\` MUST be empty.
  #
  # This does NOT make the operator DASHBOARD reachable, and an earlier version
  # of this comment claimed it did. A wide bind gets the packet to the process;
  # the request gate then judges where it came from, and every route outside the
  # four allowlisted machine-API paths requires a LOOPBACK caller. \`fly proxy\`
  # arrives from the fdaa: mesh address, so the dashboard answers 403
  # {"error":"forbidden: loopback only"}. That was true from the moment the gate
  # landed; the claim was correct only before it existed.
  # See deploy/fly/README.md "Reach the inspector dashboard" for the relay
  # recipe that does work.
  INSPECTOR_BIND_ADDR = "::"
  # C4 (security hardening) — acknowledge non-loopback bind explicitly.
  # The connector refuses to start otherwise. Requires \`fly ips list -a {{APP_NAME}}\` empty.
  INSPECTOR_ALLOW_NONLOOPBACK = "1"
  # No MCP_DROPIN_DIR here on purpose. The bundled demo MCPs live at
  # /app/bundled-mcps and are discovered via MCP_BUNDLED_DIR (always-on),
  # so pointing the CUSTOMER drop-in scanner at an in-image tree is
  # redundant — and the old /app/mcp/local tree no longer exists, so setting
  # it silently disabled customer drop-in discovery and the "Refresh local
  # MCPs" rescan. Leaving it unset uses the default
  # (/var/lib/mcp-connector/customer-mcps/), which is inside the [[mounts]]
  # volume below — where customer-authored MCPs actually belong.
  # CONNECTOR_KEY_B64 is set by \`mcp-connector deploy apply --target fly\`.
  # It is the only secret; the entrypoint decodes it to CONNECTOR_KEY_FILE.

[[mounts]]
  source = "state"
  destination = "/var/lib/mcp-connector"

# Deliver the yaml config INTO the Machine at boot. Fly's [[files]] block
# is the only mechanism that writes a local file to the Machine's
# filesystem WITHOUT baking it into the image or mounting a persistent
# volume for it. The default local file lives at deploy/fly/connector.yaml
# relative to the repo root (where fly.toml sits — see CODE-DEPLOY.md §B1);
# create it before \`fly deploy\` with at least an empty \`mcp_servers: []\`
# and a \`policy:\` block.
[[files]]
  guest_path = "/etc/mcp-connector/config.yaml"
  local_path = "deploy/fly/connector.yaml"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "1gb"

[deploy]
  strategy = "immediate"
`;


// ---------- fly-mock (private demo backend) ----------
//
// The mock customer service — stand-in for an enterprise CRM API. Deployed
// as a separate Fly app in the same Fly org as the connector, reachable
// ONLY from the connector via Fly's private .internal DNS. See
// CODE-DEPLOY design record §D5.

const FLY_MOCK_TOML = `# mock-customers — Fly.io deployment (demo only)
# Generated by \`mcp-connector deploy init --target fly-mock\`.
#
# Simulates an enterprise CRM backend. Reachable ONLY from the connector
# app in the same Fly org, via Fly's \`.internal\` private DNS. Not reachable
# from the public internet.
#
# Load-bearing invariants (see CODE-DEPLOY design record §D5):
#   - No [[services]] or [http_service] — private-only by contract.
#   - \`fly ips list -a {{APP_NAME}}\` MUST be empty.
#   - Must live in the same Fly org as the connector app for the
#     connector's crm drop-in to resolve {{APP_NAME}}.internal.

app = "{{APP_NAME}}"
primary_region = "iad"

[build]
  # Built from examples/mock-backend/Dockerfile (see sibling file).
  dockerfile = "Dockerfile"

[env]
  PORT = "7400"
  NODE_ENV = "production"
  # MOCK_POSTGRES_URL via \`fly secrets set\` — REQUIRED, the service refuses
  # to boot without it. There are no DEMO_CUSTOMER_* vars; the store is a
  # real Postgres database, not in-memory fixtures.

# No [[services]] — private only. Reached at:
#   http://{{APP_NAME}}.internal:7400
# by the connector app's crm drop-in (MOCK_CUSTOMERS_URL).

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "256mb"

[deploy]
  strategy = "immediate"
`;

const FLY_MOCK_DOCKERFILE = `# Mock customer service — dev/demo only.
# Stands in for an enterprise CRM API behind the customer's firewall.
# Built by Fly at deploy time; not published as a public image.

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 7400
CMD ["npx", "tsx", "server.ts"]
`;

// ---------- template registry ----------

const TEMPLATES: Record<ScaffoldTarget, Template> = {
  fargate: {
    files: [
      { path: "task-definition.json", content: FARGATE_TASK_DEF },
      { path: "secrets-hint.sh",      content: FARGATE_SECRETS_HINT },
      { path: "efs-hint.sh",          content: FARGATE_EFS_HINT },
    ],
    readmeAppendix: `## AWS Fargate

**This target emits a task definition only.** It assumes you already have a VPC,
subnets, a security group, an ECS cluster, and the two IAM roles. If you have
none of those, use [\`deploy/terraform/aws-fargate/\`](../terraform/aws-fargate/)
instead — it provisions the lot.

Four placeholders have to be filled in before this runs. Each one is a hard
failure, not a warning:

| Placeholder | Filled from | Symptom if skipped |
|---|---|---|
| \`REPLACE_WITH_SECRETS_MANAGER_ARN\` | \`secrets-hint.sh\` | Task stops immediately: the agent cannot resolve the secret |
| \`REPLACE_WITH_EFS_FILESYSTEM_ID\` | \`efs-hint.sh\` | Task stops: volume cannot be mounted |
| \`REPLACE_WITH_EFS_ACCESS_POINT_ID\` | \`efs-hint.sh\` | Same |
| \`REPLACE_WITH_REGION\` | your region | Task stops: awslogs driver cannot resolve the log group |

Then:

    aws ecs register-task-definition --cli-input-json file://task-definition.json

**Two things that will bite you, in the order they bite.** Both produce failures
that read like a broken connector rather than a broken deployment:

1. **\`assign_public_ip\` must be \`ENABLED\`** on the service's network
   configuration (or give the subnet a NAT gateway). The connector is
   outbound-ONLY, which is not the same as needing no egress: with no route out
   the task cannot pull from ECR and dies with
   \`CannotPullContainerError\` before any connector code runs. It also could
   not reach Secrets Manager, EFS, or the controller.
2. **The state volume is the connector's identity.** \`state/config.json\` on it
   holds the sealed tunnel bearer and the registration token. That is why this
   template uses EFS rather than a bare \`"host": {}\` volume — see
   \`efs-hint.sh\` for why an ephemeral volume makes unattended restart
   impossible.

Reach the inspector with ECS Exec, which enters the task's namespace and so
presents as a genuine loopback caller:

    aws ecs execute-command --cluster <c> --task <t> --container connector \\
      --interactive --command "node dist/index.js doctor"

### Why the values in the task definition are what they are

The file carries no comments: \`aws ecs register-task-definition --cli-input-json\`
validates against the API shape and rejects unknown keys, so a \`"//note"\` field
fails the call. The reasoning therefore lives here.

- **\`cpu: 512\` / \`memory: 2048\`.** The measured floor is 493 MB for the
  connector plus the four bundled MCPs, because each Type 1 child is three
  processes (a \`tsx\` wrapper node, the real node, and a resident esbuild
  service). \`memory: 512\` cannot boot the shipped image at all, and the symptom
  is the fourth child dying at its readiness probe with no output — which reads
  as a broken MCP rather than an undersized task. \`MCP_READINESS_TIMEOUT_MS\`
  does not help: the memory is absent, not late. 256 CPU units is the cheapest
  valid pairing that clears the floor, but a quarter vCPU for five node
  processes is too thin.
- **No mount at \`/etc/mcp-connector\`.** The entrypoint decodes
  \`CONNECTOR_KEY_B64\` and *writes* the key there, so a read-only or shadowing
  mount at that path breaks boot. An earlier version of this template mounted an
  ephemeral \`config\` volume over it.
- **\`healthCheck\` probes \`/readyz\` on \`HEALTH_PORT\` (9100).** That endpoint
  exists precisely because the inspector cannot be probed: it binds 127.0.0.1
  and refuses every non-loopback caller, so a probe from outside the container
  answers \`403 forbidden: loopback only\`. The health server binds 0.0.0.0 and
  serves two GET-only routes disclosing a boolean and a reason string.
  \`/readyz\` is the right one here — it returns 503 until the tunnel is open, so
  ECS stops counting a connector healthy when it has no controller. It still runs
  as a CMD-SHELL exec because a Fargate task without a load balancer has no other
  probe mechanism, but it now checks something meaningful rather than "the HTTP
  server answers".

  **\`startPeriod\` is 90s, not 30.** \`/readyz\` stays 503 until Configure Tunnel
  has been completed, which on a first deploy is a human step. A short grace
  period kills the task before the operator reaches the modal. If that is still
  too tight, probe \`/livez\` instead — 200 as soon as the process is up, and it
  never consults the tunnel.
- **\`secrets[]\` is read by the EXECUTION role, not the task role.** Injection
  happens before the container starts, so it is the agent's credential that
  fetches the value.

See deploy/terraform/README.md for the full walkthrough (ECS Exec setup,
orchestrator-vs-built-in reconnect, etc.).
`,
  },

  aca: {
    files: [
      { path: "containerapp.bicep", content: ACA_CONTAINERAPP },
    ],
    readmeAppendix: `## Azure Container Apps

Three things must exist before the bicep applies. The template creates none of
them, and each omission fails the deployment rather than degrading it.

**1. A Container Apps managed environment.** One per subscription is typical.

    az containerapp env create --name <env> --resource-group <rg> --location <loc>

**2. An Azure Files share, registered as a storage mount on that environment.**
This is not optional. \`state/config.json\` on it holds the sealed tunnel bearer
and the registration token the controller issued; on ephemeral storage the
connector loses its identity on every revision restart, asks for Configure
Tunnel again, and the re-register collides on \`name_taken\` — which is sticky,
so auto-reconnect is suppressed and a human must click Reconnect. Unattended
restart is impossible without this.

    az storage share-rm create --storage-account <sa> --name mcp-connector-state --quota 1
    az containerapp env storage set --name <env> --resource-group <rg> \\
      --storage-name mcp-connector-state --azure-file-account-name <sa> \\
      --azure-file-account-key <key> --azure-file-share-name mcp-connector-state \\
      --access-mode ReadWrite

**3. A Key Vault secret holding the base64 master key**, readable by the app's
system-assigned identity. Mint it with a command — never paste key bytes into a
ticket or a chat:

    az keyvault secret set --vault-name <kv> --name connector-key-b64 \\
      --value "$(head -c 32 /dev/urandom | base64)"

Then paste the secret's URL over \`REPLACE_WITH_KEYVAULT_SECRET_URL\` and grant
the identity access (\`az keyvault set-policy --secret-permissions get\`, or an
RBAC role assignment). The identity does not exist until the first deployment,
so this is a two-pass operation: deploy, read \`identity.principalId\` off the
app, grant, then redeploy.

Finally:

    az deployment group create \\
      --resource-group <rg> \\
      --template-file containerapp.bicep \\
      --parameters environmentId=<managed-env-id>

**Reach the inspector** with \`az containerapp exec\`, which enters the
container and so presents as a genuine loopback caller — every dashboard route
refuses anything else:

    az containerapp exec --name mcp-connector-{{NAME}} --resource-group <rg> \\
      --command "node dist/index.js doctor"

**Do not add an ingress.** \`ingress: null\` is load-bearing: the connector opens
no inbound port, and exposing 9090 would publish the Webhooks panel's
bcrypt-protected URLs. Likewise leave \`minReplicas: 1\` — scale-to-zero kills
the outbound WSS, and \`maxReplicas: 1\` is the duplicate-name guard.
`,
  },

  compose: {
    files: [
      { path: "docker-compose.yml",   content: COMPOSE_YML },
      { path: ".env.example",         content: COMPOSE_ENV },
    ],
    readmeAppendix: `## docker compose (single VM)

Four commands to a running connector — nothing to edit in between:

    mkdir -p secrets
    head -c 32 /dev/urandom > ./secrets/connector.key && chmod 400 ./secrets/connector.key
    printf 'mcp_servers: []\\n' > ./connector.yaml
    docker compose up -d

The \`.env\` copy is optional — \`.env.example\` holds only comments now. The
\`connector.yaml\` line is NOT optional: a bind-mount whose source is missing
makes Docker create a DIRECTORY at that path, and config load then fails.

Verify:

    docker compose exec connector node dist/index.js doctor

\`node dist/index.js\`, not \`mcp-connector\` — the image's WORKDIR is
/app/connector and the workspace bin link at /app/node_modules/.bin is not on
PATH, so the bare name fails with "not found".

**The dashboard is NOT at http://localhost:9090/ when the connector runs in a
container.** It binds loopback inside the container's namespace, so nothing on
the host can reach it and no port mapping changes that. Smoke-test it with

    docker compose exec connector wget -qO- http://127.0.0.1:9090/

and reach it properly through a forward that originates inside the box — on a
remote VM, \`ssh -L 9090:127.0.0.1:9090 <vm-host>\`, where the remote sshd dials
localhost itself. Then fill in Configure Tunnel; that modal is the only way to
set tunnel identity.
`,
  },

  fly: {
    files: [
      { path: "fly.toml", content: FLY_TOML },
    ],
    readmeAppendix: `## Fly.io

\`fly.toml\` landed AT REPO ROOT (Fly's build context is locked to the
fly.toml's directory, and the Dockerfile needs repo root — see
deploy/fly/README.md for the reasoning).

**Deploy:**

    mcp-connector deploy apply --target fly

That's it. Four idempotent steps: creates the Fly app, mints and sets the
master key, creates the state volume, runs \`fly deploy\`. Safe to re-run if a
mid-step failure interrupts the flow.

It used to be five — \`fly postgres create\` + \`attach\` are gone, so no
separate billable \`{{APP_NAME}}-db\` app is created and nothing here is
non-idempotent any more.

Reach the inspector: \`./scripts/fly-inspector.sh {{APP_NAME}}\` — prints a URL,
tears down on Ctrl-C. (\`fly proxy\` alone gets a 403: it arrives from the mesh
IP and the dashboard requires a loopback caller. API clients don't help either —
those open the machine API, not the UI.)

**The state volume is the connector's identity.** \`state/config.json\` on it
holds the sealed tunnel bearer and the registration token. Destroying the
volume means re-running Configure Tunnel, and the re-register collides on
\`name_taken\` until the stale controller row is cleared.

See deploy/fly/README.md for the full walkthrough (mock backend, private
DNS, key rotation).
`,
  },

  "fly-mock": {
    files: [
      { path: "fly.toml",   content: FLY_MOCK_TOML },
      { path: "Dockerfile", content: FLY_MOCK_DOCKERFILE },
    ],
    readmeAppendix: `## Fly.io — mock backend (demo only)

Deploy the mock as a private Fly app in the same Fly org as the connector.
The connector's crm drop-in reaches it at \`{{APP_NAME}}.internal:7400\`
via Fly's WireGuard mesh — never publicly.

    fly apps create {{APP_NAME}}

\`MOCK_POSTGRES_URL\` is REQUIRED — the mock refuses to boot without it, and
this app now has to bring its OWN database. Earlier versions pointed it at the
Postgres app \`deploy apply --target fly\` created for the connector; the
connector stores its config in a sealed file on its volume and no longer has
one, so there is nothing to borrow.

    fly postgres create --name {{APP_NAME}}-db --region <region> \\
      --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 1
    fly postgres attach {{APP_NAME}}-db --app {{APP_NAME}} \\
      --database-name crm --variable-name MOCK_POSTGRES_URL --yes

Or, if you already have a Postgres reachable on the mesh, set the secret
directly:

    fly secrets set \\
      MOCK_POSTGRES_URL="postgres://postgres:<pw>@<pg-app>.flycast:5432/crm" \\
      --app {{APP_NAME}}
    fly deploy --app {{APP_NAME}}

Verify:
    fly ssh console -a {{APP_NAME}} -C "wget -qO- http://localhost:7400/healthz"

The database is EMPTY after deploy — no seeded customers, orders, or
appointments. Insert what the demo needs via \`POST /customers\` from inside
the mesh (the app has no public IP):

    fly ssh console -a {{APP_NAME}} -C "wget -qO- \\
      --header='Content-Type: application/json' \\
      --post-data='{\\"name\\":\\"Dana\\",\\"surname\\":\\"Demo\\",\\"phone\\":\\"+15551239999\\"}' \\
      http://localhost:7400/customers"

\`interactions[]\` on that body is the orders list and can only be supplied at
create time — \`customers.phone\` is UNIQUE, so adding orders to an existing
customer means a direct insert into the \`interactions\` table.

In the connector's \`customer-mcps/crm/.env\`, before building the connector image:

    MOCK_CUSTOMERS_URL=http://{{APP_NAME}}.internal:7400
`,
  },
};
