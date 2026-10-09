# MULTI-PLATFORM-MCP — shim side

> **Status:** in progress on **`feature/multi-platform-mcp`** (cut from `main`), one commit per stage. Not merged, not pushed.
>
> | Stage | State |
> |---|---|
> | Plan | ✅ committed |
> | Phase 0 — approval gate at every entry point (§1) | ✅ committed. **Deviation from §1.2:** webhook *delivery* is gated, not `webhook-allocate`/subscribe — children subscribe at spawn, before approval, and the SDK rejects a refused stream with no retry |
> | Phase 3 — several instances per host (§4) | ✅ committed |
> | Phase 1 — protocol package (§2) | in progress. ✅ **`@gtmi/toolproxy-protocol@1.0.0` published to public npm 2026-10-09** (protocol 1.0 = today's wire; platform pins `~1.0.0`). Package home = `protocol/` workspace in this repo (D17); registry = public npm under the existing `@gtmi` scope. ✅ connector consumes it (log-only validation, `register.tunnelProtocol: "1.0"`, `supportedTunnelProtocol` → tolerant parsing); **zero violations against the live platform**. Remaining: switch to enforcing validation (later, after the platform adopts), and the 2.0 schema (Phase 2b + §2.5a) |
> | Phase 2a — `shimId` (§3.1) + dot-free server names on every source (§3.4) | ✅ committed. Local only: nothing new on the wire yet |
> | Phase 2b — id on `register` + qualified names + foreign-id rejection (§3.2–3.3) | not started; must flip in lockstep with the platform's `qualify()`/`reconcileOrg` change and needs `tunnelProtocol` (Phase 1) to select the parser |
> | Phase 2c — widen the gate to bundled + yaml (§3.5) | ✅ committed; **end-to-end verified 2026-10-09** against platform track D in a real browser — pending lane, approve, disable, and restart replay all pass. Clear to merge from both sides; the merge is the user's call |
> | Phase 6 — TunnelWorkspace (§5) | in progress. ✅ shared `PortAllocator` (§5.3) committed; the `TunnelWorkspace` extraction itself not started |
>
> **Companion to:** `AgenticProcedure` repo, `architectural-plans/MULTI-PLATFORM-MCP.md`, on branch `docs/multi-platform-mcp` (commit `544dd166`). That plan is the **platform** side and owns the decision table **D1–D16** (its §0). This document treats those decisions as settled and does not reopen them. Phase numbers here match that plan's §9.
>
> **Supersedes:** `architectural-plans/MULTI-ACCOUNT.md` (see §8).
>
> **Note on tracking:** `architectural-plans/` is gitignored for new entries (`.gitignore:74-79`). This one file was force-added on the user's instruction, so later edits to it are tracked normally.

Paths are relative to `connector/src/` unless prefixed. The prefix `platform:` means a path under `AgenticProcedure/server/src/`.

---

## 0. What the shim owns

Under D7 (the shim owns the protocol) and D8 (the shim owns tool names), most of the cross-repo contract work belongs to this repo. The platform consumes it. This plan covers:

| Phase (platform §9) | Shim deliverable | Decisions |
|---|---|---|
| **0** | The approval gate is enforced at dispatch, at `controller-call` and at `webhook-allocate` | §0.1 defect |
| **1** | A versioned Zod frame-schema package; strict validation; a `register.tunnelProtocol` handshake; manifest drift closed | D7 |
| **2** | `shimId`; id-qualified names `<id>.<server>.<tool>`; foreign-id rejection; dot-free server names; the gate widened to bundled and yaml servers | D1, D3, D8, D10, D11 |
| **3** | Several instances per host made safe (`HEALTH_PORT`, agentic-memory state); a deployment recipe for both shapes | D6 |
| **4, 5** | None (platform-only) | — |
| **6** | `TunnelWorkspace`, one per `controllers[]` entry | D5, D9, D13–D16 |

Housekeeping (§8): retire MULTI-ACCOUNT, fix `Done/MULTI-INSTANCE.md`, and fix CLAUDE.md's "zod schemas" claim.

---

## 1. Phase 0: enforce the approval gate at every entry point

### 1.1 The defect (it exists today)

The drop-in approval gate is enforced in exactly two places:

- **Manifest visibility.** `buildManifest` omits an unapproved drop-in (`manifest/build.ts:68-70`).
- **The inspector's own tool runner.** `lifecycle.ts:445`.

The **tunnel `Dispatcher`** checks only that the server exists (`dispatcher.ts:169-172`). A `tools/call` sent by name over the tunnel for an unapproved drop-in therefore executes. The same is true of:

- `prompts/get` (`dispatcher.ts:265`);
- the resource, completion and logging methods the dispatcher forwards;
- `controller-call`: the inspector route at `inspector/server.ts:1052` checks `isAuthorTwilio`, not approval;
- `webhook-allocate`: a child can allocate a public webhook URL before it is approved.

**Severity today:** low. There is one controller, and it is the same party that approves.

**Severity under D3 plus D9:** cross-org. Org B could call a tool that only org A enabled.

**Ordering:** this must land before Phase 2 widens the gate and before Phase 6 adds a second controller.

### 1.2 The change

1. **Give the Dispatcher a gate predicate.** Add `isServerEnabled?: (name: string) => boolean` to `DispatcherDeps` (`dispatcher.ts:20-33`). Wire it to the same predicate `buildManifest` uses.
   - **Check it immediately after `servers.get`** in every per-server route: `tools/call`, `prompts/get`, the `resources/*` methods, `completion/complete` and `logging/setLevel`.
   - **Error reply:** reuse `kind: "tool_not_found"` rather than inventing a new kind. An unapproved server is, from the controller's point of view, one that is not in its manifest. This also avoids disclosing that the folder exists. (D16 makes the folder list visible anyway, so this matters little, but the shape stays uniform.)
   - **Aggregate `*/list` methods** already read from the manifest (`listAllowedTools`, `dispatcher.ts:136-146`), so they are gated by construction. A test pins this.
2. **`controller-call`.** The inspector route resolves the calling MCP by its per-MCP token, and then additionally requires that MCP to be enabled. A bundled MCP that is not enabled cannot act on the platform.
3. **`webhook-allocate`.** Same rule: no allocation for a server that is not enabled. On `mcp-disable`, revoke the server's webhook.
4. **One predicate, in one place.** Today the "is this gated" decision is spread across three sites:
   - `manifest/build.ts:68`, which keys on `dropinSpecsByName`;
   - `lifecycle.ts:393`, which keys on `source === "local"`;
   - `describeGateMismatch` (`tunnel/approval-coordinator.ts:258-265`).

   Phase 0 introduces `ApprovalCoordinator.isEnabled(name)`. It returns true for un-gated servers and the approval state for gated ones. All five consumers call it. Phase 2's widening then edits exactly one function.

### 1.3 Tests

These go in `connector/tests/dispatcher/approval-gate.test.ts`:

- an unapproved drop-in's `tools/call` is refused, and `callTool` is never invoked;
- the same for `prompts/get` and `resources/read`;
- after `mcp-enable`, the call goes through; after `mcp-disable`, it is refused again;
- `controller-call` from an unapproved bundled MCP is refused (once Phase 2 gates bundled servers; until then, from a drop-in);
- `webhook-allocate` is refused for an unapproved server.

---

## 2. Phase 1: the shim owns the protocol (D7)

### 2.1 Where things stand

- **Frames.** `tunnel/frames.ts` (513 lines) is plain TypeScript interfaces. Inbound frames are cast, not validated (`tunnel/client.ts:174`, `JSON.parse(line) as InboundTunnelFrame`).
- **The platform's copy.** `platform:mcp/frames.ts` (617 lines) is a hand copy. It narrows by switching on the type string (`platform:mcp/frames.ts:571-594`).
- **Drift between the copies.**
  - Frame types: 26 on the shim, 25 on the platform. The only difference is `mcp-notification` (`tunnel/frames.ts:372`), which the shim parses but never emits.
  - Manifest shapes: the platform's are narrower. Its `ToolManifestServer` lacks `prompts`, `resources`, `resourceTemplates`, `capabilities` and `envKeys`. Its `ManifestDelta` is tools-only.
- **No protocol version.** The manifest's `version` is the build version (`CONNECTOR_VERSION`, default `dev`; `lifecycle.ts:96`). The v1.1–v1.4 labels exist only in `docs/MCP-PROTOCOL.md` (for example `:1551`).

### 2.2 The package

- **Name and location.** `@mcp-shim/tunnel-protocol`, a new workspace package at `protocol/` in this repo. It is the second workspace, next to `connector/`. This is the one deliberate exception to "npm workspaces, one package" (CLAUDE.md §Workspace shape). The connector stays private, while the protocol package is **publishable**, because the platform must consume it.
- **Contents:** Zod schemas only, plus the TypeScript types derived from them (`z.infer`). There is no runtime logic beyond `parseInbound(direction, text)` and the version helpers in §2.4. The package has no dependency on the connector, and the connector depends on it.
- **Source of truth.** The Zod schemas are the authority. `docs/MCP-PROTOCOL.md` remains the prose explanation and links each section to the schema export. A doc that disagrees with the schema is a doc bug.
- **Distribution.** It is published to the internal npm registry with semver that tracks `tunnelProtocol` (§2.4): the package's major.minor equals the protocol's major.minor, and its patch is for schema fixes that change no wire shape. The platform pins a range. A git dependency was rejected (fragile SHA pinning, and it builds on install); see platform plan §8.1.
- **Zod version.** Use the same major the connector already uses for `config.ts`, so that one copy is hoisted.

### 2.3 Validation rules ("tight")

- **Every inbound frame is parsed**, on both sides. The shim replaces the cast at `tunnel/client.ts:174` with `parseInbound("controller→connector", line)`. A parse failure is logged at `warn`, with the frame type and the Zod issue paths, **never with values**: frames carry credentials (`creds-response`) and tool arguments. The frame is then dropped. The WebSocket stays open, matching today's tolerance for unknown frames.
- **Strict within major.minor.** Objects are `.strict()` for every field the negotiated minor defines.
- **Unknown fields are tolerated only from a newer minor of the same major.** Each side knows the peer's minor from the handshake (§2.4). When the peer's minor is greater than its own, it parses with `.passthrough()` and strips the result; otherwise it parses `.strict()`. This keeps additive changes (which v1.1–v1.4 all were) deployable without a lockstep upgrade, while still catching typos and drift between peers on the same minor.
- **An unknown frame `type`** is rejected under the same minor, and tolerated (dropped with a `debug` log) from a newer minor.
- **Enumerated values stay open where they are open today.** `author` stays `z.string()`, not a union (CLAUDE.md: "forward-compats new author values"). The same goes for `register-ack.error.code`.

### 2.4 Version handshake

- **`register.tunnelProtocol: "<major>.<minor>"`** is a new top-level field on `RegisterFrame` (`tunnel/frames.ts:118`). Its name is deliberately *not* `protocolVersion`, which is already the negotiated MCP era on `ServerDescriptor` (`tunnel/frames.ts:90`).
- **The first value is `"2.0"`.** D′ naming (Phase 2) changes every tool name on the wire, so it is a breaking change. The 1.x labels in MCP-PROTOCOL.md are retro-labelled as protocol 1, with no shim sending `tunnelProtocol` at all. A register frame with **no** `tunnelProtocol` means "1.x"; the platform decides whether it still accepts that.
- **Refusing a version.** The platform answers an unsupported major with `register-ack { accepted: false, error: { code: "unsupported_tunnel_protocol", … }, supportedTunnelProtocol: { min: "2.0", max: "2.3" } }`.
  - `supportedTunnelProtocol` is new on `RegisterAckFrame` (`tunnel/frames.ts:137-144`) and is echoed on **every** ack, so the shim learns the peer's minor in order to apply §2.3's rule.
  - On the shim side, `unsupported_tunnel_protocol` is a sticky rejection. The frame router already treats any unrecognised error code as sticky (`tunnel/frame-router.ts:144,153`, `markRejected`), so this works today without code. Phase 1 still adds an explicit branch, so that the inspector says "controller requires tunnel protocol 2.0–2.3; this connector speaks 3.0" instead of a generic rejection.
- **The shim refuses a peer too.** If register-ack's `max` major is lower than the shim's major, the shim logs, sends `goodbye`, and marks the tunnel rejected. That is cheap symmetry, and it is what makes "the shim owns the protocol" checkable from both ends.

### 2.5 Closing the drift (toward the platform)

The schema package is cut from the **shim's** current shapes, which are the wider ones:

- `ServerDescriptor`: `prompts`, `resources`, `resourceTemplates`, `capabilities`, `envKeys` and `protocolVersion`.
- `ManifestDelta`: the `added/removed/changed{Prompts,Resources,ResourceTemplates}` arrays.
- **`mcp-notification`:** removed from the schema in 2.0. It is never emitted (CLAUDE.md §Wire protocol: superseded by §9.1/§9.4), and keeping a dead frame type in a strict schema invites someone to start using it.

The platform adopts the package and gains these fields; this repo does not narrow to match the platform's copy.

**Interim step (before the package ships):** the platform adds a contract test that diffs its frame-type set against the shim's (platform plan §8.1). On the shim side, a test asserts that the `type` literals in `tunnel/frames.ts` match the set in MCP-PROTOCOL.md, so the shim's own doc can't drift either.

### 2.5a Server metadata in `manifest-delta` (for 2.0) — found by the 2c end-to-end test

**The gap.** `diffManifest` (`manifest/diff.ts`) emits only `{server, tool}` per added entry. A server whose FIRST appearance is a delta therefore arrives with no `author`, `transport` or `protocolVersion`. Before Phase 2c that never happened — every server was in the register manifest. Gating made it the normal path for every bundled server: approve one, and its tools arrive by delta. The platform then created the server with no author and defaulted it to `customer`, so `sample`'s tools came out `customer.sample.*` instead of `twilio.sample.*` (2026-10-09, platform check 2).

**Trust is not affected on the connector.** `supervisor.isAuthorTwilio` reads the supervisor entry's author, set at spawn from the scan marker — never from the wire — so controller-call authorisation is correct regardless. The impact is the platform's author-driven decisions and the tool-name prefix.

**Interim (platform, shipped as AgenticProcedure `93738125`, verified live — `sample` now `twilio.sample.*`):** take the author from the cached `mcp-discovered` when a delta adds an unknown server; otherwise fall back to `customer`, and **never** to `twilio`. An earlier draft proposed failing closed (holding out a server with no known author). That was wrong: Type 2 (controller-pushed) servers are never gated, so they never send `mcp-discovered` and always arrive by delta with no author — and v1.2 drop-ins rely on legacy auto-approve as `customer`. `customer` is already the safe trust direction.

**2.0 fix (shim, this phase):** a server-level block in `ManifestDelta`, e.g. `addedServers?: Array<{name, transport, author, protocolVersion?}>` and `removedServers?: string[]`, emitted whenever a server appears or disappears. Per-server, not repeated on every tool entry, because author is a property of the server. It also gives `protocolVersion` a home in deltas (register-only today). Lands in the package's 2.0 schema with Phase 2b.

### 2.6 Phase 1 tests

- **Round trip:** every frame the connector emits today parses against the package schema. The test drives a real boot through `tests/helpers` and captures `tunnel.send`.
- **Version tolerance:** an extra field is rejected at the same minor and accepted (and stripped) from a newer minor.
- **Refusal:** `unsupported_tunnel_protocol` produces a sticky rejection, no auto-reconnect, and the inspector message.
- **No values in logs:** a malformed `creds-response` logs paths, not values. This extends `tests/logger/redact.test.ts`.

---

## 3. Phase 2: shim identity in tool names, and the widened gate (D1, D3, D8, D10, D11)

### 3.1 `StoreDoc.shimId`

- **Field.** Add a top-level `shimId: string` to `StoreDoc` (`config-store/store-file.ts:95-108`), and bump `version`.
- **Why a new field.** Nothing existing can serve:
  - `keyFingerprint` (`:98`) changes on key rotation, and it is derived from a secret;
  - `controllers[].id` is a `randomUUID` per controller entry (`config-store/index.ts:209`), not per shim;
  - there is no install id.
- **Format.** 8 characters of **lowercase Crockford base32** (alphabet `0123456789abcdefghjkmnpqrstvwxyz`), which is 40 bits from `randomBytes(5)`.
  - Lowercase only, so the id is safe under any case-insensitive handling.
  - Crockford drops `i l o u`, so a human reading it aloud can't confuse characters.
  - Every character is in OpenAI's tool-name alphabet `[a-zA-Z0-9_-]`.
  - At 40 bits, the birthday collision rate is about 1 in 10⁶ at 1,500 shims in one org. The platform's per-org duplicate guard (§9) turns that residual case into a visible refusal.
- **Minting.**
  - A new install mints the id in `emptyDoc()` (`store-file.ts:110-119`). `open()` already writes the initial document at boot (CLAUDE.md §Config files), so the id exists before any tunnel is configured.
  - An existing store is back-filled: a document read without `shimId` is assigned one inside `ConfigStore.mutate` (the read happens inside the lock) and written once.
  - **The id is never re-minted silently.** A corrupt or unparseable store already throws rather than reading as a fresh install, and that property is what protects the id. Keep it.
- **Lifetime.**

  | Event | `shimId` |
  |---|---|
  | Restart, image upgrade, redeploy onto the same volume | kept |
  | Master-key rotation | kept (it is not sealed, and not derived from the key) |
  | Volume lost, then a fresh install | **new id**, so the platform must migrate refs ("re-adopt", §9) |
  | Volume cloned | **duplicate id**. The shim can't detect this locally; the platform's per-org guard refuses the second registration |

- **"Regenerate id."** A new inspector action, `POST /internal/identity/regenerate`, loopback-only and CSRF-guarded like every other state-changing POST.
  - It mints a new id, persists it, and redials every tunnel.
  - It is the documented fix for a cloned volume.
  - The confirmation copy must say that every procedure ref to this shim's tools breaks until the platform migrates them.
- **Not secret, not sealed.** The id appears in every tool name, so treating it as a credential would be wrong. It sits next to `keyFingerprint` in plaintext.

### 3.2 Carrying the id: once on register

- **Field.** `register.shimId` is new and top-level, with the same shape everywhere: it is identical across every controller the shim connects to (D13 means the platform doesn't surface that).
- **Descriptors stay bare.** `ServerDescriptor.name` and `ToolDescriptor.name` stay unqualified, as today. Repeating the id in every tool of every manifest and delta would be redundant, and redundant fields can disagree.
- **The composition rule is defined by the schema package** (D8: the shim decides; the platform applies the rule mechanically). The package exports `qualifyToolName(shimId, server, tool) → "<shimId>.<server>.<tool>"` and its inverse, and both sides use them.
- **No author prefix (D11).** The `twilio.` / `customer.` prefix disappears from the name. `author` remains a field on `ServerDescriptor`, and it is the only place author lives. `isAuthorTwilio` (`mcp-supervisor.ts:362`) already reads the supervisor entry, never the name, so the shim's code-trust gate is unaffected.
- **Length budget.** The OpenAI function-name limit is 64. The platform maps `.` to `_`, giving `<8>_<server>_<tool>` and leaving **54 characters for server + tool**. That is 10 more than today's `customer_` + server + `_` + tool. The schema package validates the composed length and rejects an over-long tool at manifest build, with an error naming the tool. This mirrors validate.ts's per-tool, non-fatal handling: the tool is withheld, the rest of the server ships.

### 3.3 Inbound names and the foreign-id check

- **Inbound form.** `tools/call` and `prompts/get` arrive as `<shimId>.<server>.<tool>`. The dispatcher's first-dot split (`dispatcher.ts:158`, `:265`) is replaced by the package's parser:
  1. split on the **first** dot: the id;
  2. split the rest on its **first** dot: the server;
  3. the remainder is the tool, which may itself contain dots (the MCP spec allows them).
- **Foreign id.** If the id is not this shim's own, the dispatcher replies `kind: "tool_not_found"` and logs at `warn`, naming both ids. A misrouted call becomes a visible error instead of a call to whichever local server happens to share the name.
- **Transition.** Under `tunnelProtocol` 1.x (no `shimId` sent), keep accepting the bare `<server>.<tool>` form. Under 2.x, only the qualified form is accepted. The negotiated major selects the parser, never a guess from the shape of the string.

### 3.4 Dot-free server names, enforced everywhere

- **Today only drop-ins are validated:** `MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i` (`dropin.ts:89,180`). Yaml names and controller-pushed Type 2 names (`tunnel/mcp-config-coordinator.ts`) are not, so a pushed name containing a `.` would break the three-part parse.
- **Change.** The schema package exports `serverNameSchema`, with the drop-in regex as the rule. The connector applies it in three places:
  - `loadConfig` (yaml): a boot error naming the entry;
  - the drop-in scanner: unchanged behaviour, now sourced from the package;
  - the mcp-config coordinator: an `mcp-config-ack` per-MCP `skipped` with `error: "invalid_server_name"`.
- **Case.** The regex is `/i`. Phase 2 lowercases nothing silently, but it rejects two servers on one shim whose names differ only in case, because some consumers lowercase.

### 3.5 Widening the gate to bundled and yaml servers (D3, D10)

- **The rule after Phase 2:** every server the shim runs itself (bundled, drop-in, yaml-listed) is **gated**. It ships available but inactive, and it is withheld from the manifest and refused at dispatch until `mcp-enable`.
- **Type 2 stays exempt.** A controller-pushed MCP already implies the operator's consent (the platform operator configured it), so a second gate would be a double click for nothing.
- **Code changes.** Phase 0 put the decision in one predicate, so Phase 2 changes it from "drop-in ⇒ gated" to "`source !== "controller-config"` ⇒ gated". Then:
  - `mcp-discovered` is emitted for every gated server, not just `source === "local"` (`lifecycle.ts:393`);
  - `describeGateMismatch` (`tunnel/approval-coordinator.ts:258-265`) stops rejecting yaml servers.
- **Gating is about visibility, not the process.** Gated children still spawn at boot (until Phase 6's lazy spawn), list their tools, answer `/envkeys` and receive creds. That is what lets `mcp-discovered` carry a real tool list. A gated **agentic-memory** keeps running; it just isn't in the manifest and can't be dispatched to. With Phase 0, it also can't make a `controller-call` until it is enabled.
- **Approvals stay in RAM (D10).** The platform replays `mcp-enable` after every `register-ack` (MCP-PROTOCOL.md:61, `:1352`). Nothing is persisted in `config.json`.
  - **Consequence to document:** after a shim restart, every server is dark until the platform replays. For bundled servers this is newly visible, because today they never go dark. The window is one round-trip after `register-ack`.
  - If that window ever matters, the fix is platform-side: replay faster, or batch the enables in the ack. It is not shim persistence.
- **Wire.** `mcp-discovered` already carries `mcp`, `envKeys` and `tools`. Phase 2 adds `author` and `source` (`"bundled" | "local" | "yaml"`), so the platform can show "Twilio-shipped" versus "customer drop-in" in the pending lane without parsing names (D11).
- **Migration.** The first shim that speaks 2.0 makes every bundled server go dark until enabled. The platform must either pre-seed approvals for that connector's bundled servers during the ref migration (§9), or accept that an operator re-enables them once. This is listed under platform dependencies, because the shim can't decide it.

### 3.6 Phase 2 tests

- **`shimId`:** minted on a fresh store, back-filled on an old store, stable across reopen, not changed by key rotation, and changed only by regenerate.
- **Names:** composition and parsing round-trip with dots inside the tool name; a foreign id is refused; the bare form is accepted under 1.x and refused under 2.x.
- **Validation:** an invalid server name is refused from each of the three sources; an over-long composed name is withheld, and only that tool.
- **Gate:** a bundled server is withheld until `mcp-enable`, and the yaml server likewise; a Type 2 server is never gated; agentic-memory spawns while gated.

---

## 4. Phase 3: several instances per host (D6)

D6 makes "one shim per host" and "N shims on one host" equally supported. A separate container per shim is already clean, because each has its own network namespace and volume. **Bare processes on one host collide in two places**, and both become requirements:

| Clash | Today | Fix |
|---|---|---|
| **`HEALTH_PORT`** | Defaults to 9100 for every instance (`boot/lifecycle.ts:105`). The second instance's bind fails with `EADDRINUSE`, which is only logged (`health/server.ts:181-184`), so a probe on 9100 reads instance 1's `/readyz` | (a) `scripts/start-connector.sh` derives `HEALTH_PORT=$((9100 + PORT - 9090))` next to `MCP_BASE_PORT` (`:195-197`). (b) A health bind failure becomes **fatal at boot** when `HEALTH_PORT` was set explicitly; with the default it stays a loud `error`. A silent second instance reporting someone else's readiness is worse than a crash |
| **agentic-memory state** | Defaults to `<module dir>/.state.json` (`bundled-mcps/agentic-memory/state.ts:93-96`), so every dev instance shares one file. The image sets `AGENTIC_MEMORY_STATE_PATH` under `/var/lib/mcp-connector` (`Dockerfile:152`), so containers are fine only because each has its own volume | Phase 3 interim: start-connector.sh exports `AGENTIC_MEMORY_STATE_PATH=$CONNECTOR_STATE_DIR/../agentic-memory-$PORT/.state.json`. **Phase 6 supersedes this** with `MCP_STATE_DIR` (§5.3), injected per child by the supervisor, and the per-MCP env var becomes a fallback |

**Already separated per instance:** `INSPECTOR_PORT`, `MCP_BASE_PORT` (+100 per port) and `CONNECTOR_STATE_DIR` (`start-connector.sh:195-197`).

**Shared, but harmless:** the read-only `MCP_DROPIN_DIR` and `MCP_BUNDLED_DIR`. Approvals are in RAM per process, which is correct.

**A shared master key** across instances on one host is allowed, because the fingerprint check is per store file. The recipe still recommends one key per instance.

### 4.1 The deployment recipe

The recipe goes in `deploy/MULTI-INSTANCE.md`, a new customer-facing doc with no links to plans (CLAUDE.md / memory: no plan references in customer docs). It covers two shapes:

1. **N containers (recommended).** Per instance: one volume at `/var/lib/mcp-connector`, one `CONNECTOR_KEY_B64`/key file, and its own Configure Tunnel. Memory: about 1 GB per instance with the shipped image (§7). With docker-compose, use N services with distinct volume names and distinct `127.0.0.1:<port>:9090` inspector bindings (`deploy/compose/docker-compose.prod.yml`'s binding is load-bearing, so keep the loopback prefix).
2. **N bare processes (systemd or similar).** Per instance, set distinct values for `INSPECTOR_PORT`, `HEALTH_PORT`, `MCP_BASE_PORT` (100 apart), `CONNECTOR_STATE_DIR` and `AGENTIC_MEMORY_STATE_PATH` (until Phase 6), plus a key file. A table lists every port and path each instance must own.

`mcp-connector doctor` gains a check: if `HEALTH_PORT`'s holder answers `/livez` but is not this process, report `fail` with "another connector holds HEALTH_PORT". This reuses the "ask the holder who it is" pattern from the `inspector-port` check.

---

## 5. Phase 6: one workspace per tunnel (D5, D9, D13–D16)

### 5.1 Shape

```
connector process — one shimId, one config store, one inspector, one health server,
                    signal handlers, one PortAllocator, one DiscoveryCache
├── shared, read-only: MCP code on disk; drop-in scan; cached {tools, envKeys} per folder
├── TunnelWorkspace(controllers[0].id)
│     TunnelClient · ReconnectController · heartbeat/discovery timers · registration token
│     McpConfigCoordinator (+generation) · ApprovalCoordinator · CredsCoordinator
│     WebhookRegistry · ControllerApiCoordinator · Dispatcher · McpSupervisor
│     LocalMcpsCoordinator view (reconciles against the shared scan)
│     children: started on mcp-enable (startOne), stopped on mcp-disable
│     storage: ${CONNECTOR_STATE_DIR}/controllers/<entryId>/<mcp>/
└── TunnelWorkspace(controllers[1].id) — same shape, shares nothing mutable with [0]
```

**A workspace is identified by its `controllers[]` entry id** (`config-store/index.ts:209`), per D15:

- adding a controller in the inspector creates a workspace;
- removing one stops its children and deletes its storage directory;
- rotating the entry's credential keeps the workspace.

### 5.2 Extracting `TunnelWorkspace`

- **Where the state lives today.** Today's single-tunnel state is closure variables inside `bootFromDb` (`boot/lifecycle.ts`, 955 lines): `tunnel`/`controllerApi`/`row`/`auth` at `:123-132`, the timers at `:192-193`, and `reconnectCtl` at `:197`. None of it is module state; the module-level values are immutable (`mcp-supervisor.ts:86,116,166`, the loggers, `auth/jwt.ts:89`'s URL-keyed JWKS cache). So the extraction is mechanical.
- **New module.** `boot/workspace.ts` exports `class TunnelWorkspace { constructor(entry, shared); start(); stop(reason); }`. `shared` carries the process-level services from §5.1.
- **`bootFromDb` becomes:** open the store, start the process services, run `for (const entry of doc.controllers) workspaces.set(entry.id, new TunnelWorkspace(entry, shared))`, and wire the inspector. The empty-store path is now N = 0, with no special branch.
- **TDZ test.** `tests/boot/lifecycle-tdz.test.ts` guards the empty-store early return. With N = 0 there is no early return, so the test is **retired deliberately** in the same commit, and its replacement asserts that adding the first controller after boot starts a workspace.
- **Store API.** `getController()` / `upsertController()` (`config-store/index.ts:163-233`) are replaced by `listControllers()`, `addController()`, `updateController(id)` and `removeController(id)`. The per-id helpers at `:241-274` already use `.find(x => x.id === id)`. The mutex and atomic write are unchanged.
- **Process-wide by nature:**

  | Item | Today | Phase 6 |
  |---|---|---|
  | `SIGHUP` / `SIGTERM` / `SIGINT` | `lifecycle.ts:491,530-531` | Registered once; fan out `reload()` / `stop()` to every workspace, in parallel, with the existing 2 s SIGKILL fallback per child |
  | Health server | One, `lifecycle.ts:170` | One. `/readyz` aggregates (§5.7) |
  | Inspector | One | One, holding a `Map<entryId, WorkspaceView>` (§5.8) |
  | `max_concurrent_calls` | Per `Dispatcher` (`dispatcher.ts:36,175`) | Stays per workspace, so the process total is N×. That is deliberate: one tenant can't starve another. A process-wide cap is a later option, not a default |

### 5.3 Children: shared port allocator, `MCP_STATE_DIR`, lazy spawn

- **Port allocator.** `McpSupervisor` keeps `reservedPorts` per instance (`mcp-supervisor.ts:1077`) and probes with `canBind` at spawn time (`:1180`). Two supervisors probing concurrently can both choose the same free port, and the second child fails `EADDRINUSE` at listen.
  - **Fix:** a `PortAllocator` with an async `reserve()` / `release(port)`, serialised by a promise-chain mutex (the same pattern as `ConfigStore.mutate`), shared across supervisors and injected through `SupervisorOpts`.
  - The probe host stays `127.0.0.1`, matching `LOOPBACK_BIND` (CLAUDE.md: the probe must test the same host the child binds).
- **`MCP_STATE_DIR`, the write contract.**
  - `mergeEnv` already injects supervisor-owned keys after every user layer (`mcp-supervisor.ts:1066-1071`). Add `MCP_STATE_DIR=${CONNECTOR_STATE_DIR}/controllers/<entryId>/<mcp>`, created with mode 0700 before spawn.
  - Document it in `docs/AUTHOR-LOCAL-MCP.md` as **the** place an MCP may write. `/app` is root-owned and nothing else is promised.
  - agentic-memory reads `MCP_STATE_DIR` first, then `AGENTIC_MEMORY_STATE_PATH`, then its module-relative fallback. It is the only bundled state writer (`state.ts:93-96,140-145`); the salesforce caches are in-memory only (`examples/demos/salesforce/lib/client.ts:20`, `resources/schema-cache.ts:15`).
  - `entrypoint.sh` already chowns `state/`, so `state/controllers/` is covered by nesting. `tests/deploy/entrypoint.test.ts` gains an assertion.
- **Lazy spawn.**
  - Today `startAll()` is eager (`lifecycle.ts:420`, `mcp-supervisor.ts:379`). The API already separates the two steps: `registerOne` registers without spawning (`:571`) and `startOne` spawns (`:601`).
  - Under Phase 6, a workspace registers every gated spec at start and calls `startOne` on `mcp-enable` (and `stop` on `mcp-disable`).
  - Type 2 entries spawn on roster add, as today. They are exempt from the gate, so a pushed entry is an enabled entry.
- **Cached discovery payload (D16).**
  - `mcp-discovered` needs `tools` + `envKeys`, which today come from a live child (`lifecycle.ts:398-405`). With lazy spawn there is no child before enable.
  - **`DiscoveryCache`:** process-level, keyed by folder real path plus a content hash of `tools/`, `prompts/` and `resources/`. It spawns the folder once in an anonymous scratch supervisor, with **no** controller env and its own temp `MCP_STATE_DIR`, then reads `/envkeys`, runs `listTools`, and stops the child.
  - Every workspace emits `mcp-discovered` from the cache. The cache describes code, not a tenant, so sharing it is safe.
  - The cache is invalidated by `local-mcps-rescan` when the hash changes.
  - **A tool list that depends on creds** (conditional registration, MCP-PROTOCOL.md §"Conditional tool registration") is under-reported in the cache. The real list ships in the manifest after enable and creds. Document this rather than solve it.
- **Idle reaping:** deferred. Lazy spawn bounds the cost to what each tenant enabled.

### 5.4 Credentials, approvals, webhooks, roster: unchanged code, per workspace

Each of these is instantiated once per workspace, with today's keys: `controllerEnv` by MCP name (`mcp-supervisor.ts:242,417`), `approved: Set<name>` (`tunnel/approval-coordinator.ts:75`), `subs: Map<mcp>` (`tunnel/webhook-registry.ts:76`), and the roster and `lastAppliedGeneration` (`tunnel/mcp-config-coordinator.ts:106-111`). **No map is re-keyed.** That is the point of D14: a missed `(controllerId, mcp)` key cannot exist, because there is no such key.

### 5.5 Controller-call routed by the per-MCP token

- **Today.** Each supervisor mints a 256-bit `webhookToken` per MCP (`mcp-supervisor.ts:325`), injected as `MCP_WEBHOOK_TOKEN`. The inspector resolves token → mcp (`:348`, `inspector/server.ts:550`).
- **Phase 6.** The inspector resolves token → `(entryId, mcp)` by asking each workspace's supervisor. The `/internal/controller-api/call` route (`inspector/server.ts:1052`) and the webhook stream route then dispatch to **that workspace's** `controllerApi` and `WebhookRegistry`.
- **Effect.** Every controller-call has an origin, including webhook-driven calls that have no originating `tools/call`. The SDK (`sdk/controller-api.ts`, `sdk/webhook.ts`) is unchanged: children still find the one inspector through `INSPECTOR_PORT`.
- **Uniqueness.** Two workspaces minting the same token is a 2⁻²⁵⁶ event. A lookup that matches more than one workspace fails closed anyway.

### 5.6 Machine API: bound by credential

- **API clients.** Add `controllerId` to `ApiClientDoc` (`config-store/store-file.ts:81-87`). A self-issued token's `sub` resolves the client, the client's `controllerId` selects the workspace, and the `/v1/*` route uses that workspace's `ControllerApiCoordinator`.
  - The paths don't change, so `NON_LOOPBACK_ALLOWED_PATHS` (`inspector/server.ts:1004`) is untouched, along with its exhaustive test.
  - **Existing clients** (with no `controllerId`) bind to the single controller on back-fill when N = 1. When N > 1 they are refused with `invalid_client`, plus a log naming the fix.
- **Trusted issuers.** Each controller entry gets its own trusted issuer (`trustedIssuer` moves from one top-level record into the entry), with its own audience. `verifyAccessToken` checks `aud` equality (`auth/jwt.ts:136`) against **the entry the token claims**.
  - **Routing a federated token.** It carries no `sub` → client mapping, so the workspace is the entry whose `iss` + `aud` match. Two entries configured with the same `iss` + `aud` are rejected at configure time. One IdP must not mint tokens valid for two tunnels.
- **Network access.** `networkAccess.enabled` stays process-wide. It describes the listener, not a tenant.

### 5.7 Aggregate health

- **`/livez`:** unchanged. It never consults any tunnel.
- **`/readyz`:** ready iff `configLoaded` and **no workspace has a child in `restarting`/`stopped` that it was asked to run**. The rule is unchanged in spirit (`permanently-failed` never gates). Two things about tunnels:
  - **A workspace's tunnel state does not gate readiness.** Under D5, one tenant's controller outage must not take the shim out of rotation for the others.
  - With **zero** workspaces, the reason stays `tunnel_not_open`, preserving the "a fresh deploy is deliberately not ready" property and its long grace.
- **Per-workspace detail** goes to the inspector, not to `/readyz`. The health server still has two routes and discloses a boolean plus a reason (`tests/health/server.test.ts`).

### 5.8 Inspector: per-workspace views

- **The model.** The single-valued setters (`setState`, `setManifest`, `setMcpStatuses`, `setIdentity`, `setHeader`, `recordTap`; `inspector/server.ts:280-337`) and the single `toolDispatch` / `mcpActions` (`:189,193`) become `inspector.workspace(entryId).<setter>`.
- **Routes.** Workspace-scoped routes take `?ws=<entryId>`. A missing `ws` with N = 1 means "that one"; with N > 1 it is `400`.
- **UI.** A workspace picker in the header, with each workspace's tunnel state shown as a pill. Per workspace: MCP Status, Frames, Webhooks, session creds, and the message tap, whose ring is per `(ws, mcp)`. Process-level: the Tunnels list (add / edit / remove / rotate), Network Access, and API clients, each client showing its bound workspace.
- **"Configure Tunnel" becomes "Add controller".** It is the same modal, writing a new `controllers[]` entry.
- **Session creds:** per `(ws, mcp)`, with the 12 h TTL unchanged.

### 5.9 Accepted property (D15): a workspace is not an OS boundary

All workspaces run as one OS user (`mcp`) in one network namespace. Consequences:

- a controller-pushed `stdio` server can run any command;
- a pushed `http` entry can reach any sibling workspace's child on loopback (`/mcp` is unauthenticated; MCP-AUDIT #1a);
- any child can read any workspace's `MCP_STATE_DIR`.

**This is accepted. Nothing is turned off by default.** The trust anchor is the shim owner, who chooses which controllers' credentials to accept (D5, D9). A shim owner who needs OS-level separation between controllers runs separate instances (Phase 3), which the OS isolates. This is written into CLAUDE.md as a load-bearing property in the same commit, so nobody later "fixes" it by adding hardening defaults D15 rejected.

Also accepted, and documented:

- **Blast radius:** one crash or OOM takes down every workspace.
- **One image version for all workspaces:** a controller that refuses this shim's `tunnelProtocol` (§2.4) is refused for that workspace only, and the others keep running.

### 5.10 Phase 6 tests

- Two workspaces each receive an `mcp-config-snapshot` with the same MCP name; there is no collision, and the generations are independent.
- An approval in A is not visible in B's manifest or dispatch.
- Creds pushed to A don't restart B's child.
- Concurrent spawns in two workspaces get distinct ports (the allocator under contention).
- agentic-memory writes under each workspace's `MCP_STATE_DIR`.
- A controller-call from B's child reaches B's tunnel only, including a webhook-driven one.
- An API client bound to A can't drive B; a federated token matching A's issuer can't drive B.
- `/readyz` stays 200 with A's tunnel down and B's up; with zero workspaces it is 503 `tunnel_not_open`.
- SIGTERM stops every workspace's children.
- Removing a workspace deletes its storage directory.

---

## 6. Optional cost item: drop the demo MCPs from the production image

The Dockerfile copies `examples/demos/{sample,crm,salesforce}` into `bundled-mcps/` (`connector/Dockerfile:56-58`). Each running Type 1 child is about 120 MB (tsx wrapper + node + esbuild; CLAUDE.md §Distribution), so the shipped image needs about 493 MB with all four bundled servers up. Under Phase 6 that becomes up to 480 MB **per workspace**.

**Proposal:** ship only `agentic-memory` in the production image. Move the demos to a `-demo` image tag, or behind a build arg (`--build-arg WITH_DEMOS=1`), that the Twilio-demo Fly deploy uses.

- **Effect:** about 120 MB per fully enabled workspace, and the 1 GB minimum (`tests/deploy/scaffold.test.ts`) gets real headroom.
- **Cost:** the Fly demo build path changes, and `deploy/fly/` docs must say which tag to use.
- **Decision needed from the user;** this is not a D-number yet. Under D3 the demos ship inactive anyway, so they cost nothing until enabled. Lazy spawn (§5.3) already contains most of the cost, which makes this a nice-to-have rather than a blocker.

---

## 7. Costs

| | Memory | Notes |
|---|---|---|
| Connector process, no workspaces | about 50–80 MB | Today's baseline without children |
| Idle workspace (nothing enabled) | kilobytes + one WebSocket | Lazy spawn (§5.3) |
| Each enabled Type 1 child | about 120 MB | Three processes per tsx child |
| Workspace with all four bundled servers enabled | about 480 MB | About 120 MB if §6 is adopted |
| DiscoveryCache scratch spawn | about 120 MB **transient**, per folder | At boot and on rescan, one folder at a time |

---

## 8. Housekeeping

### 8.1 Retire `architectural-plans/MULTI-ACCOUNT.md`

D14 supersedes it. **Don't edit it in place:** prepend a status banner pointing here, and move it to `architectural-plans/Done/` as *superseded* (not *shipped*). Its re-keying body (supervisor scopes, `entriesVisibleTo`, `name_collides_with_shared`, first-controller-wins webhooks) and its Postgres-era store design are obsolete. What survives, now owned by this plan:

| MULTI-ACCOUNT item | Here |
|---|---|
| Phase 1: `controllers[]` store shape | Already in `main` (DB-TO-FILE); §5.2's store API |
| Phase 3: N `TunnelClient`s, the "Add controller" inspector flow | §5.2, §5.8 |
| Per-controller registration tokens (MULTI-ACCOUNT.md:612) and per-tunnel reconnect (:624) | Inside each workspace, unchanged |
| Phase 6: inspector polish | §5.8, aimed at per-workspace views |
| Phase 7: audit log, master-key rotation command | **Not in this plan.** Still worth doing, and orthogonal. Leave them as a follow-up note in the banner |
| Ownership matrix, Type 2 private vs shared Type 3 | **Gone.** Nothing is shared between workspaces except read-only code |

### 8.2 Fix `architectural-plans/Done/MULTI-INSTANCE.md`

Lines 21-23, 34-41, 57, 61-62, 66, 72 and 79 describe a per-port `POSTGRES_SCHEMA`. After DB-TO-FILE the mechanism is a per-port `CONNECTOR_STATE_DIR` (`.local/state-<port>`, `start-connector.sh:197`). Replace the schema text with that, add a pointer to Phase 3's `HEALTH_PORT` / agentic-memory fixes, and point readers at `deploy/MULTI-INSTANCE.md` once it exists. That is a plan-doc edit only.

### 8.3 Fix CLAUDE.md's "zod schemas" claim

At `CLAUDE.md:91`, "Connector-side zod schemas in connector/src/tunnel/frames.ts match it" is false. Those are plain interfaces, and inbound frames are cast (`tunnel/client.ts:174`).

- **Before Phase 1 ships:** reword it to "TypeScript interfaces (not validated at runtime) in …".
- **After Phase 1:** rewrite it to point at the protocol package.

This is listed as a **follow-up for the user to approve**, because it edits CLAUDE.md and this branch is docs-only by request.

Also, once each phase ships, CLAUDE.md gains entries under **"Architecturally load-bearing properties"**:

- the gate is enforced at dispatch (Phase 0);
- `shimId` is never re-minted silently (Phase 2);
- the `MCP_STATE_DIR` contract (Phase 6);
- the workspace is not an OS boundary, by decision (Phase 6, D15).

This follows the "docs before merge" rule.

---

## 9. Platform dependencies

### 9.1 What the shim needs from the platform

| Phase | Need |
|---|---|
| 0 | Nothing. This is a shim-only fix, and the platform never sends calls for unapproved servers today |
| 1 | Adopt `@mcp-shim/tunnel-protocol`, replacing `platform:mcp/frames.ts`. Validate inbound with it under §2.3's rules. Send `supportedTunnelProtocol` on every `register-ack`, and refuse an unsupported major with `unsupported_tunnel_protocol`. Gain the manifest fields the shim already sends (`prompts`, `resources`, `resourceTemplates`, `capabilities`, `envKeys`, and the delta's prompt/resource arrays) |
| 1 (interim) | A contract test diffing frame-type sets until the package lands |
| 2 | Compose names with the package's `qualifyToolName`; stop prepending `<author>.` at `qualify()` (D8, D11) |
| 2 | Key `reconcileOrg` on the manifest's `author` field, not on the `customer_` / `twilio_` / `sendgrid_` name prefixes (`platform:bootstrap/buildTerminator.ts:69-72`, D11) |
| 2 | **Per-org duplicate-`shimId` guard:** a second live connector in the same org registering an id that is already live is refused with a sticky `register-ack` error such as `shim_id_taken`. Cross-org duplicates are legitimate (D9) |
| 2 | **Ref migration:** on a connector's first 2.0 register, rewrite that org's refs from `customer.<server>.<tool>` / `twilio.<server>.<tool>` to `<shimId>.<server>.<tool>`, and recompile the classifier rules and the routing index. That is safe only while the org has one connector. Also define "re-adopt", for an operator re-pointing refs from an old id to a new one after a volume loss or a regenerate |
| 2 | **Bundled servers going dark on upgrade:** either pre-seed approvals for a migrating connector's bundled servers during ref migration, or accept a one-time operator re-enable. The platform decides; the shim behaves the same either way |
| 2 | Show the pending lane for bundled and yaml servers, using `mcp-discovered.author`/`source`, and keep replaying `mcp-enable` after every `register-ack` (D10) |
| 6 | Nothing new. Each workspace is an ordinary tunnel (platform plan §5.3), and the platform never surfaces shim sharing (D13) |

### 9.2 What the platform needs from the shim

| Phase | Deliverable |
|---|---|
| 0 | The approval gate enforced at dispatch, `controller-call` and `webhook-allocate`, which is a precondition for the platform's D3 and D9 work |
| 1 | A published, versioned protocol package; `register.tunnelProtocol`; the shim handling `unsupported_tunnel_protocol` |
| 2 | `register.shimId`; the composition rule in the package; the dispatcher accepting only qualified names under 2.x; dot-free server names on every source; `mcp-discovered.author`/`source` |
| 3 | Nothing wire-visible |
| 6 | Nothing wire-visible: N ordinary tunnels |

---

## 10. Open questions (shim side)

1. **Protocol package home.** Should it be a second workspace in this repo (proposed), or its own repo? A second workspace keeps the schema next to the code that emits it. Its own repo makes the platform's dependency cleaner and avoids publishing anything from a repo that ships a carve-out to customers (`feature/customer-repo-carve-out`): does the carve-out need to exclude `protocol/`, or include it?
2. **Which registry.** The internal npm registry, or GitHub Packages? This is an org-policy question, like the CI notes in CLAUDE.md about `allowed_actions`.
3. **The 1.x window.** How long does a 2.0 shim keep accepting the bare `<server>.<tool>` form against a 1.x platform, if at all? The proposal is "only when the platform sent no `supportedTunnelProtocol`", meaning an old platform, and dropping it once both sides ship 2.0.
4. **What `regenerate id` does to live tunnels.** The proposal redials immediately. Alternatively it could take effect on the next restart, so an operator can coordinate the platform-side re-adopt first.
5. **Demo MCPs in the production image** (§6): drop them, put them behind a build arg, or keep them?
6. **Discovery cost at scale.** One scratch spawn per folder per content change is cheap for 4 folders and expensive for 40. Is there a folder-count threshold where the scan must become lazy too (discover on demand from the platform's "add server" gesture)?
7. **Process-wide concurrency cap** (§5.2): is per-workspace `max_concurrent_calls` enough, or does the host owner need a global ceiling?

---

## 11. Review record

This plan consolidates three read-only reviews of the platform plan, run from this session on 2026-10-08. Findings and file:line evidence are recorded in the platform plan's §11. Corrections this plan carries back:

- The platform plan says the shim's first-dot split must stay "first dot after the id". **Precisely:** split on the first dot for the id, then on the first dot of the remainder for the server; the tool keeps any further dots (§3.3).
- The platform plan's §5.5.2 health rule says "ready if the config is loaded and no workspace is still starting". **Refined:** children a workspace was asked to run, in `restarting`/`stopped`; tunnel state never gates readiness, except that zero workspaces stays `tunnel_not_open` (§5.7).
- `trustedIssuer` moves into each controller entry (§5.6); the platform plan says "per workspace" but doesn't say where it is stored.
