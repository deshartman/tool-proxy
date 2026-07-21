# SEGMENT-MCP — Segment Profile + Tracking APIs as bundled tools

> **Status:** completed 2026-06-23 — branch `feature/segment-mcp`. All 5 tools landed, 9 new vitest cases pass (full suite 280 passing across 54 files), docs updated (CLAUDE.md, bundle README, MCP-PROTOCOL.md, TEST-SUITE.md). Pending: live round-trip against a real Segment Space (operator pastes `SEGMENT_SPACE_ID` + `SEGMENT_PROFILE_PAT` + `SEGMENT_WRITE_KEY` via the inspector and confirms a known profile lookup + a `track` event landing in the Segment debugger).
>
> ## Decisions (2026-06-23)
>
> - **Bundle home — extend `mcp/bundled/twilio/` (the `apis` MCP).** Adds a third creds-gated group alongside the existing Twilio (16 tools) and SendGrid (4 tools) groups in [`server.ts`](../../mcp/bundled/twilio/server.ts). No new bundle, no new yaml entry, no new MCP name. The bundle's existing per-folder `package.json` already isolates third-party SDKs from the workspace `node_modules` — adding `@segment/analytics-node` follows the same pattern as the existing `twilio` + `@sendgrid/client` deps.
> - **API surface — Profile API (read) + Tracking API (write). No Public API.** Profile API gives the unified-customer-data shape this is for; Tracking API lets a procedure write traits/events back. Public API (workspace/source/audience admin) is out of scope — admin-shaped, doesn't fit a procedure runtime.
> - **Profile lookup — generic `id_type:value`.** One tool surface per Profile API endpoint; the caller passes `id_type` (`"phone" | "email" | "user_id" | "anonymous_id"`) + `value`. Mirrors Segment's URL shape `…/profiles/<id_type>:<value>/…` and keeps the tool count down. Per-id-type sugar tools can be added later if procedure authors find the generic shape awkward.
> - **HTTP client split — official SDK for Tracking, native fetch for Profile.** [`@segment/analytics-node`](https://www.npmjs.com/package/@segment/analytics-node) (v3.1.0) is Segment's official server-side SDK and covers `identify` / `track` / `page` / `group` / `alias`. There is **no Profile API SDK on npm** — the Profile API is plain HTTP Basic auth (`<PAT>:` over `https://profiles.segment.com/v1/spaces/<spaceId>/...`). Native `fetch` (Node 20+ built-in) keeps the dep list to one new entry. Verified 2026-06-23: `npm view @segment/profiles` → 404; only `@segment/analytics-node`, `@segment/analytics-next` (browser), and `@segment/segment-mcp-server-demo` (a different MCP) exist.
> - **Creds split — two independent groups.** `SEGMENT_SPACE_ID` + `SEGMENT_PROFILE_PAT` gate the three read tools; `SEGMENT_WRITE_KEY` gates the two write tools. A read-only customer registers only the read tools; a write-only customer (rare) registers only the write tools. Mirrors the existing TWILIO_KEYS / SENDGRID_KEYS pattern in [`server.ts`](../../mcp/bundled/twilio/server.ts).
> - **Auth source — operator-entered, no auto-fill.** Twilio creds are auto-filled from the tunnel-security row (per `docs/MCP-PROTOCOL.md` §"Twilio-bundled auto-fill"); SendGrid is operator-entered. Segment follows SendGrid: the controller operator pastes the Profile PAT + Space ID + Write Key in the controller UI, the controller pushes via `creds-response` / `creds-update`. No new auto-fill source — Segment isn't part of the tunnel-security row identity.
> - **Branch.** `feature/segment-mcp` (mirrors plan filename, per `.claude/plans` convention).
>
> ## What's NOT in this plan
>
> - **Audience membership / computed traits.** The Profile API can also return audience membership and computed-trait values; deferring until a procedure asks for them. Adding later is one new tool, no architectural change.
> - **Batched `track`.** `@segment/analytics-node` already batches under the hood; we expose the per-event `track` shape so each tool call → one event from the procedure author's mental model.
> - **Reverse ETL / Connections / Functions admin.** Public API surface, deferred.
> - **A separate `segment` bundle.** Considered and rejected — see Decisions above. If a future change makes the bundles unwieldy in one process (RAM, restart cadence, customer-side dep conflicts), splitting is a localized refactor: copy `mcp/bundled/twilio/tools/segment/` to `mcp/bundled/segment/`, lift the segment-client + creds gate into a new `server.ts`, add a yaml entry. Not a wire-protocol change.

## Goal

Expose Segment's customer-data plane to procedures running on the controller, without changing the connector core, the wire protocol, or the trust boundary. A procedure reads a unified profile (traits / recent events / linked external ids) keyed off any external id the customer has — phone for inbound voice, email for inbound chat, `user_id` from a CRM lookup — and optionally writes back identify/track events when the procedure has new data.

This is a **tools-only** change. No new frame types, no supervisor changes, no inspector changes, no docs in `docs/MCP-PROTOCOL.md` beyond a single sentence noting Segment creds are operator-entered.

## API surface (5 tools)

All five live under `mcp/bundled/twilio/tools/segment/` and register under the existing `apis` MCP. Tool names use the `segment_` prefix to namespace them within the bundle (matches the `email_*` / `verify_*` / `voice_*` convention).

### Read group (`SEGMENT_SPACE_ID` + `SEGMENT_PROFILE_PAT` required)

| Tool | Endpoint | Purpose |
|---|---|---|
| `segment_profile_traits` | `GET /v1/spaces/<spaceId>/collections/users/profiles/<id_type>:<value>/traits` | Latest value per trait. Optional `?limit=` + `?include=` to filter trait names. |
| `segment_profile_events` | `GET /v1/spaces/<spaceId>/collections/users/profiles/<id_type>:<value>/events` | Recent events for the profile. Optional `?limit=` + `?next=` cursor for paging. |
| `segment_profile_external_ids` | `GET /v1/spaces/<spaceId>/collections/users/profiles/<id_type>:<value>/external_ids` | All external ids linked to the profile (phone, email, user_id, anonymous_id, plus any custom collection ids). |

Common input shape across all three:

```ts
{
  id_type: "phone" | "email" | "user_id" | "anonymous_id",
  value: string,
  // tool-specific extras (limit, cursor, include) added per tool
}
```

URL construction: `https://profiles.segment.com/v1/spaces/${SEGMENT_SPACE_ID}/collections/users/profiles/${id_type}:${encodeURIComponent(value)}/<endpoint>`. Auth: `Authorization: Basic ${base64(SEGMENT_PROFILE_PAT + ":")}` — Segment's Basic-with-empty-password convention.

404 on profile-not-found is expected for cold lookups; surface as `structuredContent: { found: false }` rather than throwing. Other 4xx/5xx throw with the upstream body included for operator debugging (matches the existing `messages_create` / `lookups_fetch` error shape).

### Write group (`SEGMENT_WRITE_KEY` required)

| Tool | SDK call | Purpose |
|---|---|---|
| `segment_identify` | `analytics.identify({ userId\|anonymousId, traits, context? })` | Upsert traits onto a profile. Caller must supply exactly one of `userId` / `anonymousId`. |
| `segment_track` | `analytics.track({ userId\|anonymousId, event, properties?, context? })` | Emit an event. Same one-of-two id rule. |

Both flush before returning so the tool response carries delivery status — matches procedure-author expectations (`tool returned → write happened`). The SDK exposes a `flush()` that returns when all in-flight events have been delivered; we await it inside the tool before returning. Acceptable latency cost: Segment's typical p99 for `/v1/identify` and `/v1/track` is sub-200ms, well within procedure-step budgets.

## Schema requirements

Per CLAUDE.md "Schema declaration follows the trust boundary" — every Type 1 tool we author must declare both `inputSchema` and `outputSchema`. The boot-time check at [`packages/connector/src/manifest/validate.ts`](../../packages/connector/src/manifest/validate.ts) logs `error` per offending tool but does NOT throw — but per-tool tests at `packages/connector/tests/mcp-tools/` are the primary gate.

Output schemas (zod, declared as `Record<string, ZodType>` per the existing tool convention):

- `segment_profile_traits` → `{ found: boolean, traits: Record<string, unknown> | null, cursors?: { has_more: boolean, next?: string } }`
- `segment_profile_events` → `{ found: boolean, events: Array<{ event: string, timestamp: string, properties: Record<string, unknown> }>, cursors?: { has_more: boolean, next?: string } }`
- `segment_profile_external_ids` → `{ found: boolean, externalIds: Array<{ type: string, id: string, source_id?: string, collection?: string, created_at?: string }> }`
- `segment_identify` → `{ delivered: boolean, messageId?: string }`
- `segment_track` → `{ delivered: boolean, messageId?: string, event: string }`

`messageId` on the write side is the SDK-generated `messageId` returned in the `analytics.identify` / `track` callback; we surface it for symmetry with `email_send` / `messages_create` so procedure authors have a handle for log correlation.

## File layout

```
mcp/bundled/twilio/
├── package.json                       # add @segment/analytics-node ^3.1.0
├── server.ts                          # extend creds gate — add 2 new groups + 5 tool registrations
├── segment-profile-client.ts          # NEW — fetch wrapper for Profile API (3 endpoints)
├── segment-tracker.ts                 # NEW — @segment/analytics-node factory
└── tools/
    └── segment/                       # NEW folder
        ├── segment_profile_traits.ts
        ├── segment_profile_events.ts
        ├── segment_profile_external_ids.ts
        ├── segment_identify.ts
        └── segment_track.ts
```

`segment-profile-client.ts` — a small typed `fetch` wrapper. Constructor takes `{ spaceId, pat }`; methods: `getTraits(idType, value, opts?)`, `getEvents(idType, value, opts?)`, `getExternalIds(idType, value)`. Builds the Basic auth header once, encodes the URL once, normalises 404 → `null` and other errors → `throw new Error(\`segment profile API \${status}: \${body}\`)`. Mirrors the shape + error contract of [`twilio-client.ts`](../../mcp/bundled/twilio/twilio-client.ts).

`segment-tracker.ts` — exports `createSegmentTracker(env = process.env)` returning a configured `Analytics` instance. Provider pattern (matches `makeSendGridProvider` in [`sendgrid-client.ts`](../../mcp/bundled/twilio/sendgrid-client.ts)) so tools take `() => Analytics` rather than the instance directly — leaves room for future lazy / per-call construction without changing tool signatures.

## server.ts diff (illustrative)

The four-group creds gate replaces today's two-group gate. Pattern is identical — add the new keys to `allEnvKeys`, add two more `if (missing.length === 0) { tools.push(...) }` branches:

```ts
const TWILIO_KEYS         = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] as const;
const SENDGRID_KEYS       = ["SENDGRID_API_KEY"] as const;
const SEGMENT_READ_KEYS   = ["SEGMENT_SPACE_ID", "SEGMENT_PROFILE_PAT"] as const;
const SEGMENT_WRITE_KEYS  = ["SEGMENT_WRITE_KEY"] as const;
const allEnvKeys = [
  ...TWILIO_KEYS, ...SENDGRID_KEYS,
  ...SEGMENT_READ_KEYS, ...SEGMENT_WRITE_KEYS,
];

// ...existing twilio + sendgrid blocks unchanged...

const segmentReadMissing  = SEGMENT_READ_KEYS.filter((k) => !process.env[k]);
const segmentWriteMissing = SEGMENT_WRITE_KEYS.filter((k) => !process.env[k]);

if (segmentReadMissing.length === 0) {
  const profile = createSegmentProfileClient();
  tools.push(
    segmentProfileTraits(profile),
    segmentProfileEvents(profile),
    segmentProfileExternalIds(profile),
  );
} else {
  log.warn(
    { missing: segmentReadMissing, required: [...SEGMENT_READ_KEYS] },
    "segment read tools deferred — awaiting creds-update",
  );
}

if (segmentWriteMissing.length === 0) {
  const tracker = createSegmentTracker;
  tools.push(segmentIdentify(tracker), segmentTrack(tracker));
} else {
  log.warn(
    { missing: segmentWriteMissing, required: [...SEGMENT_WRITE_KEYS] },
    "segment write tools deferred — awaiting creds-update",
  );
}
```

The MCP name stays `apis`. Customers see five new tools appear in `manifest-delta` once Segment creds are pushed.

## Checklist

### Bundle (`mcp/bundled/twilio/`)

- [ ] `package.json` — add `@segment/analytics-node: ^3.1.0` to `dependencies`
- [ ] `npm install` inside `mcp/bundled/twilio/` (also bumped automatically by `start-connector.sh` on first boot per its first-boot install loop)
- [ ] `segment-profile-client.ts` — Profile API fetch wrapper (3 methods)
- [ ] `segment-tracker.ts` — `@segment/analytics-node` factory
- [ ] `server.ts` — extend creds gate, register 5 tools across 2 new groups
- [ ] `tools/segment/segment_profile_traits.ts` — input + output schemas, 404 → `{ found: false }`
- [ ] `tools/segment/segment_profile_events.ts` — input + output schemas, paging cursor in output
- [ ] `tools/segment/segment_profile_external_ids.ts` — input + output schemas
- [ ] `tools/segment/segment_identify.ts` — `userId` xor `anonymousId` validation, await flush
- [ ] `tools/segment/segment_track.ts` — same validation, await flush

### Tests (`packages/connector/tests/mcp-tools/`)

Per CLAUDE.md "boot-time check ... CI is the primary line of defense" — add per-tool tests that pin schema declaration AND a success-path `structuredContent` round-trip. `nock` or a hand-rolled `globalThis.fetch` stub for the Profile API; `@segment/analytics-node` exposes a `host` constructor option so tests can point it at a local `http.createServer` and assert the wire shape.

- [ ] `segment_profile_traits.test.ts` — happy path returns traits; 404 returns `{ found: false }`
- [ ] `segment_profile_events.test.ts` — paging cursor surfaces in output
- [ ] `segment_profile_external_ids.test.ts` — list shape stable
- [ ] `segment_identify.test.ts` — `userId` xor `anonymousId` enforced; flush awaited
- [ ] `segment_track.test.ts` — event name + properties forwarded verbatim
- [ ] Append a row to `.claude/plans/TEST-SUITE.md` per the catalog rule

### Docs (do not skip — CLAUDE.md guidance)

- [ ] [`CLAUDE.md`](../../CLAUDE.md) — extend the "Sample tools" paragraph (the line listing Twilio messaging/voice/verify/email tools) with the five Segment tools
- [ ] [`mcp/bundled/twilio/README.md`](../../mcp/bundled/twilio/README.md) — new "Segment" subsection documenting the four env vars, what each tool does, and which group each falls into
- [ ] [`docs/MCP-PROTOCOL.md`](../../docs/MCP-PROTOCOL.md) — single sentence under §"Twilio-bundled auto-fill" noting Segment creds are operator-entered (no auto-fill source); list the four env-key names so the controller team can wire the creds-pasting UI
- [ ] **No** `docs/deploy/**` changes — no infra change, no port change, no LB change

### Verification

- [ ] `cd packages/connector && npm run build` clean — TS compile passes
- [ ] `cd packages/connector && npm test` clean — new tests + existing suite green
- [ ] Local round-trip: paste real Profile PAT + Space ID + Write Key into the inspector's "Apply session creds" panel for the `apis` MCP → wait for restart → confirm 5 new tools appear in the inspector's "Available Tools" panel → invoke `segment_profile_traits` for a phone with a known profile → check the `structuredContent` matches the Segment UI's view of that profile
- [ ] Live `segment_track` round-trip: invoke from inspector → check the event lands in Segment's debugger UI within 10s

---

## Open questions (defer until implementation)

1. **Profile API rate limits.** Segment publishes a 100 RPS / per-Space limit on the Profile API. A single procedure invocation typically calls one or two profile endpoints — well within budget. If a future procedure fans out (e.g. enrich every contact in a list), we'll need a cheap LRU on the client. Not worth pre-building.
2. **Computed traits vs raw traits.** `?include=` lets the caller filter trait names but doesn't distinguish computed (audience-derived) from raw. Procedure authors today don't know the difference; deferring until someone asks. The trait values come back in the same shape regardless.
3. **`groupId` on identify/track.** The SDK supports a `groupId` for B2B account-scoped events. Skipping for v1 — adds an input field most callers won't use. Adding later is purely additive (optional `groupId` on both write tools, no schema break).
4. **Region pinning.** Segment offers EU + US data residency on different hostnames (`profiles.segment.com` US, `profiles.euw1.segment.com` EU). Today's plan hardcodes US. If an EU customer shows up, add `SEGMENT_PROFILE_HOST` (defaulting to `profiles.segment.com`) to the read-creds group — same one-line change.

## Why a single bundle instead of `mcp/bundled/segment/`

- The customer-facing surface is "Twilio's bundle gives you these APIs". Today it's Twilio comms + SendGrid email; adding Segment fits that narrative. A separate bundle would mean two yaml entries, two MCP names in the controller UI, two creds rows for what is conceptually one Twilio-bundled product.
- The connector's restart cadence is per-MCP. A `creds-update` to `SEGMENT_WRITE_KEY` restarts the `apis` child — same blast radius as a `SENDGRID_API_KEY` rotation today (4 SendGrid tools blink, 16 Twilio tools blink). The four-group split inside one bundle keeps the gate-failure ergonomics sensible (segment-only customer doesn't see Twilio "tools deferred — awaiting creds-update" warnings, just the segment one).
- Dependency isolation is already solved — the bundle's per-folder `package.json` keeps `@segment/analytics-node` out of the workspace `node_modules`, exactly like `twilio` and `@sendgrid/client` today.
- Reversal is cheap if the bundles get unwieldy. The split criterion would be process-level: RAM, restart-cadence pain, customer-side deps that conflict with each other. None of those bind today.
