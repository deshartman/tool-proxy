# DEPLOYMENT-SCRIPTS.md

Status: completed 2026-07-22
Started: 2026-07-22
Branch: `feature/deployment-scripts`

## Motivation

The dev-onboarding path is script-driven (`./scripts/start-connector.sh` boots
everything from one command). The cloud-onboarding path is documentation-driven
— five deploy docs totalling ~720 lines, one 40-line `build-image.sh`, and a
lot of "copy this task-definition JSON into your task role, edit these ARNs,
then click through the console" prose. For an open-source project whose pitch
is *simple to deploy behind a customer firewall*, that gap is the biggest
friction point in the customer's first hour.

This plan closes the gap in four coordinated pieces, all on
`feature/deployment-scripts`. Each piece ships with its own tests and lands as
a discrete commit so it can be reverted independently.

## Non-goals

- No change to the runtime dispatch model — `db` vs `env` mode, tunnel
  handshake, MCP supervisor, everything downstream of boot stays untouched.
- No new secrets stores, no new controller-side APIs. The scaffold emits the
  shape *the customer's cloud* expects (Secrets Manager, Secret Manager,
  Key Vault, Kubernetes Secret) — it doesn't invent a Twilio-managed secret
  store.
- No auto-`terraform apply`. The scaffold *emits* Terraform; the customer
  runs it. Same for Helm.
- No controller-side automation. Minting the Tunnel Security row still
  happens in the controller UI. That gesture is the trust anchor and stays
  a human decision. (A future plan can add a `twilio api` CLI wrapper.)

## Four workstreams

Order chosen so each stage stands alone if we ship partial. Doctor is first
because it's the smallest and its output informs what the scaffold needs to
produce.

### 1. `mcp-connector doctor` — preflight checks

**Verb.** `mcp-connector doctor` (no flags for v1).

**Purpose.** Answer *"is this environment configured correctly?"* in one
command, both in dev before first boot and in prod after image pull.

**Checks (each returns `ok` / `warn` / `fail` + one-line remediation):**

Common:
- `.env` file exists and parses
- `connector.yaml` (or `CONNECTOR_CONFIG`) resolves and parses
- Node runtime major ≥ 22
- `mcp/` tree contains at least one MCP folder
- Inspector port not in use by another process

