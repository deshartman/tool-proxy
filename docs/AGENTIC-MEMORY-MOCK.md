# AGENTIC-MEMORY-MOCK — Controller-side handoff

> **Status:** v1 — mocked reference implementation only
> **Repo location:** `bundled-mcps/agentic-memory/` (drop-in) + `connector/tests/integration/agentic-memory-smoke.test.ts` (spec walk)

This document is what the Controller team consumes to integrate against a running instance of the agentic-memory mock. It describes the **actual wire shape** the connector advertises, not the spec-idealised shape — read §2 first.

---

## 1. What this mock is

A single Type 1 drop-in inside the MCP shim (`bundled-mcps/agentic-memory/`) that implements every tool, prompt, and resource a memory + identity provider should expose. It's:

- **Persistent** — state lives in a JSON file (`bundled-mcps/agentic-memory/.state.json`, gitignored). Survives connector restarts.
- **Deterministic** — `externalId` is `sha1(channel + '::' + normalisedValue).slice(0, 12)`; same identifier always maps to the same identity, even after `.state.json` is deleted.
- **Complete** — implements all 12 required tools AND both optional tools (`memory_semantic_prune_refs`, `memory_semantic_merge_identities`). The capability advertisement says `supportsPruneRefs: true` and `supportsIdentityMerge: true`.
- **Non-authoritative** — fake data only. No real backing store, no vector search, no PII policy, no audit trail. Use it as a wire-shape reference and a smoke-test target — not as a production dependency.

