# IDENTITY-RESOLUTION — Segment identity tools + customer CDP drop-in template

> **Status:** **deferred (2026-06-27, v5).** Not yet branched. Pick up when the controller-side `resolveIdentity` seam is ready or a real customer asks. Prior-art check completed: see "Prior art" below — no upstream we can consume; building our own remains the right call when we restart. Two surfaces only:
> 1. **`mcp/bundled/twilio/segment/`** (Twilio-authored) — existing 5 Segment tools + 3 new identity-shape tools (`segment_identity_lookup`, `segment_identity_link`, `segment_identity_delete`).
> 2. **`mcp/local/cdp-sample/`** (customer-authored drop-in template, `author: "customer"`) — TODO-stubbed shell of the three identity calls. Approval-gated per v1.3+ drop-in flow.
>
> **Twilio does NOT own a canonical identity store** in this design. The brief's merge-protection mechanic (priority/limit policy, refuse-rather-than-corrupt, audit log) lives downstream of these tools — Segment enforces its own merge rules on its surface; the customer chooses whether to implement equivalent protection on their CDP fork.

## Goal

Give controller-side procedures two ways to resolve "who is this person across phone / email / webchat / account-id":

| Surface | Tools | Server name | Use when |
|---|---|---|---|
| Twilio Segment integration | existing 5 + new `segment_identity_lookup` / `segment_identity_link` / `segment_identity_delete` | `apis` | Customer's identity already lives in Segment. We talk to Segment's Profiles API + analytics SDK. |
| Customer drop-in template | `cdp_identity_lookup` / `cdp_identity_link` / `cdp_identity_delete` (TODO bodies) | `cdp-sample` (or whatever the customer renames it to) | Customer's identity is in mParticle / Tealium / RudderStack / etc. They fork the template and fill in the bodies. |

All over the existing `/mcp-tunnel` WS via standard `tools/call`. No new wire frames.

## What changed across revisions

| Decision | v1 | v2 (SQLite) | v3 (PG backend selector) | v4 (3 peers) | v5 (this doc) |
|---|---|---|---|---|---|
| Twilio identity store | Postgres bundle | SQLite bundle | Postgres OR Segment (env-switchable) | Postgres surface | **DROPPED** |
| Segment role | separate bundle | env-switchable backend | env-switchable backend | peer surface | **only Twilio-side surface** |
| CDP template | — | — | — | drop-in shell | **kept; one of two surfaces** |
| New deps in twilio bundle | `pg`, `libphonenumber-js` | `better-sqlite3`, `libphonenumber-js` | `pg`, `libphonenumber-js` | `pg`, `libphonenumber-js` | **`libphonenumber-js` only** |
| New Postgres container | — | — | yes, port 5434 | yes, port 5434 | **DROPPED** |
| Schema design | full | full | full | full | **N/A — Segment owns** |
| Merge primitive | NEW/ADD/MERGE/REFUSE in our code | same | same | same on the Postgres surface | **N/A on Segment; up to customer on CDP** |

v5 rationale: dropping the canonical store narrows Twilio's role to "integration layer for whatever identity graph the customer already runs." Customers picking Segment get Segment's existing rules; customers picking another CDP get theirs. Twilio doesn't run a competing identity database — which removes a *lot* of surface area (Postgres, schema, migrations, merge logic, audit log, FOR UPDATE concurrency story, two new env vars, a compose service).

The cost: the brief's merge-protection mechanic stops being a Twilio guarantee. Worth restating once in plain language: this design *implements the brief's tool surface*, not the brief's safety guarantees. Those guarantees are now downstream.

## Viability summary

