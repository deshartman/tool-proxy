// Deploy scaffold templates. One entry per target, each a map of
// relativePath → template string. Substitution is `String.replaceAll` on
// `{{NAME}}`, `{{CONTROLLER_URL}}`, `{{IMAGE}}`, etc. — plain, no engine.
//
// Adding a new target: append a key to TEMPLATES with the file map;
// add the target to the TARGETS union in scaffold.ts.
//
// These are LITERAL cloud manifests, not exhaustive infrastructure — they
// cover the connector container, its config mount, its state volume, and
// its secrets. Everything else (cluster, network, DNS) the customer
// supplies. See docs/deploy/*.md for the reasoning.

export type ScaffoldTarget = "fargate" | "gke" | "aca" | "compose" | "fly" | "fly-mock";

// Some targets don't need a controller URL (the mock backend doesn't dial
// anywhere — it's just an HTTP server). The CLI skips the prompt for these.
export function targetNeedsControllerUrl(target: ScaffoldTarget): boolean {
  return target !== "fly-mock";
}

export interface ScaffoldVars {
  name: string;
  // Fly-only: the Fly.io app name for the connector Machine + its attached
  // Postgres (`{{APP_NAME}}-db`). Defaults are computed by scaffold.ts based
  // on target — `mcp-connector-<name>` for fly, `mock-customers-<name>` for
  // fly-mock. Non-Fly targets ignore this field (their prefixes are baked
  // into the template — ECS task family, K8s namespace, etc.).
  appName: string;
  controllerUrl: string;
  image: string;
  credsSource: "db" | "env";
  auth: "static" | "oauth2";
}

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
    .replaceAll("{{CONTROLLER_URL}}", vars.controllerUrl)
    .replaceAll("{{IMAGE}}", vars.image)
    .replaceAll("{{CREDS_SOURCE}}", vars.credsSource)
    .replaceAll("{{AUTH}}", vars.auth);
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
  "cpu": "256",
  "memory": "512",
  "containerDefinitions": [
    {
      "name": "connector",
      "image": "{{IMAGE}}",
      "essential": true,
      "environment": [
        { "name": "CONNECTOR_CREDS_SOURCE", "value": "{{CREDS_SOURCE}}" },
        { "name": "CONNECTOR_CONFIG",       "value": "/etc/mcp-connector/config.yaml" },
        { "name": "CONNECTOR_NAME",         "value": "{{NAME}}" },
        { "name": "CONTROLLER_URL",         "value": "{{CONTROLLER_URL}}" },
        { "name": "INSPECTOR_PORT",         "value": "9090" },
        { "name": "CONNECTOR_STATE_PATH",   "value": "/var/lib/mcp-connector/.connector-state.json" }
      ],
      "secrets": [
        { "name": "TUNNEL_AUTH_TOKEN", "valueFrom": "REPLACE_WITH_SECRETS_MANAGER_ARN" }
      ],
      "mountPoints": [
        { "containerPath": "/etc/mcp-connector",  "sourceVolume": "config" },
        { "containerPath": "/var/lib/mcp-connector", "sourceVolume": "state" }
      ],
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
    { "name": "config", "host": {} },
    { "name": "state",  "host": {} }
  ]
}
`;

// Companion: Secrets Manager stub. Not applied — customer decides how
// they populate the ARN. Emitted as a comment block, not runnable TF.
const FARGATE_SECRETS_HINT = `# Secrets Manager stubs — populate before applying the task definition.
#
# aws secretsmanager create-secret \\
#   --name mcp-connector/{{NAME}}/tunnel-auth-token \\
#   --secret-string "ts_<...>"
#
# Then paste the returned ARN into task-definition.json under
# containerDefinitions[0].secrets[0].valueFrom (replacing REPLACE_WITH_SECRETS_MANAGER_ARN).
#
# Similar for OAuth2 posture — three secrets:
#   mcp-connector/{{NAME}}/oauth-client-id
#   mcp-connector/{{NAME}}/oauth-client-secret
#   mcp-connector/{{NAME}}/oauth-token-url
`;

// ---------- gke ----------

const GKE_NAMESPACE = `apiVersion: v1
kind: Namespace
metadata:
  name: mcp-connector-{{NAME}}
`;

const GKE_SECRET = `apiVersion: v1
kind: Secret
metadata:
  name: mcp-connector-token
  namespace: mcp-connector-{{NAME}}
