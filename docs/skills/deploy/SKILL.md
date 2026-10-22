---
name: deploy
description: Deploy the MCP connector to a cloud — Fly.io, docker-compose, AWS Fargate, GKE, or Azure Container Apps. Asks which platform, gathers the few values needed, renders manifests, drives the cloud's CLI, and verifies the connector reached "open". Use when asked to deploy the connector, stand up a new connector environment, provision a connector for a customer, or when a deployed connector won't boot or won't reach its controller.
---

# /deploy — guided connector deployment

Take an operator from "I have a controller and a cloud account" to "tools are flowing", asking
the minimum number of questions and verifying each step before moving on.

The connector is a **single outbound-only process**. It dials the controller over WSS, opens no
inbound port, and needs exactly **one** thing from its environment: a 32-byte master key. It
keeps its own config in a sealed JSON file on a persistent volume — there is no database.
Everything else — controller URL, connector name, auth posture — is entered later, in the
connector's own loopback-only web UI. Internalise that shape before running any command; most
deployment mistakes come from assuming the connector is a server, or from assuming it needs
backing infrastructure it does not.

## Before anything — which targets actually work

Verified 2026-09-23. No known-broken targets — before DB-TO-FILE, three of them emitted a manifest
that omitted both required env vars while still setting four retired ones, so the container
crash-looped in `requireEnv()` and the logs pointed misleadingly at the operator's secret wiring.

**Distinguish three levels of proof** and say which one applies, because "works" is doing a lot of
work in that word:

- **exercised** — a connector actually reached `open` this way.
- **renders clean** — the tool that consumes the manifest accepts it (`terraform validate`,
  `helm lint`, `helm template`, `docker compose config`). Catches syntax and schema errors, and
  nothing about whether the cloud behaves. Every defect DB-TO-FILE fixed in the Terraform module was
  valid HCL.
- **static only** — our own tests read the file as text. Weakest, and the only level available for a
  target whose tool nobody has installed.

| Target | Status | Notes |
|---|---|---|
| `fly` | ✅ **exercised** | `deploy apply` automates the whole bootstrap (4 steps) |
| `compose` | ✅ **exercised** | One service, one secret. `docker compose config` also clean |
| Helm chart (`deploy/helm/`) | ◐ **renders clean** | `helm lint` + `helm template` pass under helm 4. Two `--set` flags; memory floor 1 Gi; key as `CONNECTOR_KEY_B64`. Never installed to a cluster |
| Terraform `aws-fargate/examples/from-scratch` | ◐ **renders clean** | `terraform validate` passes. **The from-zero AWS path** — creates VPC, subnets, IGW, cluster, both IAM roles, ECR, then calls the core module. Never applied |
| Terraform `aws-fargate` (core) | ◐ **renders clean** | `terraform validate` passes. Needs a VPC + cluster + roles supplied; use the example above if you have none |
| `fargate` (`deploy init`) | ○ **static only** | Task definition alone. Needs EFS ids pasted in, and assumes you have VPC/cluster/roles |
| `aca` | ○ **static only** | Bicep; needs an Azure Files share registered on the environment first |
| `gke` | ⛔ **removed** | Kubernetes is the Helm chart. `deploy init --target gke` errors with the `helm install` / `helm template` commands |

**Nothing below `exercised` has touched a real cloud.** Say that to the operator before starting, and
treat the first deploy as the verification — any failure is a finding about our manifests, not their
mistake. Do not hand-patch a generated manifest to get past it: fix the template and regenerate, or
the customer ends up with a deployment nobody can reproduce.

**A skipped tool-gated test is worse than a failing one**, and this bit us: `toolAvailable()` probed
`<bin> --version`, which helm 4 removed, so every helm-gated test reported SKIPPED on a machine where
helm worked — a green suite proving nothing about the chart. If a target claims "renders clean",
confirm the tool is actually on PATH rather than trusting the suite was green.

