# DEPLOY-ARCHITECTURE — Plan

> **Goal.** Make the connector "lean and easy" to deploy across AWS / GCP / Azure / Docker / K8s while preserving the architecturally load-bearing properties (outbound-only, per-MCP trust boundary, localhost-only inspector). Reduce the number of artifacts a customer's IT team has to author, eliminate image-rebuild for adding MCPs, and give operators a single UI surface (port 9090) for the operations they currently can't do without `kubectl exec` / `aws ecs execute-command` / `az containerapp exec`.
>
> **Branch.** `feature/deploy-architecture` (cut from `main` when work begins, not before — see [feedback_branch_check_at_session_start](../../.claude/projects/-Users-dhartman-Development-01-Twilio-AgenticProcedure-mcp-shim/memory/feedback_branch_check_at_session_start.md)).
>
> **Status: refining — no code yet.** This plan is the discussion artifact. Steps S0–Sn are placeholders until the design questions in §"Open design questions" are resolved.
>
> **Self-describing.** A fresh-context Claude should be able to read this file plus the linked source files and start work without re-deriving the architecture. Pointers to [CLAUDE.md](../../CLAUDE.md) and [TEST-SUITE.md](TEST-SUITE.md) are deliberate — don't inline what those files own.

## Context

Today the connector ships as a multi-arch OCI image ([packages/connector/Dockerfile](../../packages/connector/Dockerfile)) with three per-cloud deploy guides ([docs/deploy/](../../docs/deploy/)). The image bundles:

- the connector's compiled JS + prod `node_modules` (incl. `tsx` for Type 1 spawn)
- the inspector UI assets (`packages/connector/public/`)
- the `mcp/` tree (Type 1 source + Type 2/3 `.env` stubs)
- pre-installed Type 3 venvs at `/opt/bundled-mcps/<name>/.venv/`

The **network shape is already portable**: outbound-only WSS, no inbound LB, no public DNS, no TLS cert customer-side. The customer just needs egress to `CONTROLLER_URL` (TLS 443) and a runtime that doesn't kill long-lived outbound TCP. That's a green light on Fargate, Container Apps (`minReplicas: 1`), GKE, Fly.io, Compute Engine + systemd; red on Cloud Run / App Service / Lambda / scale-to-zero anything.

The **lifecycle shape is where portability friction shows up**. Five concrete pain points surfaced in the deployment review:

1. **Type 1 MCPs require image rebuild.** Adding a customer-authored Node MCP means extending the OCI image (`COPY mcp/local/<name>/`) and re-publishing. IT teams treat building images as a project, not a config change.
2. **State persistence on ephemeral runtimes.** [.connector-state.json](../../packages/connector/.connector-state.json) holds the controller-minted `registrationToken`. Pod/task restarts on Fargate/Container Apps/K8s without a PV re-mint, and the controller's dup-name guard 409s.
3. **Operator UI access is per-platform plumbing.** `kubectl port-forward`, `aws ecs execute-command`, `az containerapp exec` — three different tools for the same "open the inspector" operation.
4. **No `/healthz` / `/readyz` endpoint.** Orchestrator liveness/readiness probes are awkward without one.
5. **Two-step provisioning is opaque on misalignment.** Mismatch between the controller's Tunnel Security row Name and `CONNECTOR_NAME` env var shows up only as an HTTP 401 at WS upgrade.

User feedback on the friction inventory:

| # | Status | User direction |
|---|--------|----------------|
| 1 | **Open design** | "How else could we do this? A drop-in directory that reads and loads new servers?" — explore mount-from-volume Type 1 |
| 2 | **Must solve** | "Need a solution" — pick one of (a) PV-required, (b) controller-side state replay, (c) deterministic re-mint. Not optional. |
| 3 | **Open design** | "Do not understand this?" — re-explain the per-platform exec friction and propose options |
| 4 | **Plan to add** | `/healthz` + `/readyz` is going in. No further design call needed beyond probe semantics. |
| 5 | **Open design** | "Can we do this via the UI (port 9090)?" — bring provisioning flow into the inspector |

Two new requirements from the same conversation:

- **mTLS on the tunnel.** Use mutual TLS between connector and controller as an additional auth layer (and/or a posture replacement for static-bearer). Matters for enterprise customers who already have an internal CA and want connector identity tied to a cert, not a shared secret.
- **OAuth2 already supported** but the doc treats it as one of two equal postures. Re-position: OAuth2 is the recommended posture for medium-and-up deployments; static bearer is the demo / single-tenant fallback.
- **Load balancing for WSS.** Today's `replicas: 1` constraint is a deployment ceiling. Operators want "two connectors per environment" for redundancy. The controller side has to dispatch RPC to either replica without knowing which is "primary".