| Concern | Verdict |
|---|---|
| Trust model | ✅ Two trust tiers. `segment/` rides `author: "twilio"` (no gate). `cdp-sample/` rides `author: "customer"` + `source: "local"` → drop-in approval gate per [CLAUDE.md](../../CLAUDE.md). |
| Outbound-only invariant | ✅ Preserved. Segment = outbound HTTPS. Customer's CDP = whatever their TODO body dials (almost always outbound HTTPS). Zero inbound ports. |
| Schema discipline | ✅ All Twilio tools declare `outputSchema`. CDP-sample tools also declare it — the schemas ARE the contract customers fulfil. |
| Connector-core neutrality | ✅ Everything lives in `mcp/`. No new connector deps. |
| Productized fit | 🟡 Tool surface idempotent + deterministic; **safety guarantees from the brief are not enforced by Twilio** (downstream concern). |
| Effort | 🟢 ~3–5 days total. P1 ≈ 2–3 days (Segment Profiles client + 3 tools + tests). P2 ≈ 1 day (cdp-sample shell + README + schema test). |
| Risks | 🟡 Segment surface can't refuse merges; customer-CDP forks may or may not. Phone normalization not in brief. Three new tools to keep in lockstep with the cdp-sample's three schemas. |

No blockers. The hardest part is the cross-surface schema contract — and that's just careful copy-paste, not a design problem.

## Architecture decisions

### D1 — Two peer surfaces, no Twilio-owned store.

We ship tools that integrate with identity graphs other people run. We don't run our own. Concretely:

- **`mcp/bundled/twilio/segment/`** — existing folder, currently has 5 Segment write/read tools. Add 3 new tools that match the brief's identity shape. Wired to Segment's Profiles API for reads, `analytics-node` for writes, Suppressions API for deletes. Server name on the wire: `apis`.
- **`mcp/local/cdp-sample/`** — new customer-authored drop-in template. Lives under the drop-in tree, gated by v1.3+ approval. No `server.ts`, no `package.json`; the drop-in scanner synthesizes the runtime. Server name: the folder name (`cdp-sample` until renamed).

There is no third folder for a Twilio-owned identity store. If a customer needs Twilio-managed identity stitching with the brief's merge guarantees, that's a future plan — not this one.

### D2 — No new external dependencies (almost).