**None of them is blocked on infrastructure any more.** Removing Postgres deleted the hard part — a
managed database per cloud, its networking, its credential rotation. What was left was wiring one
secret, raising a memory number, and making the state volume persistent. Never describe any target as
needing a database.

**Two things that now apply to every cloud target**, both of which produce failures that read as a
broken connector rather than a broken deployment:

1. **The state volume is the connector's identity.** `state/config.json` on it holds the sealed
   tunnel bearer and the registration token. On an ephemeral volume the connector asks for Configure
   Tunnel after every restart, and the re-register collides on `name_taken` — which is sticky, so
   auto-reconnect is suppressed and a human must click Reconnect. Unattended recovery is impossible.
   This is why `fargate` uses EFS, `aca` needs Azure Files, and Helm needs a PVC.
2. **Nothing may mount over `/etc/tool-proxy`.** The entrypoint decodes `CONNECTOR_KEY_B64` and
   *writes* the key file there. A read-only ConfigMap or an ephemeral volume at that path breaks boot
   — it is what killed the old `gke` manifests.

If asked for an **unverified** target: say so before starting, name what is unproven (nobody has run
it against that cloud), and proceed if they still want it — that is a reasonable choice and the first
run is how it becomes verified. **Do not hand-patch a generated manifest when something fails.** Fix
the template and regenerate: a patched manifest hides the bug and leaves the customer with a
deployment nobody can reproduce. If asked for `gke`, the CLI's own error message has the two `helm`
commands; use those rather than reconstructing raw YAML.

## Step 0 — situate yourself

Run these before asking the operator anything, so the questions you ask are the ones that are
actually still open:

```bash
git rev-parse --show-toplevel          # must be the tool-proxy repo root; every path below is relative to it
node connector/dist/index.js version   # if this fails, run: npm install && npm run build
```

Then check only the CLI the chosen target needs — `fly version`, or `docker compose version`.
A missing CLI is the operator's install step, not something to work around.

## Step 1 — the questions

Ask these **before** touching a cloud, in one pass. Every one has a default; state the default
and let the operator accept it.

| # | Question | Default / guidance |
|---|---|---|
| 1 | **Platform?** | `fly` for a demo or the fastest path; `compose` for a single VM they already own; Helm for Kubernetes; Terraform `aws-fargate` for a from-zero AWS deploy; `fargate` (`deploy init`) only if they already have VPC + cluster + roles; `aca` for Azure. Say which ones are unverified |
| 2 | **Connector name?** | No default. Must match the controller's Tunnel Security row **Name**, case-sensitive. A mismatch surfaces only as HTTP 401 at the WS upgrade — the worst failure shape available, so confirm the spelling explicitly |
| 3 | **Controller URL?** | No default. **HTTPS root only.** Ask it, but do NOT pass it to `deploy init` — that flag is ignored now and warns. The URL is typed into the Configure Tunnel modal in Step 4, which strips a trailing `/mcp-tunnel` itself |
| 4 | **Fly app name?** (`fly` only) | Defaults to `tool-proxy-<name>`. Ask only if they want a custom one |
| 5 | **Region?** (`fly` only) | Comes from `fly.toml`'s `primary_region`; ask if generating fresh |

Do **not** ask about: auth posture, bearer tokens, OAuth client IDs, a database, or the image tag.
The first three are entered in the Configure Tunnel modal at the end; there is no database; the image
is pinned by the template.

**Also ask about persistent storage on every cloud target**, because it is the one prerequisite the
manifests cannot create for the operator and the one whose absence is invisible until a restart:
EFS for Fargate (the Terraform module builds it; the bare task definition needs IDs pasted in), an
Azure Files share for ACA, a StorageClass that can bind a `ReadWriteOnce` PVC for Helm.

## Step 2 — runbooks

### `fly`