type: Opaque
stringData:
  # Sync from Secret Manager via the CSI driver in production.
  TUNNEL_AUTH_TOKEN: REPLACE_ME
  # For OAuth2 posture, replace the line above with:
  # OAUTH_CLIENT_ID: REPLACE_ME
  # OAUTH_CLIENT_SECRET: REPLACE_ME
`;

const GKE_CONFIGMAP = `apiVersion: v1
kind: ConfigMap
metadata:
  name: mcp-connector-config
  namespace: mcp-connector-{{NAME}}
data:
  config.yaml: |
    tunnel:
      controller_url: \${CONTROLLER_URL:-}
      name: \${CONNECTOR_NAME:-}
      environment: prod
      auth_token: \${TUNNEL_AUTH_TOKEN:-}
    mcp_servers:
      - name: placeholder
        transport: http
        endpoint: http://placeholder.mcp-connector-{{NAME}}.svc.cluster.local:7100/mcp
    policy:
      tool_timeout_ms: 5000
`;

const GKE_DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-connector
  namespace: mcp-connector-{{NAME}}
spec:
  replicas: 1
  selector: { matchLabels: { app: mcp-connector } }
  template:
    metadata: { labels: { app: mcp-connector } }
    spec:
      containers:
        - name: connector
          image: {{IMAGE}}
          envFrom:
            - secretRef: { name: mcp-connector-token }
          env:
            - { name: CONNECTOR_CREDS_SOURCE, value: "{{CREDS_SOURCE}}" }
            - { name: CONTROLLER_URL,         value: "{{CONTROLLER_URL}}" }
            - { name: CONNECTOR_NAME,         value: "{{NAME}}" }
            - { name: CONNECTOR_CONFIG,       value: "/etc/mcp-connector/config.yaml" }
            - { name: CONNECTOR_STATE_PATH,   value: "/var/lib/mcp-connector/.connector-state.json" }
            - { name: INSPECTOR_PORT,         value: "9090" }
          volumeMounts:
            - { name: config, mountPath: /etc/mcp-connector,  readOnly: true }
            - { name: state,  mountPath: /var/lib/mcp-connector }
      volumes:
        - name: config
          configMap: { name: mcp-connector-config }
        - name: state
          persistentVolumeClaim: { claimName: mcp-connector-state }
`;

const GKE_PVC = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mcp-connector-state
  namespace: mcp-connector-{{NAME}}
spec:
  accessModes: ["ReadWriteOnce"]
  resources: { requests: { storage: 64Mi } }
`;

// ---------- aca (Azure Container Apps) ----------

const ACA_CONTAINERAPP = `// Azure Container Apps — bicep. Deploy with:
//   az deployment group create --resource-group <rg> --template-file containerapp.bicep
// (After the accompanying secrets.bicep has created the referenced secrets.)

param location string = resourceGroup().location
param environmentId string
param imageRef string = '{{IMAGE}}'
param connectorName string = '{{NAME}}'
param controllerUrl string = '{{CONTROLLER_URL}}'

resource app 'Microsoft.App/containerApps@2023-05-01' = {
  name: 'mcp-connector-\${connectorName}'
  location: location
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      secrets: [
        { name: 'tunnel-auth-token', keyVaultUrl: 'REPLACE_WITH_KEYVAULT_URL', identity: 'system' }
      ]
      ingress: null // outbound-only, no public ingress for the tunnel
    }
    template: {
      containers: [
        {
          name: 'connector'
          image: imageRef
          env: [
            { name: 'CONNECTOR_CREDS_SOURCE', value: '{{CREDS_SOURCE}}' }
            { name: 'CONNECTOR_CONFIG',       value: '/etc/mcp-connector/config.yaml' }
            { name: 'CONNECTOR_NAME',         value: connectorName }
            { name: 'CONTROLLER_URL',         value: controllerUrl }
            { name: 'INSPECTOR_PORT',         value: '9090' }
            { name: 'CONNECTOR_STATE_PATH',   value: '/var/lib/mcp-connector/.connector-state.json' }
            { name: 'TUNNEL_AUTH_TOKEN',      secretRef: 'tunnel-auth-token' }
          ]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 } // single connector — no HPA
    }
  }
}
`;

// ---------- compose (single-VM prod shape) ----------

const COMPOSE_YML = `# Production docker-compose for a single-VM shape.
# Run with: docker compose up -d
# Before boot: place a 32-byte key at ./secrets/connector.key
#   head -c 32 /dev/urandom > ./secrets/connector.key && chmod 400 ./secrets/connector.key