This plan addresses all eight (1–5 + mTLS + OAuth2 positioning + WSS LB) as a coherent deployment architecture, not eight independent fixes.

## Architecturally load-bearing properties (recap — DO NOT VIOLATE)

These come from [CLAUDE.md](../../CLAUDE.md) "Architecturally load-bearing properties". Any proposed change in this plan that touches them needs explicit user signoff before code lands.

- **Outbound-only.** Connector opens no inbound ports for the tunnel. Webhook ingress lives on the *controller*'s public hostname, dispatched over the existing WSS as `webhook` frames.
- **Trust boundary is per MCP server, not per tool.** Customer controls which MCPs run; every tool a server exposes is forwarded.
- **Localhost-only inspector.** `127.0.0.1` bind ([packages/connector/src/inspector/server.ts:397](../../packages/connector/src/inspector/server.ts#L397)). The Webhooks panel exposes the bcrypt-protected URL with a copy button by design — that URL *is* the secret. Never bridge `INSPECTOR_PORT` to a public LB.
- **Per-tunnel auth, controller-minted.** Today: static `ts_<...>` bearer OR OAuth2 `client_credentials`. Posture dispatched by env: `OAUTH_CLIENT_ID` set → OAuth2; otherwise static. Mutually exclusive; boot fails if neither is configured ([packages/connector/src/boot/auth.ts](../../packages/connector/src/boot/auth.ts), pinned by `tests/boot/auth.test.ts`).
- **Identity at register-frame time** — separate from handshake. First connect mints a `connectors` row; `registrationToken` persists in `.connector-state.json`; subsequent connects re-bind by token. Strict mode rejects unknown tokens.
- **No LLM in the connector core.** Type 3 bundles can do whatever — they run isolated venvs. The rule applies to `packages/connector/`.

## Friction #1 — Drop-in MCP directory (no image rebuild)

**Problem.** Today every Type 1 MCP is `COPY`'d into the image at build time ([Dockerfile:48,124](../../packages/connector/Dockerfile#L48)). The customer's flow for "add a Salesforce MCP" is:

1. Fork or extend the image
2. Add `mcp/local/salesforce/` with `tools/*.ts` + `server.ts` + `package.json`
3. `docker build` + push to their registry
4. Update the deployment to pull the new tag
5. Restart the connector

That's a build-pipeline-shaped task. For an organisation that just wants to expose an internal API as an MCP, the image-extension story is the single biggest barrier.

**Proposed shape — "drop-in MCPs" volume mount.** A second MCP search path read at boot:

```
/var/lib/mcp-connector/customer-mcps/
  salesforce/
    server.ts
    tools/*.ts
    package.json   # may declare third-party SDK deps
  internal-orders/
    ...
```

The connector scans this directory at boot, treats every immediate subfolder as a Type 1 MCP candidate (folder name = server name), and applies the same Type 1 spawn rules ([packages/connector/src/spawner.ts](../../packages/connector/src/spawner.ts)) it does today for `mcp/local/`. The yaml entry collapses to **just the server name** — everything else is convention.

Two consequences worth thinking through before committing:

| Consequence | Mitigation |
|---|---|
| First-boot `npm install` for any folder with non-empty `dependencies` becomes an at-runtime cost (today it's at image-build time, hidden from the customer). | Cache `node_modules` per-folder; only re-install when `package.json` mtime changes. The script-side helper at [scripts/start-connector.sh](../../scripts/start-connector.sh) already does this for the in-tree tree — extract the same helper into the connector boot path. |
| `tsx` is needed at runtime to run TypeScript MCPs without a build step. Today the connector image carries it. The drop-in shape doesn't change that — `tsx` stays in the image. | None needed; just document. |
| Type 2 (external endpoint) and Type 3 (Twilio bundle) need the YAML to wire `endpoint:` / `bundled:` — drop-in is **Type 1 only**. | Accept; documented as scope. |
| Customer-authored code now executes inside the connector container. The trust boundary widens from "image we built" to "directory the customer mounted." | This is the same trust posture as today's `mcp/local/` — customer authors that source already. The mount just relocates *where* they ship it. Document that the drop-in directory is the same trust scope as a customer-extended image. |

**Open design questions for stage 2:**
- **Q1.1** — Which yaml shape wins? Three options:
  - **(a) Auto-discover, no yaml entry needed.** Folder presence == enable. Yaml override possible but optional.
  - **(b) Yaml entry required, but minimal.** One line `- dropin: salesforce` and the connector resolves the folder.
  - **(c) Hybrid.** Auto-discover by default; yaml entry only needed to override (e.g. disable a folder, change `name`, add `env:`).
  - **Recommendation: (c).** Lowest-friction default; explicit escape hatch when needed.
- **Q1.2** — Does the drop-in folder support per-entry `.env` like today's `mcp/local/` does (via `dir:`)? Probably yes — same isolation invariant from CLAUDE.md "Per-entry env precedence (subtle)". Pin in the test suite.
- **Q1.3** — Should `mcp/local/` itself be deprecated in favour of the drop-in shape, or coexist? Recommend coexist: `mcp/local/` is the in-tree development convention, drop-in is the deployed-customer convention.

**Test-suite hooks** (cross-ref [TEST-SUITE.md](TEST-SUITE.md)):
- New row in env-var coverage map: `MCP_DROPIN_DIR` (default `/var/lib/mcp-connector/customer-mcps/`) — branches: unset → default, set → respected, empty-string → default per [src/env.ts](../../packages/connector/src/env.ts) rule.
- New phase-1 (config load) test target: drop-in discovery merges with yaml-declared servers without name collision (collision rule: yaml wins, log a warning).
- Defensive test for the per-folder `npm install` cache: `package.json` mtime change triggers re-install; unchanged skips.

## Friction #2 — State persistence on ephemeral runtimes

**Problem.** [.connector-state.json](../../packages/connector/.connector-state.json) holds the controller-minted `registrationToken`. On Fargate / Container Apps / K8s without a PV, every restart starts fresh — the connector mints a new row, the controller's dup-name guard 409s, and the operator has to delete the prior row by hand. This breaks the "lean restart" promise.

**Three viable solutions; pick one (not mutually exclusive but pick one as default):**

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **(a) Required PV / mounted volume** | Document a writable mount at `/etc/mcp-connector/state/` (or `CONNECTOR_STATE_PATH`); deploy guides require it. | Zero connector code change. Today's behavior, just documented harder. | Each platform has different PV semantics (Fargate ephemeral; Container Apps file shares; K8s PVC). Customer authors a different artifact per platform. Most work for IT. |
| **(b) Controller-side state replay** | After first register, controller stores the `registrationToken` keyed by `(tenant_id, name)`. On reconnect with no token, the controller looks up by `(tenant_id, name) + auth-posture proof` and replays the existing row. | Stateless container. No PV needed anywhere. Same artifact across all platforms. | Wire-format change (new register-frame variant). Trust boundary shifts: controller now needs to authenticate "this is the same connector identity" without the token, which is what the static bearer / OAuth2 already does — so **the auth posture's row-binding becomes the identity claim**, not the token. Subtle but coherent. |
| **(c) Deterministic re-mint** | First-class "the controller knows this Tunnel Security row's connector should overwrite any prior `connectors` row with this name" mode. The dup-name guard becomes opt-in for strict deployments. | No state file; no PV; no wire change beyond a controller-side flag on the Tunnel Security row. | Loses some auditability — "the connector you talked to yesterday" might literally be a different physical instance. For most customers fine; for compliance-sensitive ones not. |

**Recommendation: (b) controller-side state replay** as the default, with (a) PV remaining as an opt-in for customers who specifically want connector-side identity. Reasoning:
- (b) eliminates the highest-frequency support ticket pattern (restart 409s) without per-platform PV plumbing.
- The auth posture (static `ts_<...>` or OAuth2 client cert) **already** authenticates the connector — the registration token is a second-factor that adds "same physical install" rather than "same logical identity." For most customers, "same logical identity" is what they actually want.
- (c) is too implicit — a flag on the controller silently changes connector behavior. Avoid.

**Constraint from existing tests.** [tests/state/state-env.test.ts](../../packages/connector/tests/state/state-env.test.ts) pins the empty-string-vs-unset rule for `CONNECTOR_STATE_PATH`. [tests/tunnel/frame-router.test.ts](../../packages/connector/tests/tunnel/frame-router.test.ts) pins the "only persist on token change" optimization. Either survives unchanged under (a) and (c); under (b) they become "register-ack carries replayed token if any" tests.

**Open design questions:**
- **Q2.1** — If we ship (b), what's the migration story for customers running today's static-bearer + state-file setup? Probably: controller-side replay is opt-in per Tunnel Security row, off by default; existing deployments keep working.
- **Q2.2** — Does (b) change the `unknown_registration_token` self-heal path? Today the connector clears state and reconnects; under (b) a missing/unknown token never reaches "unknown" — the controller replays whichever row matches `(tenant, name)`.
- **Q2.3** — Wire format: does the register-ack frame grow a `replayedFromPriorSession: true` field so the inspector can show "resumed from row created 3 days ago" vs "freshly minted"?

**Test-suite hooks:**
- (b) ships → new tests under `tests/tunnel/frame-router.test.ts` for the replay branches.
- (a) ships → no test changes; pure docs.
- Drop the `unknown_registration_token` self-heal test if (b) makes that path unreachable; otherwise pin it stays.

## Friction #3 — Per-platform inspector access (re-explained)

**What "per-platform exec plumbing" means.** Today, an operator who needs to copy a webhook URL into the Twilio Console has to:

| Platform | Command they type |
|---|---|
| GKE / generic K8s | `kubectl port-forward deploy/mcp-connector 9090:9090` |
| AWS ECS Fargate | `aws ecs execute-command --task <id> --interactive --command "/bin/sh"`, then a port-forward dance through SSM |
| Azure Container Apps | `az containerapp exec --name $APP --resource-group $RG --command "/bin/sh"` then `curl 127.0.0.1:9090/...` |
| Fly.io | `fly ssh console -a <app>` then `curl 127.0.0.1:9090` |
| Docker on a VM | `docker exec -it <container> sh` |

Five different muscles for one operation. Worse: most of these need cluster admin permissions the operator doesn't have for production.

**Why we can't just expose the port.** The Webhooks panel exposes the bcrypt-protected webhook URL with a copy button. That URL *is* the secret. Bridging port 9090 to a public LB leaks every webhook URL the inspector knows about.

**Two options:**

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **(a) Controller-proxied inspector** | Operator authenticates to the controller; the controller proxies inspector requests over the existing WSS to the connector's `127.0.0.1:9090`. New frame types: `inspector-request` / `inspector-response`. | Same trust boundary as today (controller is already authenticated). One URL operators visit, regardless of platform. Reuses existing controller auth. | Adds two frame types + an HTTP-over-WS proxy layer. Latency. Inspector SSE streams need careful handling over the proxy. |
| **(b) `connector inspector-tunnel` CLI** | New CLI subcommand the operator runs locally; opens an SSH-equivalent tunnel through the WSS to the connector's loopback. | No controller code change. Operator authenticates with their existing controller credential. | Operator still installs a tool. Less discoverable than "open a URL." |

**Recommendation: (a) controller-proxied inspector**. The controller is the natural single pane of glass — it already knows which connectors are connected, has auth, and is the place operators go. The customer side gains nothing from owning yet another network operation.

**Crosses load-bearing rules?** Need to think carefully:
- "Localhost-only inspector" stays — the proxy reads from `127.0.0.1:9090` *inside the connector*, not from outside. The bind doesn't change.
- The controller is already authorized to talk to the connector via the WSS; this proxy is just a new frame variant on the same authenticated channel.
- The webhook URLs the inspector renders are bcrypt-protected and the controller already knows them (it minted them). No new secret exposure.

So (a) is consistent with the trust boundary, but it's a **non-trivial controller-side change** outside this repo. We can plan the connector side (frame variants, request handler) in this repo; the controller side lands as a separate ticket.

**Open design questions:**
- **Q3.1** — Inspector UI uses SSE (`/internal/webhook/stream`). Proxying SSE over WS-frames is doable but tedious. Worth scoping if (a) is picked.
- **Q3.2** — Should (a) be opt-in per Tunnel Security row (some customers may want air-gapped inspector access only)?
- **Q3.3** — Does (b) ship as a fallback for customers who refuse (a)?

**Test-suite hooks:**
- (a) ships → frame-router tests grow `inspector-request` dispatch cases.
- (b) ships → CLI surface needs handler tests; covered by the existing CLI test pattern (none exist yet — would establish the pattern).

## Friction #4 — `/healthz` and `/readyz` (already approved)

**User said: "Plan to add."** No design call — just pin the semantics.

**Recommendation:**
- `/livez` (or `/healthz`) — process is alive. Cheap; no WS check. Returns 200 always once the HTTP server is up.
- `/readyz` — connector is ready to dispatch. Returns 200 when:
  1. Configuration loaded without error
  2. All Type 1 children have passed their readiness probe (TCP listener up)
  3. Tunnel WS is `open` AND the most recent register-ack was `ok`
- Returns 503 with a JSON body listing which condition failed otherwise.

**Where to host them.** Two options:
- **(a)** Add `/livez` + `/readyz` to the inspector server but bind those two routes (only those two) to `0.0.0.0` while everything else stays `127.0.0.1`. **Rejected** — splitting bind by route is a footgun; one routing-table change leaks the rest.
- **(b)** Run a second tiny HTTP server on a separate port (`HEALTH_PORT`, default 9091) bound to `0.0.0.0`. Two routes only. No other surface. **Recommended.**

**Trust posture.** `/livez` and `/readyz` carry no secrets. They expose only "alive Y/N", "ready Y/N", and a small enum-ish reason on 503. Safe for orchestrator probes; safe for an LB target group health-check.

**Open design questions:**
- **Q4.1** — Is "Type 1 children alive" the right readiness gate, or just "tunnel open + register-ack ok"? Recommend the stricter version (children too) — a connector that's tunneled but has dead children is functionally not ready.
- **Q4.2** — Default port: 9091? 8080? Something less collision-prone?

**Test-suite hooks:**
- New test target under [tests/inspector/](../../packages/connector/tests/) (currently empty): `health-server.test.ts` — pins the readiness state machine across boot phases.
- Phase-8 "steady state" surface in TEST-SUITE.md lifecycle map gains a row.

## Friction #5 — Provisioning via the inspector UI

**User asked: "Can we do this via the UI (port 9090)?"** Yes — and it's a high-leverage move.

**Today's flow** has the customer copy values across three places (controller UI → secret manager → `.env`). Misalignment between the controller's Tunnel Security row Name and `CONNECTOR_NAME` env var shows up only as an HTTP 401 at WS upgrade — the worst possible failure mode (silent, late, undiagnosable).

**Proposed inspector additions:**

1. **Pre-flight panel.** Before any WS dial, a new "Setup" tab shows:
   - `CONTROLLER_URL` resolved value
   - `CONNECTOR_NAME` resolved value
   - Auth posture detected (`static-bearer (len=N)` / `oauth2 (clientId=...)`)
   - The headers that *will* be sent on the upgrade
   - A "Test handshake" button that does an HTTP GET against `${CONTROLLER_URL}/health` (or similar) and reports the result — surfaces DNS / TLS / network errors *before* trying to dial WSS.

2. **Live error decoding.** When the WS upgrade returns 401, the current inspector just shows "closed". New behavior: decode common controller-side error codes (`bearer did not match any tunnel security config`, `name mismatch`, `account suspended`, etc.) and show actionable text — "Your `CONNECTOR_NAME` env var is `prod-customer` but no Tunnel Security row with that name exists. Create one or fix the env var."

3. **Token state surface.** Show whether `.connector-state.json` exists, when it was minted, and a "Clear and re-mint" button (one-click recovery for the `unknown_registration_token` path that today requires `kubectl exec` + `rm`).

**Constraint.** The inspector is `127.0.0.1`-only. Anything in the Setup panel that exposes secrets (auth-token length is fine; bearer plaintext is not) follows the same rule as the Webhooks panel — copy buttons OK for non-secrets, never for the bearer itself.

**Why this is high-leverage.** Friction #1, #2, #3 all cause silent 401s or restarts that today's inspector can't explain. A pre-flight that catches the 90% case before the dial dramatically reduces support load and makes the connector feel *self-explanatory* — which is what "lean and easy" actually means.

**Open design questions:**
- **Q5.1** — Does the Setup panel persist across reconnects, or hide once the tunnel is open? Recommend: collapses to a small "verified" badge once register-ack succeeds; expandable on click.
- **Q5.2** — Should "Clear and re-mint" require typed confirmation? Recommend yes — it's destructive (forces re-registration on the controller).
- **Q5.3** — Does the pre-flight test against the controller use the bearer? If yes, we're sending the credential to the controller before the WSS handshake — same trust boundary as today, just over HTTPS. Probably fine. Alternative: pre-flight is anonymous (just DNS/TLS/connectivity check), and the bearer is only ever sent over WSS.

**Test-suite hooks:**
- The Setup panel is a UI surface — testable manually via the existing inspector workflow (regression catalog row when a manual run finds a bug).
- The pre-flight HTTPS check is a thin function; testable as a pure unit with a `fetch` fake.
- Error-code decoding table → pure mapping; trivial test target.

## New requirement — mTLS on the tunnel

**User asked: "What about using mTLS and OAuth2 security on the tunnel."** OAuth2 is already implemented; mTLS is new.

**What mTLS would buy us.** Connector identity tied to a private key + cert, not a shared secret. Enterprise customers with an internal CA or a managed PKI (AWS PCA, Vault PKI, GCP CAS) can issue connector certs from their existing trust chain. Compromise of `.env` doesn't compromise identity (the private key isn't in `.env` — it's in a per-platform secret store or HSM).

**Posture comparison:**

| Posture | Identity claim | Rotation | Customer artifacts | Best for |
|---|---|---|---|---|
| **Static `ts_<...>`** | Bearer token, controller-minted | 24h grace via Rotate Secret | One env var | Demos, single-tenant POCs |
| **OAuth2 `client_credentials`** | Short-lived JWT, controller-issued (or Twilio-issued post-flip) | Auto (1h JWT, refreshes <60s before expiry) | Three env vars (`OAUTH_CLIENT_ID/SECRET/TOKEN_URL`) | Most production deployments; clean Twilio-takeover migration |
| **mTLS** | Client cert + private key | Cert-validity-driven (typically 90d–1y); rotation via cert rolling | Cert + key files (mounted as volumes / read from secret store) | Enterprise; customers with existing PKI; air-gapped trust chains |

**Recommended positioning** (rewrite of `docs/deploy/README.md` is part of the work):
- **mTLS** — recommended for enterprise customers
- **OAuth2** — recommended for everyone else
- **Static bearer** — demo / POC only

**Implementation shape.** mTLS is a TLS-layer feature, not an application-layer one. The connector's WS client gets a new code path that:
1. Reads cert + key paths from env (`TUNNEL_CLIENT_CERT_PATH`, `TUNNEL_CLIENT_KEY_PATH`).
2. Constructs a `tls.Agent` (or the `ws` lib's equivalent) configured with the client cert.
3. Posture dispatch in `resolveAuth`: cert paths set → mTLS posture; else OAuth2/static path as today.
4. The `Authorization` bearer header may still be sent (mTLS-as-additional-auth) or omitted (mTLS-as-only-auth) — controller-side decision per Tunnel Security row.

**Crosses load-bearing rules?** No — same outbound-only WSS, same per-tunnel auth, just a different posture. The "auth posture is env-driven and mutually exclusive" invariant ([packages/connector/src/boot/auth.ts](../../packages/connector/src/boot/auth.ts)) extends from 2 → 3 postures. The fail-fast-when-none-configured rule stays.

**Open design questions:**
- **Q6.1** — Is mTLS *additional* to a bearer (defense-in-depth) or *replacement*? Recommend per-row choice on the controller.
- **Q6.2** — Cert format: PEM files only, or also support PKCS#12 / cloud KMS references? Start with PEM; KMS integration is a v2 concern (and arguably belongs in a sidecar, not the connector).
- **Q6.3** — Renewal/rotation: does the connector watch the cert file for change and re-dial on rotation? Or is it deploy-time only (rotation = restart)? Recommend file-watch + re-dial for zero-downtime renewal — but that's a meaningful chunk of code.
- **Q6.4** — Does this affect the OAuth2 token URL flow? Probably yes — if mTLS is in play, the OAuth2 `client_credentials` POST should also use the client cert (the controller may require it).

**Test-suite hooks:**
- New `resolveAuth` branches: mTLS-only, mTLS+bearer, mTLS+OAuth2. Cases pile up in [tests/boot/auth.test.ts](../../packages/connector/tests/boot/auth.test.ts).
- New env-var coverage rows: `TUNNEL_CLIENT_CERT_PATH`, `TUNNEL_CLIENT_KEY_PATH`.
- Integration-shape test (ws fake configured with a self-signed CA) — deferred until the first manual finding, per TEST-SUITE.md "don't pre-emptively build an integration harness" rule.

## New requirement — WSS load balancing (multi-replica connectors)

**User asked: "What about load balancing for WSS servers."** Today's hard rule is `replicas: 1` ([docs/deploy/aws-fargate.md](../../docs/deploy/aws-fargate.md), [docs/deploy/azure-container-apps.md](../../docs/deploy/azure-container-apps.md), [docs/deploy/gcp-gke.md](../../docs/deploy/gcp-gke.md)). Customers with availability targets want at least 2 — for rolling deploys, host failures, planned restarts.

**Why `replicas: 1` is the rule today.** Each connector dials *out* and registers a session bound to a `(tenant_id, name)` pair. Two replicas with the same `CONNECTOR_NAME` would either:
- Both try to register; controller's dup-name guard 409s the second one.
- Or (if guard is lifted) the controller has two sessions for the same logical identity and has to decide which one gets each inbound `tools/call`.

There is **no LB on the customer side** of this — the LB problem is on the *controller* side. The controller has to dispatch RPC to one of N connector sessions sharing a name.

**Three viable controller-side dispatch strategies:**

| Strategy | How | Pros | Cons |
|---|---|---|---|
| **(a) Active/passive** | One replica is "primary" (first-to-register or operator-flagged); secondary holds an open WS but only serves if primary drops. | Simplest semantics. Failover is "primary's WS closed → promote secondary". Order of `tools/call` dispatch is preserved. | Wastes secondary capacity. Failover takes ~heartbeat-interval to detect. |
| **(b) Round-robin / random over connected sessions** | Each `tools/call` picks any healthy session at random (or RR). | Linear capacity scaling. No promotion logic. | RPC is stateless from the controller's view, but if any tool has hidden per-session state (sessionId on a Type 1 child, OAuth2 token on an external), responses may diverge. Need a per-tool affinity story OR a "tools must be idempotent across replicas" rule. |
| **(c) Sticky-by-something** | Dispatch by `procedure_id` / `conversation_id` / hash-of-args, so a given logical workflow always hits the same connector replica. | Preserves per-session state (Type 1 child sessionId, etc.). | Sticky key has to come from somewhere — either the controller assigns it at procedure-start, or the request carries it. Adds wire-format surface. |

**Recommendation: ship (a) active/passive first; promote to (b) once we know which tools (if any) violate idempotence-across-replicas.** Reasoning:
- (a) is mostly a controller-side change with minimal connector impact (the connector just lifts the dup-name guard for opted-in rows).
- (b) needs a tool-property audit: do any of our tools persist state across calls that would diverge between replicas? `crm.issue_refund` is a write; running it on replica A vs B against the same backend is fine *if* the backend is the source of truth, but our mock customer service holds state in-memory per-process — that's a Type 1 child identity issue that would need to be resolved.
- (c) is a v2 concern.

**Connector-side implications of (a):**
- A new register-frame field: `role: "primary" | "standby"` (or just "any" + controller-assigned role in register-ack).
- The standby keeps the WS open and serves heartbeats, but expects no `rpc` frames. If it gets one, it forwards normally — being standby is just a controller-side dispatch hint, not a connector-side gate.
- Inspector UI shows the role.

**Crosses load-bearing rules?** No, but it puts pressure on a few of them:
- "Identity established at register-frame time" — still true; the row gets two sessions instead of one.
- The `connectors` row → session relationship becomes 1:N instead of 1:1. Schema migration on the controller side.
- Auto-reconnect logic ([packages/connector/src/tunnel/reconnect.ts](../../packages/connector/src/tunnel/reconnect.ts)) doesn't change.

**Open design questions:**
- **Q7.1** — Should (a) be opt-in per Tunnel Security row, default off? Recommend yes — single-replica is the common case and keeps the dup-name guard's safety value.
- **Q7.2** — Audit: which tools today are *not* idempotent-across-replicas? Run before promoting from (a) to (b).
- **Q7.3** — Does the standby get its own `INSPECTOR_PORT` view, or does the controller surface "the active connector's inspector"? Probably each replica has its own loopback inspector.
- **Q7.4** — How does this interact with Friction #5's controller-proxied inspector? The controller would need to pick "show me which replica's inspector" — usually the active one, but might be useful to inspect a standby that's silently broken.

**Test-suite hooks:**
- (a) ships → frame-router gains `role: "primary" | "standby"` parsing in register-ack handler.
- New phase-7 test: standby connector receives an `rpc` frame → dispatches normally (sanity, in case dispatch hint is ignored).
- The reconnect controller's `markAccepted` / `markRejected` semantics don't change — but a row that has a *peer* session from another replica might re-shape the rejection error codes (e.g. `name_taken_by_replica` instead of `name_taken`). Pin the new error in [tests/tunnel/frame-router.test.ts](../../packages/connector/tests/tunnel/frame-router.test.ts).

## Staged work breakdown

The seven workstreams above don't all need to ship together. Suggested ordering by leverage and risk — earlier stages are foundation; later stages depend on them.

| Stage | Workstream | Dependencies | Branch | Status |
|---|---|---|---|---|
| **Stage A** | **Friction #4** — `/livez` + `/readyz` on a separate `HEALTH_PORT`. | None. Smallest, lowest-risk. | `feature/health-endpoints` | not started |
| **Stage B** | **Friction #5 (pre-flight + error decoding)** — Inspector pre-flight panel; controller-error decoding table. | None (pure connector-side). | `feature/inspector-preflight` | not started |
| **Stage C** | **Friction #1** — Drop-in MCP directory with auto-discovery. Per-folder `npm install` cache. | None. | `feature/dropin-mcps` | not started |
| **Stage D** | **Friction #2** — Pick option (a/b/c). Implement. (b) is largest scope; (a) is docs-only.  | If (b): controller schema migration. | `feature/state-replay` (if b) or docs-only PR | not started |
| **Stage E** | **mTLS posture** — third auth posture in `resolveAuth`. PEM file paths via env. Cert reload on file-change deferred to v2. | None — clean addition to auth.ts. | `feature/mtls-tunnel` | not started |
| **Stage F** | **Friction #3** — Controller-proxied inspector. New frame variants. SSE-over-WS proxy. | Controller-side work. | `feature/inspector-proxy` | not started |
| **Stage G** | **WSS load balancing — option (a) active/passive.** Lift dup-name guard for opted-in rows; new `role` field in register frames. | Controller-side dispatch logic + schema migration. | `feature/wss-multi-replica` | not started |
| **Stage H** | **Helm chart + Terraform/Bicep modules.** Encode `replicas: 1` (or `2` post-Stage-G), readiness probe, `Service: ClusterIP` only, secret refs. | Stages A and D minimum. | `feature/iac-modules` | not started |
| **Stage I** | **Docs refresh.** Re-position OAuth2/mTLS as the recommended postures; add green/yellow/red platform list. Update each per-cloud guide for stages A–H. | All prior stages. | `feature/deploy-docs-refresh` | not started |

**Stages A–C are independent** and can land in any order. **Stage D should land before H** (Helm needs to know what state strategy to template). **Stage F depends on controller-side work** and is the highest external-dependency stage. **Stage G is the largest scope-of-impact** (multi-replica is a deployment-shape change) — defer until A–E ship and we have telemetry from real deployments.

**Recommendation: land A → B → C in that order as the first deploy-architecture release.** Three small PRs, all customer-visible improvements, no controller changes, no breaking changes. Then evaluate D–G based on what customer feedback surfaces.

## Open design questions (consolidated)

Carried forward across all stages — answers needed before each stage starts.

- **Q1.1–Q1.3** — Drop-in directory yaml shape, env isolation, coexist-vs-deprecate
- **Q2.1–Q2.3** — State persistence option, migration, register-ack shape
- **Q3.1–Q3.3** — Controller-proxied inspector SSE handling, opt-in scope, CLI fallback
- **Q4.1–Q4.2** — Readiness gate scope, default port number
- **Q5.1–Q5.3** — Setup panel persistence, destructive-action confirmation, pre-flight credential
- **Q6.1–Q6.4** — mTLS additive vs replacement, cert format, rotation, OAuth2 interaction
- **Q7.1–Q7.4** — Active/passive opt-in, idempotence audit, standby inspector, controller proxy interaction

## Cross-references

- [CLAUDE.md](../../CLAUDE.md) — Architecturally load-bearing properties (don't violate)
- [TEST-SUITE.md](TEST-SUITE.md) — Connector lifecycle map; env-var coverage; regression catalog. Every stage in this plan must add rows to the env-var coverage map and regression catalog as it lands.
- [TESTS_IMPLEMENTED.md](TESTS_IMPLEMENTED.md) — Inventory of landed tests (cross-pin when stage tests ship)
- [STATUS-CALLBACK-MCP.md](STATUS-CALLBACK-MCP.md) — Webhook ingress design (referenced by Friction #5's pre-flight panel)
- [OUTPUT-SCHEMA.md](OUTPUT-SCHEMA.md) — Reference structure for stage-by-stage plans (status header, branch convention, work-breakdown table)
- [docs/deploy/](../../docs/deploy/) — Per-cloud guides; updated by Stage I
- [packages/connector/Dockerfile](../../packages/connector/Dockerfile) — Build pipeline; touched by Stage C
- [packages/connector/src/boot/auth.ts](../../packages/connector/src/boot/auth.ts) — Auth posture dispatch; extended by Stage E
- [packages/connector/src/inspector/server.ts](../../packages/connector/src/inspector/server.ts) — Inspector HTTP server; extended by Stages B + F
- [packages/connector/src/state.ts](../../packages/connector/src/state.ts) — State persistence; touched by Stage D
- [packages/connector/src/tunnel/frame-router.ts](../../packages/connector/src/tunnel/frame-router.ts) — Frame dispatch; extended by Stages F + G