Two commands, then verification. `deploy apply` performs four idempotent operations — app create,
`secrets set CONNECTOR_KEY_B64`, `volumes create state`, `fly deploy`. Safe to re-run if a step
fails mid-way. (It was five; `fly postgres create` + `attach` are gone, which also removed the one
step that was not idempotent and the one that created a second billable app.)

```bash
node connector/dist/index.js deploy init --target fly \
  --name <connector-name> \
  --app-name <fly-app-name> \
  --yes

node connector/dist/index.js deploy apply --target fly
```

Prefer `./scripts/deploy/fly-deploy.sh` when the working tree may be stale — it runs
`npm install` and `npm run build` first, then calls the same `deploy apply`. That is also the
script CI runs, so using it keeps local and CI behaviour identical.

**The master key is minted inside `applyFly` via `randomBytes(32)` and piped straight to
`fly secrets set`.** Never generate a key yourself and never echo one — a key that passes through
the conversation is a key in a log. If a key must be rotated, do it with a command, not by
producing bytes in the transcript.

### `compose`

The generated appendix is correct as of DB-TO-FILE and matches these steps — earlier versions told
the operator to edit `TUNNEL_AUTH_TOKEN` (retired) and omitted files the stack required.

```bash
node connector/dist/index.js deploy init --target compose \
  --name <connector-name> \
  --out ./deploy/compose
cd deploy/compose      # the repo's own copy — no deploy init needed

mkdir -p secrets                                   # the redirect below fails without this

head -c 32 /dev/urandom > secrets/connector.key    # libsodium master key — the ONLY secret
chmod 400 secrets/connector.key

printf 'mcp_servers: []\n' > connector.yaml         # bind-mount SOURCE must exist as a FILE first;
                                                    # Docker silently creates a DIRECTORY otherwise,
                                                    # and config load then fails

docker compose -f docker-compose.prod.yml up -d     # -f IS REQUIRED: that directory has
                                                    # docker-compose.prod.yml and .dev.yml but
                                                    # no docker-compose.yml, so a bare
                                                    # `docker compose up` fails with
                                                    # "no configuration file provided"
```

Every later `docker compose` command in that directory needs the same `-f`. If
you would rather not repeat it, `export COMPOSE_FILE=docker-compose.prod.yml`
once — or use `deploy init --target compose --out <a-different-dir>`, which
writes a plain `docker-compose.yml`. **Don't scaffold into `deploy/compose`
itself**: two compose files whose differences are invisible at the command line
is how an operator ends up debugging the wrong stack.

There is no `pg_password` and no `.env` step any more. The whole `POSTGRES_URL_TEMPLATE` +
`POSTGRES_PW_FILE` + `__PWFILE__` mechanism is gone, and with it a foot-gun worth remembering as a
*class*: the substitution was a literal string replace with no URL-encoding, so a password
containing `/ @ : ? #` produced a corrupt DSN and a misleading `doctor` failure. Nothing in the
connector now assembles a credential by string surgery. Don't reintroduce one.

**The `state` volume is now the connector's identity.** `state/config.json` inside it holds the
sealed tunnel bearer and the registration token. `docker compose down -v` destroys it, which means
re-running Configure Tunnel *and* a `name_taken` rejection from the controller until someone clears
the stale row. `down` without `-v` is safe.

## Step 3 — the verification gate

Do not proceed to Step 4 until this passes. `doctor` is the machine-readable gate: it exits **0**
all-ok, **1** on any failure, **2** on warnings-only, and `--json` emits line-delimited JSON.

```bash
# fly
fly ssh console -a <app> -C "node /app/connector/dist/index.js doctor --json"

# compose
docker compose exec connector node dist/index.js doctor --json
```

**Invoke it as `node dist/index.js`, not `tool-proxy`.** The image sets `WORKDIR /app/connector`
and the entrypoint execs `node dist/index.js "$@"`; there is no `tool-proxy` on `PATH`. The npm
workspace bin link does exist at `/app/node_modules/.bin/tool-proxy`, but that directory isn't on
`PATH`, so the bare name fails with `not found`. (`deploy/README.md` and the compose target's
generated appendix both used to print the bare-name form; both are fixed as of DB-TO-FILE.)