services:
  connector:
    image: {{IMAGE}}
    env_file: .env
    environment:
      CONNECTOR_NAME: {{NAME}}
      CONTROLLER_URL: {{CONTROLLER_URL}}
      CONNECTOR_CREDS_SOURCE: {{CREDS_SOURCE}}
    volumes:
      - state:/var/lib/mcp-connector
      - ./connector.yaml:/etc/mcp-connector/config.yaml:ro
      - ./secrets/connector.key:/etc/mcp-connector/connector.key:ro
    ports:
      # Inspector — 127.0.0.1 only. Do NOT bind to 0.0.0.0.
      - "127.0.0.1:9090:9090"
    restart: unless-stopped
    depends_on: [postgres]

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: mcp_connector
      POSTGRES_USER: mcp
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
    volumes:
      - pg_data:/var/lib/postgresql/data
    secrets: [pg_password]
    restart: unless-stopped

secrets:
  pg_password:
    file: ./secrets/pg_password

volumes:
  state:
  pg_data:
`;

const COMPOSE_ENV = `# Copy to .env before \`docker compose up\`.
# One posture: static bearer (TUNNEL_AUTH_TOKEN) OR OAuth2 (OAUTH_*).

# Static-bearer posture — controller-minted \`ts_...\` from the Tunnel Security row.
TUNNEL_AUTH_TOKEN=

# db mode requires these two:
POSTGRES_URL=postgres://mcp:$(cat ./secrets/pg_password)@postgres:5432/mcp_connector
CONNECTOR_KEY_FILE=/etc/mcp-connector/connector.key

# Optional overrides:
# INSPECTOR_PORT=9090
# LOG_LEVEL=info
`;

// ---------- fly.io ----------
//
// Outbound-only, single-Machine, no [[services]]. Master key arrives as
// CONNECTOR_KEY_B64 secret (env-only secret store) and the runtime
// entrypoint decodes it to CONNECTOR_KEY_FILE. See
// architectural-plans/CODE-DEPLOY.md for the design record.

const FLY_TOML = `# mcp-connector — Fly.io deployment
# Generated by \`mcp-connector deploy init --target fly\`.
#
# Load-bearing invariants (see architectural-plans/CODE-DEPLOY.md):
#   - No [[services]] or [http_service] — connector is outbound-only.
#     Reach inspector with \`fly proxy 9090:9090 -a {{APP_NAME}}\`.
#   - \`fly ips list -a {{APP_NAME}}\` MUST be empty.
#   - Single Machine per CONNECTOR_NAME — do not \`fly scale count > 1\`.
#   - Do not set \`auto_stop_machines\` — would kill the outbound WSS.

app = "{{APP_NAME}}"
primary_region = "iad"

[build]
  # Two build shapes — pick ONE, comment the other:
  #   image = "{{IMAGE}}"                          # pull a published OCI image
  dockerfile = "packages/connector/Dockerfile"    # build from source in this repo
  # As of 2026-07 the connector image is not published to a public registry —
  # source-build is the only working path. Flip to \`image =\` (and drop the
  # \`dockerfile\` line) once your registry publishes the image.

[env]
  CONNECTOR_CREDS_SOURCE = "{{CREDS_SOURCE}}"
  CONNECTOR_KEY_FILE = "/etc/mcp-connector/connector.key"
  CONNECTOR_CONFIG = "/etc/mcp-connector/config.yaml"
  CONNECTOR_STATE_PATH = "/var/lib/mcp-connector/.connector-state.json"
  INSPECTOR_PORT = "9090"
  # Bind on all IPv6 interfaces so \`fly proxy\` can reach the inspector via
  # Fly's private mesh. Loopback-only (default 127.0.0.1) isn't reachable
  # from \`fly proxy\` because it tunnels to the Machine's fdaa: mesh IP,
  # not to 127.0.0.1. Safe here because this app has no public IP allocated —
  # \`fly ips list -a {{APP_NAME}}\` MUST be empty.
  # See architectural-plans/CODE-DEPLOY.md §B4.
  INSPECTOR_BIND_ADDR = "::"
  # Demo convenience — points the drop-in scanner at the mcp/local/ tree
  # baked into the image by the Dockerfile's \`COPY mcp mcp\`. DELETE this
  # line for a real customer deployment; the default
  # (/var/lib/mcp-connector/customer-mcps/) expects customer-authored MCPs
  # to be mounted as a Fly volume at that path instead.
  MCP_DROPIN_DIR = "/app/mcp/local"
  # POSTGRES_URL, CONNECTOR_KEY_B64 come from \`fly secrets set\` — see fly-secrets-hint.sh.

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
  memory = "512mb"

