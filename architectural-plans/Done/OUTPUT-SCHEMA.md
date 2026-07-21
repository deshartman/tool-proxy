# OUTPUT-SCHEMA — Plan

> **Goal.** Every tool we *author* advertises an `outputSchema` AND populates `structuredContent` on success, so controller-side procedure authors can write `{{ hydrate:<server>.<tool>.<field> }}` without parsing JSON out of `content[0].text`. Tools we *don't* author (Type 2 externals) pass through verbatim — the controller handles missing schemas gracefully on its end.
>
> **Branch.** `feature/output-schema` (cut from `main`, not from `feature/testing`). One bundled PR. Do **not** push to origin until merge-day per the standing convention.
>
> **Status: completed 2026-06-19.** All steps S0–S8 landed on `feature/output-schema` over 8 commits. 30 authored tools migrated; 44 new defensive tests; total suite at 111 cases. S6 was redesigned mid-flight from "env-flag-gated throw" to "log.error per tool, no flag" per user feedback that the flag was overkill.

## Context

Today only **1 of 31** Type-1 / bundled tools declares an `outputSchema`:

| Server | Tool | Has `outputSchema`? |
|---|---|---|
| `crm` | `get_recent` | ✅ ([mcp/local/crm/tools/get-recent.ts:95](../../mcp/local/crm/tools/get-recent.ts#L95)) |
| `crm` | `get_customer`, `issue_refund`, `notify_agent`, `get_appointment`, `check_availability`, `update_appointment` | ❌ |
| `sample` | `now`, `uuid`, `weather`, `slow_echo` | ❌ |
| `apis` (Twilio) | all 20 | ❌ |

The plumbing is already correct end-to-end — `outputSchema` is preserved at every hop ([servers/index.ts:50](../../packages/connector/src/servers/index.ts#L50), [servers/index.ts:72](../../packages/connector/src/servers/index.ts#L72), [tunnel/frames.ts:8](../../packages/connector/src/tunnel/frames.ts#L8), [manifest/diff.ts:49](../../packages/connector/src/manifest/diff.ts#L49)). The gap is purely at the **declaration site** in each tool's `registerTool(...)` call.

The controller dev's reference (`frames.ts:15-16`) is correct in shape but the field is at line 8 in our source.

## Why this matters

- **Hydration breaks silently — twice.** A procedure author writing `{{ hydrate:crm.get_customer.name }}` gets no projection for two independent reasons: (1) no `outputSchema` means no autocomplete and no controller-side type-check, and (2) even if the author knew the field name, the controller's `projectPath` looks at `result.<field>` — but today's tool returns `{ content: [{ type: "text", text: "{...JSON...}" }] }`, so the customer record is *inside a JSON string inside `content[0].text`*. The controller would have to parse the JSON before projecting. **Returning `structuredContent: data` alongside `content[]` is the MCP-standard fix** — `structuredContent` is the protocol's machine-shaped sibling field, populated specifically so platforms don't have to JSON-parse out of text content.
- **Wire-format claim is asymmetric.** [tunnel/frames.ts:8](../../packages/connector/src/tunnel/frames.ts#L8) declares `outputSchema?: unknown` as part of `ToolDescriptor`, and the controller relies on it. Tools that omit it are technically protocol-compliant (the field is optional) but functionally broken for hydration.
- **One tool already shows the pattern.** [`crm.get_recent`](../../mcp/local/crm/tools/get-recent.ts) is the canonical example, with self-documenting comments at lines 34–37 explaining hydration projection AND `structuredContent: data` at [line 117](../../mcp/local/crm/tools/get-recent.ts#L117). The pattern just wasn't generalised.

## Trust boundary — what we enforce vs. observe

Schema enforcement follows the same trust boundary as tool authority (see CLAUDE.md "Architecturally load-bearing properties"). We control what we author; we observe what we don't.

| MCP Type | Author | Discriminator (already in [config.ts](../../packages/connector/src/config.ts)) | Strict-mode behaviour |
|---|---|---|---|
| **Type 1** (Node, customer- or Twilio-authored) | We do — source under `mcp/local/` or `mcp/bundled/` | `isType1Spawn(spec)` | **Throws** on missing schema |
| **Type 3** (Twilio Python venv bundle) | We do — source under `bundles/<name>/` | `isType3Bundled(spec)` | **Throws** on missing schema |
| **Type 2** (external `endpoint:` or `command:` MCP) | We don't — opaque upstream (e.g. `aviation-weather` via `npx`) | neither helper returns true | **Logs WARN** listing missing tools; boot proceeds |

Why: forcing Type 2 servers to declare an `outputSchema` would require us to either retrofit upstream code we don't own or block the connector booting against legitimate third-party MCPs. The pragmatic approach is to surface the gap (boot warning + Inspector annotation) so the customer can either ask the upstream author to add a schema, replace the Type 2 with a Type 1 wrapper, or knowingly accept "no hydration for this server."

`structuredContent` follows the same boundary: tools we author always populate it; tools we don't are forwarded verbatim — if upstream returns it, the controller can use it; if not, the controller still has the option to JSON-parse `content[0].text` as a graceful-degradation path.

## Decision matrix — what gets a schema

The implementation walks every tool's source, maps each to one of three buckets, and applies the bucket's rule. There is no per-tool design call to make at edit time — the bucket decides. Type 2 servers (e.g. `aviation-weather`) are out of scope for this matrix per the trust-boundary table above.

| Bucket | Rule | Tools |
|---|---|---|
| **A. JSON-shaped result** | The handler returns a typed object today (or could trivially). Add an `outputSchema` literal that mirrors what `JSON.parse(content[0].text)` produces, plus `structuredContent: data` in the return. | `crm.get_customer`, `crm.issue_refund`, `crm.get_appointment`, `crm.check_availability`, `crm.update_appointment`, `crm.notify_agent`, `sample.weather`, all 20 `apis.*` Twilio tools |
| **B. Single-scalar result** | Tool returns one primitive (string / ISO timestamp). Schema is `{ value: z.string().describe(...) }`; handler also returns it as `structuredContent: { value: text }`. | `sample.now`, `sample.uuid` |
| **C. Demo-only, opaque body** | Long-running echo for testing, no useful projection. Schema is `{ message: z.string(), elapsedMs: z.number() }`. | `sample.slow_echo` |

Every author-facing field gets a `.describe(...)` so the controller UI can show contract docs, matching the `crm.get_recent` precedent.

## Work breakdown — small, verifiable steps

Each step is independently committable. Land them in order on `feature/output-schema`. Status flips `pending` → `done` as commits land.

| Step | What | Verifies | Commit | Status |
|------|------|----------|--------|--------|
| **S0** | Cut `feature/output-schema` from `main`. | `git status` clean on the new branch | (no commit) | done |
| **S1** | **Runtime check.** New module `src/manifest/validate.ts`. Original design (gated throw + WARN-on-Type-2) was redesigned at S6 — see that row. Wired into [boot/lifecycle.ts](../../packages/connector/src/boot/lifecycle.ts) after `buildManifest()`. | unit test (S2) | `Step 1: runtime guard for missing outputSchema (gated)` | done |
| **S2** | **Unit test for validator.** Seven cases originally; six after the S6 redesign (the gated-off case became irrelevant when the env flag was removed). | `npm test` reports the cases pass | `Step 2: unit tests for manifest output-schema guard` | done |
| **S3** | **Bucket A — `crm.*` (six tools).** outputSchema + structuredContent for each. | `npm test`; boot stays clean | `Step 3: outputSchema for crm tools` | done |
| **S3a** | **Per-tool handler tests for `crm.*`.** | `npm test` reports new tests pass | `Step 3a: handler tests for crm structuredContent + schema parse` | done |
| **S4** | **Bucket B+C — `sample.*` (four tools).** | same | `Step 4: outputSchema for sample tools` | done |
| **S4a** | **Per-tool handler tests for `sample.*`.** | `npm test` | `Step 4a: handler tests for sample structuredContent + schema parse` | done |
| **S5** | **Bucket A — Twilio `apis.*` (20 tools).** | same | `Step 5: outputSchema for apis (Twilio bundled) tools` | done |
| **S5a** | **Per-tool handler tests for `apis.*`.** 20 tests. | `npm test` | `Step 5a: handler tests for apis structuredContent + schema parse` | done |
| **S6** | **Redesign — drop the env flag.** Original plan flipped a `STRICT_OUTPUT_SCHEMA` default to `1`. User feedback rejected the flag entirely: Type 1/3 we own, so report missing schemas as `log.error` per offending tool but DO NOT throw — keep booting; CI catches these via the per-tool tests at S3a/S4a/S5a. Type 2 passes through silently — controller handles it gracefully. The `envFlag` helper in `env.ts` was removed (was only used here). Tests reduced from 7 → 6 cases. | per-tool log.error visible; Type 2 silent; boot continues | `Step 6: redesign manifest guardrail — log.error per offending tool, no flag` | done |
| **S7** | **Doc updates.** [`CLAUDE.md`](../../CLAUDE.md) — new bullet in "Architecturally load-bearing properties". [`packages/connector/README.md`](../../packages/connector/README.md) — extended "Author a Type 1 MCP" with the five authoring rules. [TEST-SUITE.md](TEST-SUITE.md) — catalog row. | `grep -c outputSchema` ≥ 1 each | `Step 7: document outputSchema requirement` | done |
| **S8** | **Catalog rows** in TEST-SUITE.md (regression catalog) and TESTS_IMPLEMENTED.md (44 test inventory rows: 6 validator + 38 handler). | rows visible | (uncommitted — `.claude/plans/*` is gitignored) | done |

S1 + S2 land **before** any schema declarations so we have a regression net the moment we start editing 31 tool files. The `aN` suffix steps (S3a/S4a/S5a) immediately follow each bucket's schema rollout — they're the *convention pins* that keep `structuredContent` from drifting back to text-only on a future tool edit. S6 is intentionally a separate commit so a revert doesn't undo the schema work.

## Schema authoring rules (apply per-bucket)

These get copied into [`packages/connector/README.md`](../../packages/connector/README.md) and [`CLAUDE.md`](../../CLAUDE.md) verbatim at S7.

1. **Plain object of zod fields, NOT `z.object({...})`.** SDK convention — see [`get-recent.ts:46-49`](../../mcp/local/crm/tools/get-recent.ts#L46-L49). Wrapping in `z.object` changes the inferred argument type and breaks the handler signature.
2. **Every field gets `.describe(...)`.** This is the contract authors read in the controller UI.
3. **Return both `content[]` AND `structuredContent`.** `content[0].text` carries `JSON.stringify(data, null, 2)` for human-readable inspection (LLM consumption); `structuredContent: data` is the machine-shaped sibling field that the controller's `projectPath()` reads from directly. **Without `structuredContent`, the controller would have to JSON-parse `content[0].text` before projecting** — that's the gap the controller dev hit on the live test (their `projectPath(data, ['name'])` looked at top-level `data`, not at `JSON.parse(data.content[0].text)`). Mismatch between the two fields is a bug — they should serialize to the same data; rule pinned by the S3a/S4a/S5a handler tests.
4. **Schema describes the projection target, not the SDK response.** For Twilio `apis.*` tools, the schema lists *only* the fields the handler currently returns — not the full `Message` / `Call` SDK shape. Widen later if a procedure needs more.
5. **Errors return `content[]` only — no `structuredContent`.** Tool-level failure is signalled via `isError: true` + a `text` content entry, per the MCP Tools spec. **Do NOT also set `structuredContent` on the error path** — the SDK validates `structuredContent` against the declared `outputSchema` even when `isError: true`, and an error envelope (`{ error: "no_customer" }`) won't match a success schema. The schema describes the success shape only; the error path is a pure `content[]` return.

## Runtime check — design

The validator splits enforcement by the trust boundary: Type 1 / Type 3 tools we author throw on missing schema; Type 2 externals warn-only.

```ts
// src/manifest/validate.ts
import type { ToolManifest } from "../tunnel/frames.js";
import type { ConnectorConfig } from "../config.js";
import { isType1Spawn, isType3Bundled } from "../config.js";
import { envFlag } from "../env.js";
import { createLogger } from "../logger.js";

const log = createLogger("manifest-validate");

export function validateManifestSchemas(m: ToolManifest, config: ConnectorConfig): void {
  if (!envFlag("STRICT_OUTPUT_SCHEMA", true)) return;

  const specByName = new Map(config.mcp_servers.map((s) => [s.name, s]));
  const authoredMissing: string[] = [];   // Type 1 / Type 3 — we own these
  const externalMissing: string[] = [];   // Type 2 — opaque upstream

  for (const server of m.servers) {
    const spec = specByName.get(server.name);
    const weAuthored = !!spec && (isType1Spawn(spec) || isType3Bundled(spec));
    for (const tool of server.tools) {
      if (tool.outputSchema !== undefined) continue;
      const id = `${server.name}.${tool.name}`;
      (weAuthored ? authoredMissing : externalMissing).push(id);
    }
  }

  if (externalMissing.length > 0) {
    log.warn(
      { tools: externalMissing },
      `Type 2 (external) tools advertise no outputSchema (${externalMissing.length}): ` +
      `${externalMissing.join(", ")}. Controller-side hydration won't work for these. ` +
      `Upgrade upstream or set STRICT_OUTPUT_SCHEMA=0 to silence.`,
    );
  }

  if (authoredMissing.length > 0) {
    throw new Error(
      `Tools we author are missing outputSchema (${authoredMissing.length}): ` +
      `${authoredMissing.join(", ")}. See packages/connector/README.md ` +
      `"Author a Type 1 MCP" or .claude/plans/OUTPUT-SCHEMA.md.`,
    );
  }
}
```

`envFlag` already exists in [`src/env.ts`](../../packages/connector/src/env.ts) (added in TEST-SUITE.md row 2026-06-18). The default-on flips at S6 by changing the second arg `false → true`. `isType1Spawn` / `isType3Bundled` are existing helpers in [`src/config.ts`](../../packages/connector/src/config.ts) — no new classification logic added here.

## Out of scope

- **Schema runtime *validation* of tool outputs at dispatch time.** This plan adds (a) a *manifest-time* check that every authored tool *declares* a schema, and (b) per-tool *unit tests* (S3a/S4a/S5a) that the handler's `structuredContent` parses against its own schema. Validating *every live `tools/call` response* against the schema in the dispatcher hot path is a separate, larger piece of work — it gets its own plan if a regression makes the investment worth it.
- **Retrofitting Type 2 upstream sources.** Type 2 servers (`aviation-weather` today; whatever `npx --yes <pkg>` or `command:` entry the customer adds) advertise whatever their upstream `tools/list` returns. Strict mode emits a WARN naming the gap; we don't attempt to monkey-patch upstream MCPs to inject schemas. Customers who care can upgrade the upstream package, replace the Type 2 with a Type 1 wrapper they author, or knowingly accept "no hydration for this server" via `STRICT_OUTPUT_SCHEMA=0`.
- **Backwards-compatibility shim for older tools.** `STRICT_OUTPUT_SCHEMA=0` is the escape hatch. We do not infer schemas from runtime output samples.
- **`structuredContent` for Type 2 servers.** Same boundary as schema declaration: the connector forwards whatever upstream returns. If they populate it, controller wins. If not, the controller can fall back to JSON-parsing `content[0].text` as a graceful-degradation path — but that's a controller-side decision, not a connector concern.

## Verification at end of branch

```bash
git switch feature/output-schema
npm install && npm run build
cd packages/connector && npm test                       # all tests pass, incl. new validate.test.ts
cd ../.. && ./scripts/start-connector.sh                # boots clean (default STRICT=1)
# Inspector → Available Tools panel → every tool shows an outputSchema in its card
```

Then a controller-side smoke test from the dev who raised the question: write `{{ hydrate:crm.get_customer.name }}` in a procedure, fire a call, confirm the projection resolves to the customer's first name.

## Risks

- **Twilio SDK shape drift.** The `apis.*` schemas are pinned to today's response shape. A Twilio SDK upgrade that changes a field name silently invalidates the schema (the strict check still passes — schema is *declared*, just wrong). Mitigation: each `apis.*` schema gets a comment linking to the Twilio API docs page; schema review is part of any future Twilio SDK bump.
- **Boot fails for customers running a stale image after S6.** Once strict mode is default, an older image with one of our tools missing a schema fails-fast at boot. Mitigation: S6's commit message documents the env-var override, and customers can roll forward to the next image (which has all schemas in place).
