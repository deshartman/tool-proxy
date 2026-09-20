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

Verified 2026-09-16. **Do not attempt a ❌ target.** Its generated manifest omits both required
env vars and still emits four retired ones, so the container crash-loops in `requireEnv()` and
the logs misleadingly point at the operator's secret wiring.

| Target | Status | Notes |
|---|---|---|
| Target | Status | Notes |
|---|---|---|
| `fly` | ✅ **works, exercised end-to-end** | `deploy apply` automates the whole bootstrap (4 steps) |
| `compose` | ✅ works | Manifest and generated runbook both correct as of DB-TO-FILE |
| Helm chart (`deploy/helm/`) | ⚠️ **should work, unverified** | Rewritten for DB-TO-FILE: installs with two `--set` flags, memory floor raised to 1 Gi, key delivered as `CONNECTOR_KEY_B64`. Static checks pass; **nobody has run it against a cluster** — treat a first install as the verification, and say so to the operator |
| `fargate` | ❌ **blocked** | No `CONNECTOR_KEY_FILE` and no key secret, `memory: 512`, and its `state` volume is `host: {}` — ephemeral, so identity is lost on every task restart. Needs EFS |
| `gke` (`deploy init`) | ❌ **blocked** | Distinct artifact from the Helm chart above — the emitted manifests still carry the four retired env vars. Use the chart instead |
| `aca` | ❌ **blocked** | Same as `fargate`: no key wiring, `memory: '0.5Gi'` |

**The blocked three are blocked on their env surface, not on infrastructure any more.** Removing
Postgres deleted the hard part (a managed database per cloud, its networking, and its credential
rotation); what remains is wiring one secret and raising a memory number. Don't describe them as
needing a database.

If asked for a blocked target: say plainly that the generator is known-broken, name the two
missing env vars, point at the plan doc, and offer `fly` or `compose` instead. **Do not hand-patch
a generated manifest to get around it** — that hides the bug and leaves the customer with a
deployment nobody can reproduce.

## Step 0 — situate yourself

Run these before asking the operator anything, so the questions you ask are the ones that are
actually still open:

```bash
git rev-parse --show-toplevel          # must be the mcp-shim repo root; every path below is relative to it
node connector/dist/index.js version   # if this fails, run: npm install && npm run build
```

Then check only the CLI the chosen target needs — `fly version`, or `docker compose version`.
A missing CLI is the operator's install step, not something to work around.

## Step 1 — the questions

Ask these **before** touching a cloud, in one pass. Every one has a default; state the default
and let the operator accept it.

| # | Question | Default / guidance |
|---|---|---|
| 1 | **Platform?** | `fly` for a demo or the fastest path; `compose` for a single VM they already own |
| 2 | **Connector name?** | No default. Must match the controller's Tunnel Security row **Name**, case-sensitive. A mismatch surfaces only as HTTP 401 at the WS upgrade — the worst failure shape available, so confirm the spelling explicitly |
| 3 | **Controller URL?** | No default. **HTTPS root only.** If they paste `.../mcp-tunnel`, `normalizeControllerUrl()` strips it and warns — don't pre-strip it yourself, let the warning teach them |
| 4 | **Fly app name?** (`fly` only) | Defaults to `mcp-connector-<name>`. Ask only if they want a custom one |
| 5 | **Region?** (`fly` only) | Comes from `fly.toml`'s `primary_region`; ask if generating fresh |

Do **not** ask about: auth posture, bearer tokens, OAuth client IDs, or the image tag. The first
three are entered in the Configure Tunnel modal at the end; the image is pinned by the template.

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
  --controller-url https://<controller-host> \
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
  --controller-url https://<controller-host> \
  --out ./deploy/compose
cd deploy/compose

mkdir -p secrets                                   # the redirect below fails without this

head -c 32 /dev/urandom > secrets/connector.key    # libsodium master key — the ONLY secret
chmod 400 secrets/connector.key

printf 'mcp_servers: []\n' > connector.yaml         # bind-mount SOURCE must exist as a FILE first;
                                                    # Docker silently creates a DIRECTORY otherwise,
                                                    # and config load then fails

docker compose up -d
```

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

**Invoke it as `node dist/index.js`, not `mcp-connector`.** The image sets `WORKDIR /app/connector`
and the entrypoint execs `node dist/index.js "$@"`; there is no `mcp-connector` on `PATH`. The npm
workspace bin link does exist at `/app/node_modules/.bin/mcp-connector`, but that directory isn't on
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
| `compose` | already local — open `http://localhost:9090`. Remote VM: `ssh -L 9090:localhost:9090 <host>` |
| K8s | `kubectl port-forward deploy/mcp-connector 9090:9090` |
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
| Container crash-loops; logs name missing env vars | The **manifest** is wrong, not the controller row. `CONNECTOR_KEY_FILE` is the only required var. On `fargate` / `aca` / `deploy init --target gke` this is the known-broken generator — use the Helm chart or `fly`/`compose` instead |
| Container crash-loops with `EACCES` on the state directory | The volume's mount is root-owned and nothing chowned the `state/` subdirectory. On K8s/Fly that is `entrypoint.sh`'s job and it runs only as root — check the pod isn't forcing a non-root `securityContext`, which a `restricted` Pod Security Standard does |
| HTTP **401** at the WS upgrade | Connector name doesn't match the Tunnel Security row (case-sensitive), or the bearer belongs to a different row. Nothing local can detect this before dialling |
| **403 `forbidden: loopback only`** | You aren't arriving as loopback. On Fly, `fly proxy` never will — use `scripts/fly-inspector.sh` |
| Fourth MCP dies at readiness, no output | Host memory. Raise to ≥ 1 GB |
| Tunnel was `open`, now asks for Configure Tunnel again | The state volume was replaced. Identity lives in `state/config.json`; an ephemeral volume (Fargate `host: {}`, an `emptyDir`, `compose down -v`) loses it on every restart, and the re-register then hits `name_taken` |
| Tunnel opens, then OAuth2 mint fails behind a corporate proxy | The WSS dial honours `HTTPS_PROXY`; the `fetch` side does **not** unless `NODE_USE_ENV_PROXY=1`, which the image doesn't set. The mint runs *before* the dial, so it fails first |

## Reference

- `architectural-plans/DB-TO-FILE.md` — why there is no database, and what the sealed store
  guarantees. Supersedes `DEPLOY-ARCHITECTURE.md`'s Stage C, which is deleted, not deferred
- `architectural-plans/DEPLOY-ARCHITECTURE.md` — target statuses and the remaining per-target fixes
- `deploy/README.md` — per-cloud guides
- `deploy/fly/OPERATOR-RUNBOOK.md` — the Fly path in full
- `docs/ENV-VARS.md` — the authoritative env surface. If you are about to mention an env var that
  isn't in this file, it is retired and you are wrong
- `docs/INSPECTOR.md` — dashboard, Network Access, and the creds views