Seven checks: `node-version`, `env-file`, `connector-yaml`, `inspector-port`, `mcp-tree`,
`connector-key-file`, `config-store`.

**Read `config-store` specifically** — it replaced `postgres-url`, and it is the check that catches
the cloud-volume failure nothing else sees:

| Verdict | Meaning |
|---|---|
| `ok … valid, key matches` | Store present and the master key's fingerprint matches. |
| `ok … will be created at boot` | No file yet, directory writable. Correct for a first deploy. |
| `FAIL … not writable` | **The one that matters.** The state directory exists but the connector's uid cannot write it — a volume mounted `uid: 0` whose subdirectory was never chowned. Without this check it surfaces only as a crash-loop. |
| `FAIL … different master key` | The store was sealed with another key. Restore the original; there is no re-seal path. |
| `FAIL … not valid JSON` | Corrupt store. It deliberately does NOT fall back to "fresh install" — that would discard a recoverable registration token. |
| `warn` | Key path set but unreadable, so the fingerprint could not be verified. |

Then confirm there is no inbound surface. On Fly this is a single assertion and it **must** return
empty:

```bash
fly ips list -a <app>      # empty. If it lists an address:
                           # fly ips release <address> -a <app>
```

## Step 4 — the loopback hop, then Configure Tunnel

The connector's dashboard is **loopback-only, permanently**. It is not a login-protected page with
a loopback default — every route except four machine-API paths refuses any caller whose source
address isn't `127.0.0.1`. So reaching it means arriving *as* loopback, which each platform does
differently:

| Platform | Command |
|---|---|
| `fly` | `./scripts/fly-inspector.sh <app>` |
| `compose` | **NOT `localhost:9090`** — the connector binds loopback inside the container, so the host cannot reach it and no port mapping helps (measured: a published port is refused; a wide bind answers 403). Use `ssh -L 9090:127.0.0.1:9090 <vm-host>` for a VM, or run the connector directly rather than containerised when you need a browser locally |
| K8s | `kubectl port-forward deploy/tool-proxy 9090:9090` |
| Fargate | ECS Exec + SSM port forwarding |
| ACA | `az containerapp exec` |

**Fly is the case that looks like a product bug.** `fly proxy 9090:9090` connects and the browser
loads, but every dashboard route returns `403 {"ok":false,"error":"forbidden: loopback only"}` —
`fly proxy` arrives from the Machine's `fdaa:` mesh address and `fly ssh` has no `-L`, so neither
gives you a loopback origin. `scripts/fly-inspector.sh` supplies the missing hop with a relay
inside the Machine and tears it down on Ctrl-C. That teardown matters: the relay launders the
source address rather than authenticating, so while it runs the dashboard is reachable from the
whole Fly org's private network. **Treat it as a scoped operation — never leave it running.**

Two adjacent traps to pre-empt rather than debug:

- **Adding API clients in the Network Access panel does not grant browser access.** Those are
  `/oauth/token` credentials for scripts calling `/v1/*`. They open the machine API, not the UI.
- **Use an explicit `http://` URL.** Chrome's HSTS on `localhost` can force `https://`, which the
  inspector doesn't serve — the operator sees `ERR_CONNECTION_RESET` and blames the deploy.

Then, in the browser, fill in **Configure Tunnel**: controller URL, connector name (matching the
Tunnel Security row exactly), and the auth posture matching that row's type. Save. The status pill
should go `closed → connecting → open`.

This modal is the **only** way to set tunnel identity — there is no CLI subcommand and no env var
for it. So the loopback hop isn't a convenience; a deployment cannot complete first-connect
without it.

## Guardrails — never do these

Each rule has its reason attached, because a rule without its reason gets optimised away by the
next reader.