Wire prefix on all tool / prompt names: **`agentic-memory.`** (this is the folder name under `bundled-mcps/` and therefore the server name in the connector's tool namespacing).

---

## 2. Spec deviation — custom capabilities go under `experimental`

**Read this before wiring the Controller side.**

MEMORY-MCP-INTERFACE.md §7 places the custom capability shape at the top level of the `capabilities` object:

```jsonc
// Spec §7 idealised shape — DOES NOT WORK over standard MCP
{
  "protocolVersion": "2026-07",
  "identity": { ... },
  "memory": { ... }
}
```

MCP's `ServerCapabilitiesSchema` (`@modelcontextprotocol/sdk`) uses `.strip()` — unknown top-level keys are removed by the SDK on both send and receive. The spec's top-level `identity`, `memory`, `protocolVersion`, and `unknownFieldBehavior` fields would be dropped before the Controller's client ever sees them.

**What the mock advertises instead** (verified via `client.getServerCapabilities()`):

```json
{
  "tools": {},
  "prompts": {},
  "resources": {},
  "experimental": {
    "agentic-memory": {
      "protocolVersion": "2026-07",
      "identity": {
        "supported": true,
        "maxAliases": 100,
        "supportsBatchLookup": false
      },
      "memory": {
        "episodic": {
          "supported": true,
          "maxQueryLength": 2000,
          "maxResults": 50,
          "supportsVectorSearch": false,
          "supportsRecencyScoring": true,
          "batchAppend": false
        },
        "semantic": {
          "supported": true,
          "maxResolvedSizeBytes": 1048576,
          "maxSourceRefs": 1000,
          "supportsAgentFlush": true,
          "supportsIdentityMerge": true,
          "supportsPruneRefs": true
        }
      },
      "unknownFieldBehavior": "ignore"
    }
  }
}
```

**Controller-side read path:**

```typescript
const caps = client.getServerCapabilities();
const am = caps?.experimental?.["agentic-memory"];
if (!am) throw new Error("provider does not advertise the agentic-memory capability group");
if (am.protocolVersion !== "2026-07") throw new Error(`unsupported protocol ${am.protocolVersion}`);
```

**Why the vendor namespace (`agentic-memory`)?** `experimental` is `Record<string, object>`. Nesting everything under a single vendor-namespaced key gives the Controller a stable path to find the group and prevents collision if a customer runs *two* memory providers under one shim.

**Recommendation for the interface spec:** amend §7 to specify the `experimental` envelope explicitly. Every MCP provider will hit this the moment they use the standard SDK.

---

## 3. Wire-name inventory — tools

All 14 tool names live at wire prefix `agentic-memory.` (i.e. a `tools/call` frame carries `name: "agentic-memory.identity_resolve"`).

| Tool wire name | Required | Spec §  |
|---|---|---|
| `agentic-memory.identity_resolve` | ✅ | §4.1 |
| `agentic-memory.identity_lookup` | ✅ | §4.2 |
| `agentic-memory.identity_add_alias` | ✅ | §4.3 |
| `agentic-memory.identity_remove_alias` | ✅ | §4.4 |
| `agentic-memory.identity_list_aliases` | ✅ | §4.5 |
| `agentic-memory.identity_merge` | ✅ | §4.6 |
| `agentic-memory.memory_episodic_append` | ✅ | §5.1 |
| `agentic-memory.memory_episodic_recall` | ✅ | §5.2 |
| `agentic-memory.memory_semantic_get` | ✅ | §5.3 |
| `agentic-memory.memory_semantic_upsert_refs` | ✅ | §5.4 |
| `agentic-memory.memory_semantic_write_resolved` | ✅ | §5.5 |
| `agentic-memory.memory_semantic_agent_flush` | ✅ | §5.6 |
| `agentic-memory.memory_semantic_prune_refs` | 🟡 optional | §5.7 (implemented) |
| `agentic-memory.memory_semantic_merge_identities` | 🟡 optional | §5.8 (implemented) |

Every tool declares an MCP `outputSchema` (zod). Happy-path responses carry `structuredContent` matching that schema PLUS a JSON-stringified `content[0].text`. Error responses use `isError: true` with the spec §10 envelope in `content[0].text` — see §5 below.

---

## 4. Wire-name inventory — prompts and resources

### Prompts (3)

All prompts render a single `user`-role message the caller can hand to an LLM.

| Wire name | Args | Returns |
|---|---|---|
| `agentic-memory.bootstrap_context` | `{ externalId: string, includeEpisodes?: "true" \| "false" }` | User message prefilled with the identity's aliases + resolved semantic bag + most-recent 5 episodes. For warm-starting an agent on session re-entry. |
| `agentic-memory.summarize_episode` | `{ transcript: string, channelKind: <Channel enum> }` | User message asking the LLM to produce a 2–3 sentence summary shaped for `memory_episodic_append`. Governs the style of the platform's episodic memory globally — swap this prompt to change everyone's summaries. |
| `agentic-memory.merge_review` | `{ winnerExternalId: string, loserExternalId: string }` | Side-by-side dump of both identities' aliases + resolved bags so a reviewer (LLM or human via LLM) can APPROVE / REJECT the merge before the Controller calls `identity_merge`. |

Note: `includeEpisodes` is transported as a `"true"`/`"false"` string (MCP prompt args are strings by convention through the current SDK).

### Resources (3)

| URI | Kind | Content |
|---|---|---|
| `identity://aliases/{externalId}` | template | JSON: `{ externalId, aliases: [{channel, value, addedAt}, ...] }` |
| `memory://episodes/{externalId}` | template | JSON: `{ externalId, episodes: [...] }` — most-recent 10, newest first |
| `stats://global` | static | JSON: `{ identityCount, aliasCount, episodeCount, semanticCacheCount }` |

The template resources are listable — `resources/templates/list` returns both `uriTemplate` entries. `resources/list` returns `stats://global` plus a `list` callback on each template that enumerates the current identities (so a Controller can walk them without needing to know externalIds up front).

---

## 5. Error envelope (per spec §10)

Every tool error response has the shape:

```jsonc
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "{\"error\":{\"code\":\"identity_not_found\",\"message\":\"...\",\"retryable\":false}}"
    }
  ]
}
```

`structuredContent` is **omitted on error paths** so it doesn't collide with the tool's outputSchema. Parse `content[0].text` as JSON to get the spec §10 envelope.

Codes the mock actually raises:

| Code | Raised by | Extras |
|---|---|---|
| `invalid_identifier` | `identity_resolve`, `identity_lookup`, `identity_add_alias`, `identity_remove_alias` when `value` fails normalisation (empty, malformed phone, `alias@` missing domain, etc.); `identity_merge` when `winner === loser` | — |
| `identity_not_found` | Every tool that takes `externalId` when the id is unknown | — |
| `identity_merged` | Every tool that takes `externalId` when the id was tombstoned by `identity_merge` | `mergedInto: <winnerExternalId>` |

Codes the mock **does not raise** (would fire in a real provider): `rate_limit_exceeded`, `storage_full`, `timeout`, `schema_mismatch`, `not_implemented`. If your Controller-side retry logic depends on seeing these, wire a test double.

---

## 6. Normalisation behaviour

Per spec §4.1, values are normalised before matching/storing. This mock:

| Channel | Normalisation |
|---|---|
| `voice` / `sms` / `rcs` / `mms` | E.164: strip non-`\d+`; require 8–15 digits; prepend `+` if missing (mock is lenient — real providers should reject missing `+`) |
| `whatsapp` | Strip `^whatsapp:\s*`; then normalise as phone |
| `email` | Lowercase + trim + require exactly one `@` with non-empty local + domain |
| `webchat` / `chat` / `test-harness` | Trim only (opaque identifier) |

Empty values throw `invalid_identifier`.

---

## 7. Determinism guarantees

- **Same `(channel, normalisedValue)` → same `externalId`** across restarts, `.state.json` deletion, whatever. The externalId is derived; not stored-then-looked-up.
- **Episode IDs are UUIDv4** — non-deterministic, unique per append.
- **`isNew` flag** on `identity_resolve` reflects whether the identity was *materialised* in this call, not whether the externalId was seen before. Delete `.state.json` and re-resolve the same phone: `isNew` will be `true` again even though the externalId is the same.

---

## 8. Reproducing §11.1 validation locally

The full smoke suite lives at:

```
connector/tests/integration/agentic-memory-smoke.test.ts
```

Run it:

```bash
cd connector
npm test -- tests/integration/agentic-memory-smoke.test.ts
```

It boots the drop-in exactly the way the connector does (`loadCategory` + `loadCapabilities` + `createMcpHttpServer`), connects a real MCP `Client`, and walks the §11.1 checklist end-to-end. On green you see 10 passing tests including capability handshake, all 14 tools listed, identity resolve/lookup round-trip, alias idempotency, episodic append+recall, semantic upsert+get+flush, identity merge with `identity_merged` follow-up, optional-tool probe (prune + merge-cache), prompt render, and resource read/list.

To exercise it through the running connector (real WS tunnel, real controller mock, real inspector UI):

1. Ensure `bundled-mcps/agentic-memory/` is present (it is — this is the drop-in itself).
2. Start the connector: `./scripts/start-connector.sh` from the repo root.
3. Open <http://localhost:9090/> → the Available Tools panel lists all 14; the Frames panel shows the initialize handshake with `experimental.agentic-memory` intact.

---

## 9. What's NOT covered by the mock

Only mention here what would surprise a Controller-side integrator:

- **No true vector search.** Recall scoring is `0.4 * recency + 0.6 * keyword-match-ratio` when a query is present; recency-only when the query is empty. Capabilities honestly declare `supportsVectorSearch: false`.
- **No tenant scoping.** The mock treats every request as the same tenant. When the Controller side has multi-tenant needs, either run one connector per tenant or wire tenant into the Controller-side procedure inputs (the shim will pass them through as tool args).
- **No batch operations.** `batchAppend: false` and `supportsBatchLookup: false` are advertised — one call per identity for now.
- **No encryption / retention.** The state file is JSON on disk. Real providers should implement §9's compliance surface; this mock doesn't.
- **No PII redaction on prompts.** `bootstrap_context` embeds the raw resolved bag + aliases into the prompt text. Production providers should apply channel-specific redaction (mask card numbers, etc.) before returning.
- **`.state.json` isn't atomic across concurrent connectors.** Single-writer only — matches the drop-in shape (one child process per folder), so this is only a hazard if you wire two connectors to the same on-disk state file. Don't.

---

## 10. Changelog

| Date | Change |
|---|---|
| 2026-07-17 | Initial mock — implements all 14 tools + 3 prompts + 3 resources + capabilities under `experimental.agentic-memory`. Documented `experimental` envelope deviation from spec §7. |