`db` mode:
- `POSTGRES_URL` set + reachable (TCP dial + `SELECT 1`)
- `CONNECTOR_KEY_FILE` set, path readable, contents are exactly 32 bytes
- `mcp_connector.controllers` row exists (if not: `warn`, "run the connector
  once to seed the schema")

`env` mode:
- `CONTROLLER_URL` set + resolves DNS + HTTPS 443 reachable (`HEAD /`)
- `CONNECTOR_NAME` set
- Exactly one auth posture configured (`TUNNEL_AUTH_TOKEN` XOR
  `OAUTH_CLIENT_ID`+`OAUTH_CLIENT_SECRET`+`OAUTH_TOKEN_URL`)
- `.connector-state.json` writable at the resolved path

Exit code is `0` on all-ok, `1` if any `fail`, `2` if any `warn` and no
`fail`. Cloud runbooks can `mcp-connector doctor && start` to fail fast.

**Non-goals for v1.** No full WS handshake (we don't want a doctor run to
consume a bearer). No MCP-level probing. No controller register-frame dry
run. All of that belongs in a later `--deep` mode.

**Implementation surface.**
- New file `packages/connector/src/doctor.ts` exporting `runDoctor(argv)`.
- Reuse `envString` / `envOptional` from `env.ts` for reads.
- Reuse `resolveCredsSource` from `boot/lifecycle.ts` for mode selection.
- Reuse `loadConfig` from `config.ts` for yaml parse (dry-run mode: don't
  spawn anything).
- One `dispatch` case in `index.ts`.
- Tests at `packages/connector/tests/doctor/*.test.ts` covering: green path
  (all env set), missing var per mode, invalid key file (wrong length),
  Postgres unreachable, port already bound.

### 2. `mcp-connector deploy init --target <t>` — cloud manifests

**Verb.** `mcp-connector deploy init --target {fargate|gke|aca|compose|terraform|helm} [--name X] [--controller-url URL] [--out DIR]`.

**Purpose.** Replace three parallel copy-paste walkthroughs with one command
that emits the right shape with the right variables filled in.

**Targets:**

| Target       | Emits                                                    | Default `--out` |
|--------------|----------------------------------------------------------|-----------------|
| `fargate`    | `task-definition.json` + `secrets.tf` sketch             | `./deploy/aws-fargate/` |
| `gke`        | `namespace.yaml`, `secret.yaml`, `configmap.yaml`, `deployment.yaml`, `pvc.yaml` | `./deploy/gke/` |
| `aca`        | `containerapp.bicep` + `secrets.bicep`                   | `./deploy/aca/`  |
| `compose`    | `docker-compose.yml` + `.env.example`                    | `./deploy/compose/` |
| `terraform`  | copies module from `deploy/terraform/aws-fargate/`       | `./deploy/tf/`  |
| `helm`       | copies chart from `deploy/helm/mcp-connector/`           | `./deploy/helm/` |

**Inputs.**
- `--name` → interpolated as `CONNECTOR_NAME` everywhere
- `--controller-url` → `CONTROLLER_URL` and derived WS host
- `--image` → OCI image ref (defaults to `mcp-connector:latest`)
- `--creds-source` → `db` (default) or `env`
- `--auth` → `static` (bearer) or `oauth2`

Prompts interactively for any not supplied — same `readline` pattern
`runInit` uses.

**Templating.** Plain string templates in
`packages/connector/src/deploy/templates/` — one file per emitted artefact
per target. No handlebars, no ejs. The set is small (< 15 files) and every
substitution is a documented variable, so introducing a template engine
would obscure the shape of what we emit.

**Implementation surface.**
- `packages/connector/src/deploy/scaffold.ts` — `runDeployInit(argv)`.
- `packages/connector/src/deploy/templates/` — literal template files
  loaded as strings; substitutions via `String.replace`.
- One `dispatch` case in `index.ts` (`deploy` verb → subcommand `scaffold`).
- Tests at `packages/connector/tests/deploy/scaffold.test.ts` — for each
  target: render to a tmpdir, assert the emitted files exist and contain
  the expected substitutions. Snapshot-testing feels heavy here; explicit
  `expect(content).toContain(...)` per invariant keeps the assertions
  reviewable.

**Interactive vs non-interactive.** `--yes` skips prompts and uses flag
values only (CI usage). Missing required flags without `--yes` prompt via
readline.

### 3. `docker-compose.prod.yml` — the one-VM shape

**Purpose.** The `docker-compose.dev.yml` today is dev-loop only (mounts
source, hot reload). The one-VM prod shape — `docker run` on a Compute
Engine VM / EC2 instance / bare-metal box — isn't covered. That's the
simplest cloud deployment we can ship: `docker compose up -d` and you're
running.

**File.** `docker-compose.prod.yml` at repo root.

**Shape:**
```yaml
services:
  connector:
    image: ghcr.io/twilio/mcp-connector:${MCP_VERSION:-latest}
    env_file: .env
    volumes:
      - state:/var/lib/mcp-connector
      - ./connector.yaml:/etc/mcp-connector/config.yaml:ro
      - ./mcp/local:/var/lib/mcp-connector/customer-mcps:ro
      - ./secrets/connector.key:/etc/mcp-connector/connector.key:ro
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
```

Plus a matching `.env.compose.example` documenting `POSTGRES_URL` (pointing
at the sibling container) and `CONNECTOR_KEY_FILE` (pointing at the mounted
secret).

**Non-goals.** No `postgres` for `env`-mode users — a matching `env`-mode
example is a comment in the file, not a second compose file. The default
target is `db` mode.

**Tests.** The compose file is validated via `docker compose config` in CI
(`compose-lint.test.ts` shells out and asserts exit 0 — same helper the
existing E2E harness uses). No behavioural test — bringing up Postgres in
CI to exercise the compose file live is out of scope for a scaffold.

### 4. Terraform module + Helm chart

**Purpose.** For teams that already run Terraform / Helm as their IaC,
skip the scaffold-then-edit cycle: point at our module / chart and
`apply` / `install`.

**Layout:**
- `deploy/terraform/aws-fargate/` — `main.tf`, `variables.tf`,
  `outputs.tf`, `README.md`. Managed resources: task definition, task
  role, log group, Secrets Manager entries, optional CloudWatch alarms.
  Explicitly *not* managed: the ECS cluster (customer supplies as input),
  networking (customer supplies subnets + security group IDs).
- `deploy/helm/mcp-connector/` — standard Helm chart. `values.yaml`,
  `Chart.yaml`, `templates/deployment.yaml`, `templates/pvc.yaml`,
  `templates/configmap.yaml`, `templates/secret.yaml`, `templates/_helpers.tpl`.

**Versioning.** Chart version tracks connector version. Terraform module
uses semver via git tags; no separate module registry publish for v1.

**Tests.**
- `terraform validate` in CI (module-level, no `apply`).
- `helm lint` + `helm template` in CI, asserting the rendered manifests
  contain the same substitutions the scaffold would produce.
- Test runners: shell-out from a vitest test, same pattern as the
  compose-lint test.

## Docs updates (final commit before merge)

- `README.md` — new "Deployment" section with three lines: `doctor`,
  `deploy init`, `docker compose up -d`. Everything else defers to
  `docs/deploy/`.
- `docs/deploy/README.md` — restructured. Opens with the CLI verbs;
  cloud pages become "here's what the scaffold produced, here's how to
  wire it into your cluster".
- `docs/deploy/aws-fargate.md`, `gcp-gke.md`, `azure-container-apps.md`
  — trimmed by ~40%. The manifest examples move into templates the
  scaffold emits; each doc becomes "why this shape, what to change if
  your infra is different". The manual copy-paste stays as an appendix
  for airgapped environments.
- `CLAUDE.md` — one paragraph under a new "Deployment scaffolding"
  heading pointing at the CLI verbs and this plan file.

## Commit sequence

Each commit is self-contained (green tests) so a partial revert doesn't
leave the branch in a bad state:

1. `docs: add DEPLOYMENT-SCRIPTS plan` (this file)
2. `feat(cli): mcp-connector doctor` (+ tests)
3. `feat(cli): mcp-connector deploy init` (+ tests + templates)
4. `feat(deploy): docker-compose.prod.yml` (+ compose-lint test)
5. `feat(deploy): terraform module + helm chart` (+ lint tests)
6. `docs: rewrite deploy docs to lead with CLI` (docs + CLAUDE.md)

## Open questions

- **Should Terraform manage the controller-side Tunnel Security row?**
  Leaning no — controller minting is an authoritative human gesture and
  a `twilio_tunnel_security` provider resource is a separate plan-worth
  of thinking. v1 module manages connector-side only.
- **Should scaffold emit fully-populated values or leave `REPLACE_ME`
  markers?** Leaning fully-populated when the user supplied the flag /
  answered the prompt, `REPLACE_ME` when they didn't. Keeps the emitted
  file drop-in usable in the common path.
- **Where should the Helm chart live for `helm install oci://` support?**
  v1 ships in-repo. Registry push is a release-workflow follow-up, not a
  scope item here.

## Success criteria

A customer starting from a fresh `docker pull` should get to a running
connector in three commands:

```bash
mcp-connector deploy init --target compose --name prod-us-east-1 \
  --controller-url https://controller.example.com
cd deploy/compose
docker compose up -d
```

If `deploy init` requires editing the emitted files before that
`compose up` works, we haven't shipped the plan. The scaffold output is
runnable-as-emitted or the plan is incomplete.