[deploy]
  strategy = "immediate"
`;

const FLY_SECRETS_HINT = `# Fly secrets & Postgres — populate before \`fly deploy\`.
# Run these from the SAME directory as fly.toml (which is the repo root —
# see architectural-plans/CODE-DEPLOY.md §B1 for why).
#
# BEFORE step 1: create the yaml delivered by fly.toml's [[files]] block.
# Even for an all-Type-2 setup, the connector needs a file at
# CONNECTOR_CONFIG or boot fails.
#      mkdir -p deploy/fly
#      cat > deploy/fly/connector.yaml <<'EOF'
#      mcp_servers: []
#      policy:
#        fail_mode: fail_fast
#      EOF
#
# 1. Create the Fly app (no deploy yet):
#      fly apps create {{APP_NAME}}
#
# 2. Provision Fly Postgres and attach.
#    CRITICAL: \`--variable-name POSTGRES_URL\` is required. Fly's default
#    is DATABASE_URL, which the connector doesn't recognize — boot fails
#    with "POSTGRES_URL is required" even though Postgres is attached.
#
#      fly postgres create --name {{APP_NAME}}-db --region iad \\
#        --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 1
#      fly postgres attach {{APP_NAME}}-db \\
#        --app {{APP_NAME}} \\
#        --database-name mcp_connector \\
#        --variable-name POSTGRES_URL
#
# 3. Mint the 32-byte master key and set as CONNECTOR_KEY_B64:
#      KEY_B64=\$(head -c 32 /dev/urandom | base64)
#      fly secrets set CONNECTOR_KEY_B64="\$KEY_B64" --app {{APP_NAME}}
#
# 4. Create the state volume (1 GB is plenty):
#      fly volumes create state --region iad --size 1 --app {{APP_NAME}} --yes
#
# 5. Deploy — redirect to file so you can tail progress. \`fly deploy 2>&1 | tail\`
#    silently buffers because Fly's Depot builder only flushes on TTY:
#      nohup fly deploy > /tmp/fly-deploy.log 2>&1 &
#      tail -f /tmp/fly-deploy.log
#
# 6. Configure the tunnel via the inspector:
#      fly proxy 9090:9090 -a {{APP_NAME}}
#      # Then open http://localhost:9090/ and fill in:
#      #   Controller URL: {{CONTROLLER_URL}}
#      #   Connector Name: {{NAME}}   (must match the Tunnel Security row Name)
#      #   Auth posture:   {{AUTH}}
#
# For a one-command deploy of steps 1-5, use the emitted fly-deploy.sh
# alongside this file:
#      bash fly-deploy.sh
`;

// Companion runnable script — one-command deploy. Idempotent so it survives
// interruption. See docs/deploy/fly-io.md for the design record.
//
// Deliberate design: static substitution (app name baked at scaffold time),
// not runtime parsing of fly.toml. Rationale: the script lives right next to
// the fly.toml that produced it — re-scaffold with --force to change either.
// A rename with only \`fly-deploy.sh\` edited would silently target the wrong
// Postgres app; forcing them to move together prevents that drift.
const FLY_DEPLOY_SH = `#!/usr/bin/env bash
# Runnable deploy for {{APP_NAME}} on Fly.io.
# Generated by \`mcp-connector deploy init --target fly\`.
#
# Idempotent: safe to re-run — each step checks state before acting.
#
#   1. Creates the Fly app (skip if exists)
#   2. Creates the Postgres app + attaches with POSTGRES_URL
#      (NOT the default DATABASE_URL — the connector's env reader looks for
#      POSTGRES_URL only; see architectural-plans/CODE-DEPLOY.md §B3)
#   3. Mints + sets CONNECTOR_KEY_B64 (skip if already set)
#   4. Creates the state volume (skip if \`state\` already exists)
#   5. Runs \`fly deploy\` in the foreground

set -euo pipefail

APP="{{APP_NAME}}"
DB_APP="{{APP_NAME}}-db"
REGION="iad"

# ---------- Preflight ----------

if [ ! -f "fly.toml" ]; then
  echo "error: fly.toml not found in \$(pwd)" >&2
  echo "cd to the directory containing fly.toml (repo root) before running." >&2
  exit 1
fi

if [ ! -f "deploy/fly/connector.yaml" ]; then
  echo "==> Creating empty deploy/fly/connector.yaml (needed by [[files]] block)"
  mkdir -p deploy/fly
  cat > deploy/fly/connector.yaml <<'EOF'
