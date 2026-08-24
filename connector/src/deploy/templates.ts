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
// supplies. See deploy/**/*.md for the reasoning.

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
        { "name": "CONNECTOR_CONFIG",       "value": "/etc/mcp-connector/config.yaml" },
        { "name": "CONNECTOR_NAME",         "value": "{{NAME}}" },
        { "name": "CONTROLLER_URL",         "value": "{{CONTROLLER_URL}}" },
        { "name": "INSPECTOR_PORT",         "value": "9090" }
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
            - { name: CONTROLLER_URL,         value: "{{CONTROLLER_URL}}" }
            - { name: CONNECTOR_NAME,         value: "{{NAME}}" }
            - { name: CONNECTOR_CONFIG,       value: "/etc/mcp-connector/config.yaml" }
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
            { name: 'CONNECTOR_CONFIG',       value: '/etc/mcp-connector/config.yaml' }
            { name: 'CONNECTOR_NAME',         value: connectorName }
            { name: 'CONTROLLER_URL',         value: controllerUrl }
            { name: 'INSPECTOR_PORT',         value: '9090' }
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
      # C8: assemble POSTGRES_URL from the mounted secret file at
      # container start. See entrypoint.sh. Never put the password in
      # a compose env string or .env line.
      POSTGRES_URL_TEMPLATE: postgres://mcp:__PWFILE__@postgres:5432/mcp_connector
      POSTGRES_PW_FILE: /run/secrets/pg_password
    volumes:
      - state:/var/lib/mcp-connector
      - ./connector.yaml:/etc/mcp-connector/config.yaml:ro
      - ./secrets/connector.key:/etc/mcp-connector/connector.key:ro
    secrets: [pg_password]
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

# db mode:
# POSTGRES_URL is assembled by entrypoint.sh from a mounted secret file —
# see docker-compose.yml (POSTGRES_URL_TEMPLATE + POSTGRES_PW_FILE). Do
# NOT put the password in this .env file.
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
// CODE-DEPLOY design record for the design record.

const FLY_TOML = `# mcp-connector — Fly.io deployment
# Generated by \`mcp-connector deploy init --target fly\`.
#
# Load-bearing invariants (see CODE-DEPLOY design record):
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
  # POSTGRES_URL, CONNECTOR_KEY_B64 are set by \`mcp-connector deploy apply --target fly\`.

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
    ],
    readmeAppendix: `## AWS Fargate

Register the task definition:

    aws ecs register-task-definition --cli-input-json file://task-definition.json

Before running, populate Secrets Manager per \`secrets-hint.sh\` and replace
\`REPLACE_WITH_SECRETS_MANAGER_ARN\` in the task-definition.json. Same for
\`REPLACE_WITH_REGION\` in the awslogs config.

See deploy/terraform/README.md for the full walkthrough (ECS Exec for
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

See deploy/helm/README.md for the reasoning behind each choice.
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
deploy/aca/README.md for the full walkthrough.
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
      { path: "fly.toml", content: FLY_TOML },
    ],
    readmeAppendix: `## Fly.io

\`fly.toml\` landed AT REPO ROOT (Fly's build context is locked to the
fly.toml's directory, and the Dockerfile needs repo root — see
deploy/fly/README.md for the reasoning).

**Deploy:**

    mcp-connector deploy apply --target fly

That's it. Creates the Fly app + Postgres, sets the master key, creates
the state volume, runs \`fly deploy\`. Idempotent — safe to re-run if a
mid-step failure interrupts the flow.

Reach the inspector: \`fly proxy 9090:9090 -a {{APP_NAME}}\` → http://localhost:9090/

See deploy/fly/README.md for the full walkthrough (mock backend, private
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

\`MOCK_POSTGRES_URL\` is REQUIRED — the mock refuses to boot without it. Point
it at the \`crm\` database on the connector's existing Postgres app (the
connector owns \`mcp_connector\` on that same server; the mock owns \`crm\`).
Create the database first if it doesn't exist.

    fly secrets set \\
      MOCK_POSTGRES_URL="postgres://postgres:<pw>@mcp-connector-{{NAME}}-db.flycast:5432/crm" \\
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