- **Never generate the master key or a bearer token in the transcript.** Delegate to a command that
  mints in-process. A secret that passes through the model is a secret in a conversation log.
- **Never widen `INSPECTOR_BIND_ADDR` to reach the dashboard.** The bind decides whether the process
  accepts a connection; the loopback *gate* decides whether it answers. Widening cannot grant
  dashboard access, and it does expose the machine API. `INSPECTOR_ALLOW_NONLOOPBACK=1` exists only
  for Fly's `::` mesh case with no public IP allocated.
- **Never add a path to `NON_LOOPBACK_ALLOWED_PATHS` to fix a 403.** That list is exact-match,
  deny-by-default, and exhaustively pinned by a test. Adding to it is how an operator-only route
  becomes internet-reachable.
- **Never put a load balancer in front of the connector, and never allocate a public IP.** Nothing
  reaches it inbound by design; an LB is pure risk with no upside.
- **Never scale past one replica.** Identity binds `(tenant, name)` at register-frame time; a second
  replica collides on the controller's duplicate-name guard. Multi-replica needs controller-side
  work that hasn't happened.
- **Never deploy under 1 GB of memory.** Measured floor is 493 MB for the connector plus four
  bundled MCPs — each Type 1 child is three processes (`tsx` wrapper, real `node`, resident esbuild).
  A 512 MB host cannot boot the shipped image, and the symptom is the fourth child dying at its
  readiness probe with no output, which reads as a broken MCP rather than an undersized host.
  `MCP_READINESS_TIMEOUT_MS` does not help — the memory is absent, not late.
- **Never use a floating image tag.** A restart would become an unplanned upgrade of a process whose
  entire job is holding one long-lived socket.
- **Confirm before every cloud-mutating step.** Creating a database costs money; deleting one costs
  data. Propose, then let the operator approve.

## Failure decoder

The three failures that get misattributed, and what they actually mean:

| Symptom | Actual cause |
|---|---|
| Container crash-loops; logs name missing env vars | The **manifest** is wrong, not the controller row. `CONNECTOR_KEY_FILE` is the only required var, and every shipped manifest now sets it — so suspect a hand-edited or pre-DB-TO-FILE manifest, and check for a leftover `POSTGRES_URL` / `TUNNEL_AUTH_TOKEN` block that predates the change |
| Container crash-loops with `EACCES` on the state directory | The volume's mount is root-owned and nothing chowned the `state/` subdirectory. On K8s/Fly that is `entrypoint.sh`'s job and it runs only as root — check the pod isn't forcing a non-root `securityContext`, which a `restricted` Pod Security Standard does |
| HTTP **401** at the WS upgrade | Connector name doesn't match the Tunnel Security row (case-sensitive), or the bearer belongs to a different row. Nothing local can detect this before dialling |
| **403 `forbidden: loopback only`** | You aren't arriving as loopback. On Fly, `fly proxy` never will — use `scripts/fly-inspector.sh` |
| Fourth MCP dies at readiness, no output | Host memory. Raise to ≥ 1 GB |
| Tunnel was `open`, now asks for Configure Tunnel again | The state volume was replaced. Identity lives in `state/config.json`; an ephemeral volume (Fargate `host: {}`, an `emptyDir`, `compose down -v`) loses it on every restart, and the re-register then hits `name_taken` |
| Tunnel opens, then OAuth2 mint fails behind a corporate proxy | The WSS dial honours `HTTPS_PROXY`; the `fetch` side does **not** unless `NODE_USE_ENV_PROXY=1`, which the image doesn't set. The mint runs *before* the dial, so it fails first |

## Reference

- `deploy/README.md` — per-cloud guides
- `deploy/fly/OPERATOR-RUNBOOK.md` — the Fly path in full
- `docs/ENV-VARS.md` — the authoritative env surface. If you are about to mention an env var that
  isn't in this file, it is retired and you are wrong
- `docs/INSPECTOR.md` — dashboard, Network Access, and the creds views