The Twilio bundle already ships `@segment/analytics-node`. The new Segment tools reuse it for writes. For reads (Profiles API isn't covered by analytics-node), we add a tiny `fetch`-based client at `mcp/bundled/twilio/segment/profiles-client.ts` — no new SDK.

One new dep: `libphonenumber-js` for E.164 normalization (see D3). Pure JS, ~150KB, no native bindings.

No `pg`, no `better-sqlite3`, no migration runner, no compose service, no new connector dep.

### D3 — Phone normalization. E.164 before calling Segment.

Segment treats identifiers as opaque strings — so does the brief, by default. But if we don't normalize on our side before issuing a Profiles API lookup, calls for `+1 555 123 4567`, `15551234567`, and `(555) 123-4567` hit three different Segment profiles. That's non-deterministic from the controller-side procedure's perspective.

Recommend: when `kind === "phone"`, normalize via `libphonenumber-js` to E.164 before any Segment call. Reject (clear error) when the value fails normalization. All other kinds: lowercase only, per brief.

Same rule applies in the cdp-sample template — we copy the normalization helper into the template folder so the customer's fork doesn't need a cross-folder import.

### D4 — Cross-surface contract still holds (with one caveat).

A controller-side procedure written against `apis.segment_identity_lookup` should be portable to `<customer-cdp>.cdp_identity_lookup` (and vice versa) with only a wire-name change. Input + output schemas are identical across both surfaces.

The caveat: `refused_merge` on the `link` response.

| Surface | `refused_merge` |
|---|---|
| `apis.segment_identity_*` | **never fires** (Segment owns merge). |
| `cdp_identity_*` (customer fork) | depends on the fork — recommended to mirror the brief's semantics. |

Procedure code MUST treat `refused_merge` as optional. The schemas declare it as such (`.optional()` in zod).

### D5 — CDP-sample template is forkable, not configurable.

The cdp-sample shell is a starting point customers copy and rename, NOT a generic CDP adapter with env-driven backends. We don't ship "set `CDP_VENDOR=mparticle` and we'll route." Reasons:

- Each CDP's API shape is different enough that env-driven routing would balloon into a mini-SDK per vendor — that's a different product.
- The drop-in approval gate is per-folder. A renamed fork (`mcp/local/mparticle/`) gets its own approval; that's the right granularity.
- We carry zero responsibility for the customer's CDP integration once they fork. Cleaner trust boundary.

So the cdp-sample folder ships once with TODO bodies. Customers `cp -r` it, rename, fill in. Documented in the folder's README.

## File layout

```
mcp/bundled/twilio/                        # Twilio-authored, no approval gate
├── package.json                           # + libphonenumber-js (Segment SDK already present)
├── server.ts                              # registers the 3 new segment_identity_* tools iff env present
├── segment/                               # EXISTS, enhanced
│   ├── prompts/                           # existing
│   ├── segment-tracker.ts                 # existing — analytics-node writer
│   ├── profiles-client.ts                 # NEW — Profiles API reader, fetch-based
│   ├── normalize.ts                       # NEW — lowercaseValue + e164PhoneOrThrow
│   └── blocklist.ts                       # NEW — default garbage-value rules (advisory; we reject before calling Segment)
└── tools/segment/                         # EXISTS, +3 new tools
    ├── segment_identify.ts                # existing
    ├── segment_track.ts                   # existing
    ├── segment_profile_traits.ts          # existing
    ├── segment_profile_events.ts          # existing
    ├── segment_profile_external_ids.ts    # existing
    ├── segment_identity_lookup.ts         # NEW
    ├── segment_identity_link.ts           # NEW
    └── segment_identity_delete.ts         # NEW
```

```
mcp/local/cdp-sample/                      # Customer-authored drop-in template; approval-gated
├── README.md                              # "Fork this folder, rename, fill in the TODO bodies"
└── tools/
    ├── cdp_identity_lookup.ts             # schema declared, body throws "TODO: implement"
    ├── cdp_identity_link.ts               # schema declared, body throws "TODO: implement"
    ├── cdp_identity_delete.ts             # schema declared, body throws "TODO: implement"
    ├── normalize.ts                       # copy of segment/normalize.ts (no cross-folder import)
    └── blocklist.ts                       # copy of segment/blocklist.ts
```

No `server.ts`, no `package.json` in `cdp-sample/` — drop-in scanner synthesizes the runtime via [`packages/connector/src/sdk/dropin-runner.ts`](../../packages/connector/src/sdk/dropin-runner.ts). Folder name = MCP name; the customer renames when they fork.

## Cross-surface contract

The two surfaces share input + output schemas verbatim. A controller-side procedure can flip between them with a wire-name change.

Wire-name map:

| Surface | `lookup` | `link` | `delete` |
|---|---|---|---|
| Twilio Segment | `apis.segment_identity_lookup` | `apis.segment_identity_link` | `apis.segment_identity_delete` |
| Customer CDP fork (default folder name `cdp-sample`) | `cdp-sample.cdp_identity_lookup` | `cdp-sample.cdp_identity_link` | `cdp-sample.cdp_identity_delete` |

## Tool shapes

Standard `@mcp-shim/connector` Tool interface — `name`, `description`, `inputSchema` (zod), `outputSchema` (zod), `handler`. `outputSchema` is required for the Twilio-authored tools (boot-time validator). The cdp-sample tools declare it too — it IS the contract customers fulfil.

### `*_identity_lookup`

**Input.** `{ kind: string, value: string }`

**Output.**
```ts
{
  found: boolean,
  identity_id?: string,
  identifiers?: Array<{ kind: string, value: string }>,
  traits?: Record<string, { value: string, verified_at: string, source: string }>,
}
```

Handler (Segment):
1. Normalize value (E.164 for phone, lowercase otherwise).
2. Blocklist check — match → `{found:false}` (no error).
3. `GET /v1/spaces/{spaceID}/collections/users/profiles/{kind}:{value}/external_ids` for identifiers; `/traits` for traits.
4. 404 from Segment → `{found:false}`. Other errors throw.
5. Map Segment's response into our shape (the Profiles API returns `{data: [{type, id}, ...]}` for external_ids; we map `type → kind`, `id → value`).

Handler (cdp-sample): TODO. Schema is the contract.

### `*_identity_link`

**Input.**
```ts
{
  identifiers: Array<{ kind: string, value: string }>,  // 1..N, deduped
  traits?: Record<string, { value: string, verified_at: string, source: string }>,
}
```

**Output.**
```ts
{
  identity_id: string,
  merged: boolean,                              // Segment: always false (Segment owns merge)
  refused_merge?: { reason: string, detail: string },  // never present on Segment; up to cdp-sample fork
  identifiers: Array<{ kind: string, value: string }>,
}
```

Handler (Segment):
1. Normalize + blocklist-filter each identifier. Empty filter → throw.
2. Pick one identifier as `userId` for the `identify` call (preference: `account_id` > `email` > `phone` > first remaining). The other identifiers go into `traits` under reserved keys (`identifiers.phone`, `identifiers.email`, etc.) — this is how Segment surfaces multi-identifier intent. (Confirm shape with the Segment team before P1 — see R3.)
3. Await `analytics.identify({userId, traits, ...})`. The existing `segment_identify` tool already handles the await-with-callback pattern; reuse the helper.
4. After the `identify` call resolves, re-query Profiles API to get the canonical `identity_id` + all identifiers Segment now has on the profile. Return that snapshot.
5. `merged` is always `false` — we don't see whether Segment merged anything internally.

Handler (cdp-sample): TODO.

### `*_identity_delete`

**Input.** `{ identity_id: string }`

**Output.** `{ deleted: boolean }`

Handler (Segment):
1. `POST /v1/workspaces/{workspaceID}/regulations` with `{regulationType: "SUPPRESS_WITH_DELETE", subjectType: "USER_ID", subjectIds: [identity_id]}`.
2. Return `{deleted: true}` once Segment accepts the regulation. **Execution is async on Segment's side** — documented limitation; we acknowledge acceptance, not completion.

Handler (cdp-sample): TODO.

## Env vars

Tool registration is gated on env presence; no boot failures if missing. Bundle is graceful — the other Twilio tools (`messages_create`, existing `segment_*`, `verify_*`, etc.) still register without these.

### Twilio bundle (`mcp/bundled/twilio/`)

| Var | Required | Notes |
|---|---|---|
| `SEGMENT_WRITE_KEY` | already required for existing `segment_identify` / `segment_track` | Source for `analytics.identify` |
| `SEGMENT_PROFILES_API_TOKEN` | iff `segment_identity_*` tools wanted | New — bearer for Profiles + Suppressions APIs |
| `SEGMENT_WORKSPACE_SPACE_ID` | iff `segment_identity_*` tools wanted | New — Profiles API space scope |
| `SEGMENT_WORKSPACE_ID` | iff `segment_identity_delete` wanted | New — Suppressions API uses workspace id, not space id (different scope; confirm with Segment docs) |

If both `SEGMENT_PROFILES_API_TOKEN` AND `SEGMENT_WORKSPACE_SPACE_ID` are set, register `segment_identity_lookup` + `segment_identity_link`. If `SEGMENT_WORKSPACE_ID` is also set, register `segment_identity_delete`. Otherwise the tools stay out of the manifest — documented in `server.ts`.

### Customer drop-in (`mcp/local/cdp-sample/`)

Customer chooses. The shell ships with NO env declared. When the customer fills in TODO bodies, they add their CDP's keys to the tool files via the standard `envKeys` aggregate (per [CLAUDE.md](../../CLAUDE.md) "Type 1 hand-written shape" section). Those keys flow through the standard `creds-request` path.

## Phases

### P1 — Segment `segment_identity_*` tools

| Surface | Files | Notes |
|---|---|---|
| Bundle deps | [`mcp/bundled/twilio/package.json`](../../mcp/bundled/twilio/package.json) | + `libphonenumber-js` |
| Profiles API client | `mcp/bundled/twilio/segment/profiles-client.ts` | `fetch`-based; bearer + space scoping |
| Normalize + blocklist | `mcp/bundled/twilio/segment/{normalize,blocklist}.ts` | Pure, unit-tested |
| `segment_identity_lookup` | `mcp/bundled/twilio/tools/segment/segment_identity_lookup.ts` | Profiles API reads, mapped to contract shape |
| `segment_identity_link` | `mcp/bundled/twilio/tools/segment/segment_identity_link.ts` | `analytics.identify` + Profiles re-read for return value |
| `segment_identity_delete` | `mcp/bundled/twilio/tools/segment/segment_identity_delete.ts` | Suppressions API POST |
| Tool registration | [`mcp/bundled/twilio/server.ts`](../../mcp/bundled/twilio/server.ts) | Conditional on env presence |
| Per-tool tests | `packages/connector/tests/mcp-tools/apis/segment-identity-{lookup,link,delete}.test.ts` | Mock Profiles + Suppressions at the `fetch` boundary; mock `analytics.identify` at the SDK boundary. Pin `outputSchema` + `structuredContent` round-trip per [`OUTPUT-SCHEMA.md`](OUTPUT-SCHEMA.md) |
| Docs | new `mcp/bundled/twilio/IDENTITY.md` | Tool contracts, env vars, decision table (Segment vs CDP fork), "no merge protection on Segment surface" callout |

Exit criteria: with the new Segment envs set, the three tools register and call the right Segment APIs with the cross-surface contract shape; `segment_*` existing tools unchanged.

### P2 — `mcp/local/cdp-sample/` drop-in shell

| Surface | Files | Notes |
|---|---|---|
| Drop-in folder | `mcp/local/cdp-sample/tools/cdp_identity_{lookup,link,delete}.ts` | Schemas declared in full; bodies throw `new Error("TODO: implement cdp_identity_<name> against your CDP — edit mcp/local/<your-fork>/tools/cdp_identity_<name>.ts")` |
| Helpers | `mcp/local/cdp-sample/tools/{normalize,blocklist}.ts` | Copies of the Segment helpers; customer's fork doesn't need a cross-folder import |
| Folder README | `mcp/local/cdp-sample/README.md` | "Fork this folder, rename, fill in the bodies." Five-step walkthrough mirroring [`docs/AUTHOR-LOCAL-MCP.md`](../../docs/AUTHOR-LOCAL-MCP.md). Prominent **"DO NOT approve in the controller until you've filled in the bodies"** warning. |
| Connector docs | [`docs/AUTHOR-LOCAL-MCP.md`](../../docs/AUTHOR-LOCAL-MCP.md) | One new section: "Implementing the identity contract — see `mcp/local/cdp-sample/`." |
| Schema test | `packages/connector/tests/mcp-tools/cdp-sample/schema.test.ts` | Pin the input + output schemas (they're the contract). Asserts they match the Segment surface's schemas exactly. DO NOT test the bodies — they throw by design. |
| Approval-gate test | `packages/connector/tests/dropin/cdp-sample-discovered.test.ts` (extend existing drop-in tests if a similar one exists) | Asserts the folder is discovered, `mcp-discovered` is emitted, tools stay out of the manifest until `mcp-enable` |

Exit criteria: folder is discovered, surfaces in the controller's approval queue, and once approved, tools register with TODO bodies that throw a message naming the file to edit.

## Risks & open questions

| # | Item | Severity | Owner ask |
|---|---|---|---|
| R1 | Phone E.164 normalization not in brief (see D3) | medium | Confirm: bundle normalizes, or caller pre-normalizes? |
| R2 | No merge protection on the Segment surface | medium | The brief's "important part" is unenforceable here. Documented; controller-side procedure must trust Segment's behavior. Confirm acceptable. |
| R3 | Multi-identifier intent in `analytics.identify` | high | Segment's wire shape for "these N identifiers belong to the same person" needs Segment-team confirmation. Today's `segment_identify` tool takes ONE userId or anonymousId. Profiles API has External IDs as a concept; the write path to set them via `identify` may need `traits.identifiers` (per Segment Personas docs) — needs validation before P1. |
| R4 | Segment Profiles API doesn't expose every kind | medium | Custom-string kinds may 404. Our handler returns `{found: false}` on 404 — documented. |
| R5 | `segment_identity_delete` returns true on regulation accept, not execution | low | Document. |
| R6 | CDP-sample tools could be approved before filled in | medium | Tool body error message names the file to edit. README warns. We can't enforce. |
| R7 | Cross-surface schema drift between Segment + cdp-sample | medium | Schema-pinning test in P2 asserts equality. CI catches drift. |
| R8 | Rate-limit guidance for bulk `link` loops | medium | Brief calls this out — need a number. Segment Profiles API + Sources Tracking API have their own rate limits; document. |
| R9 | Segment workspace ID vs space ID confusion | low | Profiles + Suppressions use different scoping ids in their URLs. Document both env vars clearly. Verify in Segment docs before P1. |
| R10 | Segment could ship a competing/superseding MCP | low | Our tools live inside the existing twilio bundle under server name `apis`. If Segment ships a real MCP later, it becomes a Type 2 controller-pushed entry alongside ours — no rip-and-replace, and procedure code switches via the wire-name + cross-surface contract. See "Prior art" — today there is no production-grade upstream. |

## Prior art

Checked 2026-06-27 before deferring this plan:

- **`@segment/segment-mcp-server-demo`** v0.0.2 on npm (published 2025-05-30, no updates in 13 months). Official `@segment` scope, restricted access, source not in the tarball (only compiled `dist/`). Tool surface is read-only profile getters + opinionated AI-event trackers (`get_profile_traits`, `get_profile_events`, `track_ai_*`, `identify_user`, `track_custom_event`). **Has no lookup-by-(kind,value), no link/merge, no delete/suppression** — i.e. it doesn't cover the brief's three tools. Maturity signals point to "abandoned hackathon": placeholder `your-org/...` repo URL, no findable public repo, no tests, `0.0.0.0` HTTP bind with no MCP-transport auth, dead defensive code in config validation.
- **`ama0223/segment-mcp-server`** / **`papi-mcp-server`** on GitHub — a separate Go-based exploration by another Segment engineer (Aug 2025). Different stack, also looks like an individual experiment, not roadmap.

Useful as **reference for Segment endpoint shapes** (Profile API URLs, Basic-auth-with-write-key convention) if/when we resume. Not useful as an upstream to consume or wait on. The recommendation when we resume: build our own (P1 of this plan), borrow only the three Profile API call patterns from the demo for endpoint reference.

## Out of scope (documented in brief, unchanged)

- Time-windowed limit decay.
- Probabilistic / fuzzy matching.
- Split / unmerge.
- Cross-org identity sharing.
- Bulk loader UI.

**Newly out of scope** (deliberately, per v5 directive):

- Twilio-owned canonical identity store. No Postgres, no SQLite, no schema, no audit log, no merge primitive.
- Server-side enforcement of the brief's priority/limit/blocklist policy. Blocklist runs on our side BEFORE we call Segment (defense in depth — keeps garbage values out of Segment), but priority/limit knobs aren't applied because we don't own the data.

## Definition of done

- `apis.segment_identity_lookup({kind:'phone', value:'+15551234567'})` returns either `{found:true, identity_id, identifiers, traits}` or `{found:false}`.
- `apis.segment_identity_link({identifiers:[...], traits:{...}})` calls Segment's `identify`, awaits delivery, returns the post-write Profiles snapshot.
- `apis.segment_identity_delete({identity_id})` accepts a Suppressions regulation and returns `{deleted:true}`.
- All three tools register iff their env vars are set; bundle boots fine without them.
- `mcp/local/cdp-sample/` is discovered by the drop-in scanner, emits `mcp-discovered`, stays out of manifest until `mcp-enable`.
- Schema test asserts cdp-sample schemas == Segment surface schemas (cross-surface contract pinned in CI).
- Per-tool tests pin `outputSchema` + `structuredContent` round-trip per [`OUTPUT-SCHEMA.md`](OUTPUT-SCHEMA.md) for the three Twilio tools.
- [CLAUDE.md](../../CLAUDE.md) updated under "Sample tools" with the three new Segment tool names + a note about `cdp-sample` as a customer-fork template.
- New `mcp/bundled/twilio/IDENTITY.md` documents the two surfaces, env vars, the "Twilio is the integration layer, not the storage" framing, and the rate-limit guidance from R8.
- New `mcp/local/cdp-sample/README.md` walks customers through forking + filling in TODO bodies.