mcp_servers: []
policy:
  fail_mode: fail_fast
EOF
fi

echo "==> Deploying \$APP to region \$REGION (postgres: \$DB_APP)"
echo

# ---------- 1. Fly app ----------

if fly apps list --json 2>/dev/null | grep -q "\\"Name\\":\\"\$APP\\""; then
  echo "==> [1/5] App \$APP already exists — skipping create."
else
  echo "==> [1/5] Creating app \$APP"
  fly apps create "\$APP"
fi
echo

# ---------- 2. Postgres ----------

if fly apps list --json 2>/dev/null | grep -q "\\"Name\\":\\"\$DB_APP\\""; then
  echo "==> [2/5] Postgres app \$DB_APP already exists — skipping create."
else
  echo "==> [2/5] Creating Postgres app \$DB_APP"
  fly postgres create --name "\$DB_APP" --region "\$REGION" \\
    --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 1
fi

# \`fly postgres attach\` is NOT idempotent — a re-run when already attached
# emits "already exists" and exits non-zero. Guard so re-run continues.
echo "    Attaching \$DB_APP as POSTGRES_URL on \$APP"
fly postgres attach "\$DB_APP" \\
  --app "\$APP" \\
  --database-name mcp_connector \\
  --variable-name POSTGRES_URL \\
  --yes 2>&1 | grep -v "already exists\\|Warning:" || true
echo

# ---------- 3. Master key ----------

if fly secrets list --app "\$APP" 2>/dev/null | grep -q "^CONNECTOR_KEY_B64"; then
  echo "==> [3/5] CONNECTOR_KEY_B64 already set — skipping mint."
else
  echo "==> [3/5] Minting 32-byte master key + setting CONNECTOR_KEY_B64"
  fly secrets set CONNECTOR_KEY_B64="\$(head -c 32 /dev/urandom | base64)" --app "\$APP"
fi
echo

# ---------- 4. State volume ----------

if fly volumes list --app "\$APP" --json 2>/dev/null | grep -q "\\"Name\\":\\"state\\""; then
  echo "==> [4/5] State volume already exists on \$APP — skipping create."
else
  echo "==> [4/5] Creating 1 GB state volume on \$APP in \$REGION"
  fly volumes create state --size 1 --region "\$REGION" --app "\$APP" --yes
fi
echo

# ---------- 5. Deploy ----------

echo "==> [5/5] Deploying \$APP (foreground; watch for 'Machines are healthy')"
fly deploy
echo

echo "==> Done."
echo
echo "Next steps:"
echo "  fly ips list -a \$APP           # MUST return empty (outbound-only)"
echo "  fly proxy 9090:9090 -a \$APP    # then open http://localhost:9090"
echo "  fly logs -a \$APP | grep -E 'tunnel opened|register-ack'"
`;

// ---------- fly-mock (private demo backend) ----------
//
// The mock customer service — stand-in for an enterprise CRM API. Deployed
// as a separate Fly app in the same Fly org as the connector, reachable
// ONLY from the connector via Fly's private .internal DNS. See
// architectural-plans/CODE-DEPLOY.md §D5.

const FLY_MOCK_TOML = `# mock-customers — Fly.io deployment (demo only)
# Generated by \`mcp-connector deploy init --target fly-mock\`.
#
# Simulates an enterprise CRM backend. Reachable ONLY from the connector
# app in the same Fly org, via Fly's \`.internal\` private DNS. Not reachable
# from the public internet.
#
# Load-bearing invariants (see architectural-plans/CODE-DEPLOY.md §D5):
#   - No [[services]] or [http_service] — private-only by contract.
#   - \`fly ips list -a {{APP_NAME}}\` MUST be empty.
#   - Must live in the same Fly org as the connector app for the
#     connector's crm drop-in to resolve {{APP_NAME}}.internal.

app = "{{APP_NAME}}"
primary_region = "iad"

[build]
  # Built from mock/customers/Dockerfile (see sibling file).
  dockerfile = "Dockerfile"

[env]
  PORT = "7400"
  NODE_ENV = "production"
  # DEMO_CUSTOMER_NAME / _SURNAME / _PHONE via \`fly secrets set\`.

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
    ],
    readmeAppendix: `## AWS Fargate

Register the task definition:

    aws ecs register-task-definition --cli-input-json file://task-definition.json

Before running, populate Secrets Manager per \`secrets-hint.sh\` and replace
\`REPLACE_WITH_SECRETS_MANAGER_ARN\` in the task-definition.json. Same for
\`REPLACE_WITH_REGION\` in the awslogs config.

See docs/deploy/aws-fargate.md for the full walkthrough (ECS Exec for
inspector access, orchestrator-vs-built-in reconnect, etc.).
`,
  },

  gke: {
    files: [
      { path: "namespace.yaml",   content: GKE_NAMESPACE },
      { path: "secret.yaml",      content: GKE_SECRET },
      { path: "configmap.yaml",   content: GKE_CONFIGMAP },
      { path: "deployment.yaml",  content: GKE_DEPLOYMENT },
      { path: "pvc.yaml",         content: GKE_PVC },
    ],
    readmeAppendix: `## GCP GKE

Apply in order:

    kubectl apply -f namespace.yaml
    kubectl apply -f secret.yaml       # after replacing REPLACE_ME
    kubectl apply -f configmap.yaml
    kubectl apply -f pvc.yaml
    kubectl apply -f deployment.yaml

Reach the inspector: \`kubectl port-forward -n mcp-connector-{{NAME}} deploy/mcp-connector 9090:9090\`

See docs/deploy/gcp-gke.md for the reasoning behind each choice.
`,
  },

  aca: {
    files: [
      { path: "containerapp.bicep", content: ACA_CONTAINERAPP },
    ],
    readmeAppendix: `## Azure Container Apps

Create the Container Apps environment separately (one per subscription is
typical), then:

    az deployment group create \\
      --resource-group <rg> \\
      --template-file containerapp.bicep \\
      --parameters environmentId=<managed-env-id>

Before deployment, populate a Key Vault with the tunnel bearer and replace
\`REPLACE_WITH_KEYVAULT_URL\` in containerapp.bicep. See
docs/deploy/azure-container-apps.md for the full walkthrough.
`,
  },

  compose: {
    files: [
      { path: "docker-compose.yml",   content: COMPOSE_YML },
      { path: ".env.example",         content: COMPOSE_ENV },
    ],
    readmeAppendix: `## docker compose (single VM)

Three commands to a running connector:

    head -c 32 /dev/urandom > ./secrets/connector.key && chmod 400 ./secrets/connector.key
    cp .env.example .env  # then edit TUNNEL_AUTH_TOKEN
    docker compose up -d

Verify: \`docker compose exec connector mcp-connector doctor\`
`,
  },

  fly: {
    files: [
      { path: "fly.toml",             content: FLY_TOML },
      { path: "fly-deploy.sh",        content: FLY_DEPLOY_SH },
      { path: "fly-secrets-hint.sh",  content: FLY_SECRETS_HINT },
    ],
    readmeAppendix: `## Fly.io

Files landed AT REPO ROOT (Fly's build context is locked to the fly.toml's
directory, and the Dockerfile needs repo root — see docs/deploy/fly-io.md).

**Deploy with the CLI:**

    mcp-connector deploy apply --target fly

That's it. The verb wraps the emitted \`fly-deploy.sh\`, so you get the same
idempotent 5-step flow (create app + Postgres, set master key, create volume,
then \`fly deploy\`) with one command. Safe to re-run.

**Alternative escape hatches:**
- \`bash fly-deploy.sh\` — same effect as \`deploy apply\`, useful if you
  want to \`cat\` the script and audit it before running (a common posture
  for security review) or in a Node-less CI environment.
- \`fly-secrets-hint.sh\` — paste-friendly hint doc walking through each
  step individually. Every line is a comment; run block-by-block manually.

Reach the inspector: \`fly proxy 9090:9090 -a {{APP_NAME}}\` → http://localhost:9090/

Once verified, you can \`rm fly-secrets-hint.sh fly-deploy.sh\` if you prefer
the CLI verb as your single entry point. \`fly.toml\` stays either way.

See docs/deploy/fly-io.md for the full walkthrough (mock backend, private
DNS, rotation, graduation to managed Postgres).
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
    fly secrets set DEMO_CUSTOMER_NAME=Alice DEMO_CUSTOMER_SURNAME=Demo \\
                    DEMO_CUSTOMER_PHONE=+14155551234 \\
                    --app {{APP_NAME}}
    fly deploy --app {{APP_NAME}}

Verify:
    fly ssh console -a {{APP_NAME}} -C "wget -qO- http://localhost:7400/healthz"

In the connector's \`mcp/local/crm/.env\`, before building the connector image:

    MOCK_CUSTOMERS_URL=http://{{APP_NAME}}.internal:7400
`,
  },
};
