# TWILIO-MCP-PROMPT — Plan

> **Goal.** Restructure [`mcp/bundled/twilio/`](../../mcp/bundled/twilio/) from protocol-first (`tools/<service>/`) to service-first (`<service>/{tools,prompts,resources}/`), then add prompts + resources to every service group, with agent-assisted payments as the worked end-to-end example. The MCP should be able to **explain itself** to an LLM — especially for stateful, multi-step flows like agent-assisted payments where the model needs guidance at every capture step and a place to read live payment state.
>
> **Why.** Today every Twilio tool is just a function with an input/output schema. That works for stateless calls (`messages_create`, `lookups_fetch`). It does NOT work for stateful flows where the LLM needs to know *what to do next* and *where it is in a sequence*. MCP defines two surfaces for exactly this:
> - **Prompts** are versioned instruction templates the LLM can fetch via `prompts/get`. They scaffold multi-turn behavior the way TwiML scaffolds IVR flows.
> - **Resources** are read-only state the LLM can poll via `resources/read`. For payments, that means `payment://{callSid}/{paymentSid}/status` exposing the live `{token, paymentCardNumber, paymentCardType, expirationDate, securityCode, postalCode}` mask as Twilio's `<Payments>` capture progresses.
>
> Reference repo: <https://github.com/deshartman/twilio-agent-payments-mcp-server/tree/main/src> — same author, but the agent-pay one uses the Twilio `<Payments>` resource (live-call API) where the bundled `voice_pay.ts` here just emits the TwiML `<Pay>` verb (one-shot IVR). They serve different use cases and BOTH ship in this plan.
>
> **Branch.** `feature/twilio-mcp-prompts` (cut from `main`, do not push to origin per memory `feedback_feature_branches_local_only`).
>
> **Status: completed 2026-06-27.**

## Decisions locked in (from the clarifying round on 2026-06-26)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Folder layout: service-first** — each service is a top-level folder containing `tools/`, `prompts/`, `resources/` subdirectories. | Matches user phrasing "bring out the protocol resources per tool type". Service grouping survives — adding agent-pay's 5 tools + 7 prompts + 1 resource to a flat layout would drown the existing tools. |
| D2 | **Scope: restructure + agent-pay end-to-end + boilerplate prompts/resources for every service group.** | User intent: "going forward, we should use this approach". Stub prompts/resources for messaging/voice/verify/email/segment/lookups now so the pattern is set; flesh them out incrementally as real use cases arise. Agent-pay is the proof-of-concept that lands fully working. |
| D3 | **Keep `voice_pay.ts` alongside the new agent-pay flow.** | TwiML `<Pay>` (IVR) and `<Payments>` (live-call agent-assisted) are different APIs serving different use cases. Removing `voice_pay` is a backwards-compat break for any existing TwiML-based caller. |
| D4 | **`server.ts` keeps explicit imports, NOT auto-discovery.** | The four creds-gated groups (Twilio / SendGrid / Segment-read / Segment-write) are conditional static registration today. Auto-discovery would force the gating into a runtime filter. Predictability + inspectable boot logic wins. Import paths update; the gating logic doesn't. |

## Why this matters beyond payments (the load-bearing point)

Re-read [CLAUDE.md](../../CLAUDE.md) §"Schema declaration follows the trust boundary" — tools we author declare `outputSchema` so the controller's procedure UI can `{{ hydrate:<server>.<tool>.<field> }}` and type-check it. Prompts and resources extend the *same* boundary: tools we author should also ship **conversational scaffolding** (prompts) and **state surfaces** (resources) for procedure authors and runtime LLMs to use.

For Twilio specifically: payments, verify, voice transcription, and conversation-relay all have multi-step semantics where the LLM benefits from explicit guidance ("you've just captured the card number, ask for expiration date next") and live state ("here's the masked PAN we have so far"). A bare tool inventory leaves the LLM guessing at the flow. Prompts and resources are how we encode that flow without baking it into individual tool descriptions.

## New folder structure (concrete tree)

```
mcp/bundled/twilio/
├── README.md                          # rewritten — service-first layout + agent-pay example
├── package.json                       # unchanged (twilio SDK only)
├── server.ts                          # rewritten — new import paths, gating logic intact
├── twilio-client.ts                   # unchanged
├── sendgrid-client.ts                 # unchanged
├── segment-profile-client.ts          # unchanged
├── segment-tracker.ts                 # unchanged
├── status-callback.ts                 # unchanged (used by both voice_pay and agent-pay)
│
├── messaging/
│   ├── tools/
│   │   ├── messages_create.ts          # moved from tools/messaging/
│   │   ├── messages_fetch.ts
│   │   ├── messaging_services_fetch.ts
│   │   └── content_templates_fetch.ts
│   ├── prompts/
│   │   └── messaging_overview.ts       # NEW — single self-documenting prompt
│   └── resources/                       # NEW — empty for now; reserved
│
├── voice/
│   ├── tools/
│   │   ├── calls_create.ts             # moved from tools/voice/
│   │   ├── calls_fetch.ts
│   │   ├── voice_say.ts
│   │   ├── voice_play.ts
│   │   ├── voice_dial.ts
│   │   ├── voice_pay.ts                # KEPT — TwiML <Pay> verb, IVR use case
│   │   ├── voice_transcription_start.ts
│   │   ├── voice_transcription_stop.ts
│   │   │
│   │   ├── agent_pay_start.ts          # NEW — live-call <Payments>.create
│   │   ├── agent_pay_capture_card.ts   # NEW — <Payments>.update capture=payment-card-number
│   │   ├── agent_pay_capture_exp.ts    # NEW — <Payments>.update capture=expiration-date
│   │   ├── agent_pay_capture_cvc.ts    # NEW — <Payments>.update capture=security-code
│   │   └── agent_pay_complete.ts       # NEW — <Payments>.update status=complete
│   │
│   ├── prompts/
│   │   ├── voice_overview.ts           # NEW — when to use which voice tool
│   │   ├── agent_pay_start_capture.ts  # NEW — kick-off instructions for the LLM
│   │   ├── agent_pay_card_number.ts    # NEW — prompts during card-number capture
│   │   ├── agent_pay_expiration.ts     # NEW
│   │   ├── agent_pay_security_code.ts  # NEW
│   │   ├── agent_pay_finish.ts         # NEW
│   │   ├── agent_pay_completion.ts     # NEW
│   │   └── agent_pay_error.ts          # NEW
│   │
│   └── resources/
│       └── agent_payment_status.ts     # NEW — payment://{callSid}/{paymentSid}/status
│
├── verify/
│   ├── tools/
│   │   ├── verify_send.ts              # moved
│   │   ├── verify_check.ts
│   │   └── verify_services_fetch.ts
│   ├── prompts/
│   │   └── verify_overview.ts          # NEW — OTP flow guidance (send → wait → check)
│   └── resources/                       # NEW — empty for now; reserved
│
├── lookups/
│   ├── tools/
│   │   └── lookups_fetch.ts
│   ├── prompts/
│   │   └── lookups_overview.ts         # NEW — when to call (validation, line-type, caller-name)
│   └── resources/                       # NEW — empty for now; reserved
│
├── email/
│   ├── tools/
│   │   ├── email_send.ts
│   │   ├── email_fetch.ts
│   │   ├── email_search.ts
│   │   └── email_templates_fetch.ts
│   ├── prompts/
│   │   └── email_overview.ts           # NEW — templates vs raw; tracking; common errors
│   └── resources/                       # NEW — empty for now; reserved
│
└── segment/
    ├── tools/
    │   ├── segment_profile_traits.ts
    │   ├── segment_profile_events.ts
    │   ├── segment_profile_external_ids.ts
    │   ├── segment_identify.ts
    │   └── segment_track.ts
    ├── prompts/
    │   └── segment_overview.ts         # NEW — when to read vs write; profile vs event
    └── resources/                       # NEW — empty for now; reserved
```

**Note: empty `resources/` directories are intentional.** They establish the convention so a future contributor knows where the resource files go without having to invent the layout. The SDK's drop-in scanner gracefully handles empty/missing category dirs ([`packages/connector/src/sdk/dropin-discovery.ts:27`](../../packages/connector/src/sdk/dropin-discovery.ts#L27) — missing dir → `[]`). For `server.ts` (explicit imports) the empty dirs are pure scaffolding.

## Test layout (mirrors source)

```
packages/connector/tests/mcp-tools/apis/
├── voice/
│   ├── voice_pay.test.ts               # already exists, update import path
│   ├── agent_pay_start.test.ts         # NEW
│   ├── agent_pay_capture_card.test.ts  # NEW
│   ├── agent_pay_capture_exp.test.ts   # NEW
│   ├── agent_pay_capture_cvc.test.ts   # NEW
│   └── agent_pay_complete.test.ts      # NEW
└── … (other service test dirs update import paths only; no new tests for prompts yet)
```

Per [CLAUDE.md](../../CLAUDE.md) §"Schema declaration follows the trust boundary": every NEW Type 1 tool must have a per-tool test pinning `outputSchema` declaration AND the success-path `structuredContent` round-trip. The 5 new agent-pay tools need 5 new tests. Existing tests change import paths only.

**Prompts/resources tests** — deferred until W-T (test workstream) below documents the helper shape. The reference repo doesn't test prompts/resources either; the boot-time `tools/list` + `prompts/list` + `resources/list` from a smoke run is the regression backstop for now.

## Workstreams

Five workstreams. **W-S → W-A → W-P → W-T → W-D** in order. Each is a separate commit on `feature/twilio-mcp-prompts` so the diff stays reviewable.

### W-S — Service-first restructure (mechanical move)

**Goal.** Move every existing tool file from `tools/<service>/<tool>.ts` → `<service>/tools/<tool>.ts`. Update [`server.ts`](../../mcp/bundled/twilio/server.ts) import paths. No behavior change.

**Files moved (24 tool files):**

| From | To |
|---|---|
| `tools/messaging/messages_create.ts` | `messaging/tools/messages_create.ts` |
| `tools/messaging/messages_fetch.ts` | `messaging/tools/messages_fetch.ts` |
| `tools/messaging/messaging_services_fetch.ts` | `messaging/tools/messaging_services_fetch.ts` |
| `tools/messaging/content_templates_fetch.ts` | `messaging/tools/content_templates_fetch.ts` |
| `tools/voice/calls_create.ts` | `voice/tools/calls_create.ts` |
| `tools/voice/calls_fetch.ts` | `voice/tools/calls_fetch.ts` |
| `tools/voice/voice_say.ts` | `voice/tools/voice_say.ts` |
| `tools/voice/voice_play.ts` | `voice/tools/voice_play.ts` |
| `tools/voice/voice_dial.ts` | `voice/tools/voice_dial.ts` |
| `tools/voice/voice_pay.ts` | `voice/tools/voice_pay.ts` |
| `tools/voice/voice_transcription_start.ts` | `voice/tools/voice_transcription_start.ts` |
| `tools/voice/voice_transcription_stop.ts` | `voice/tools/voice_transcription_stop.ts` |
| `tools/verify/verify_send.ts` | `verify/tools/verify_send.ts` |
| `tools/verify/verify_check.ts` | `verify/tools/verify_check.ts` |
| `tools/verify/verify_services_fetch.ts` | `verify/tools/verify_services_fetch.ts` |
| `tools/lookups/lookups_fetch.ts` | `lookups/tools/lookups_fetch.ts` |
| `tools/email/email_send.ts` | `email/tools/email_send.ts` |
| `tools/email/email_fetch.ts` | `email/tools/email_fetch.ts` |
| `tools/email/email_search.ts` | `email/tools/email_search.ts` |
| `tools/email/email_templates_fetch.ts` | `email/tools/email_templates_fetch.ts` |
| `tools/segment/segment_profile_traits.ts` | `segment/tools/segment_profile_traits.ts` |
| `tools/segment/segment_profile_events.ts` | `segment/tools/segment_profile_events.ts` |
| `tools/segment/segment_profile_external_ids.ts` | `segment/tools/segment_profile_external_ids.ts` |
| `tools/segment/segment_identify.ts` | `segment/tools/segment_identify.ts` |
| `tools/segment/segment_track.ts` | `segment/tools/segment_track.ts` |

**Use `git mv`** so history follows.

**Empty `prompts/` and `resources/` dirs** — create with a `.gitkeep` placeholder OR a single stub file. Choose `.gitkeep` for the empty `resources/` dirs (no real content yet); the prompts dirs all land at least one file in W-P, so no `.gitkeep` needed there.

**Inside-file changes:**
- **None within moved tool files.** They import from `@mcp-shim/connector/sdk` and `twilio` — no relative imports to update. Verify with a grep:
  ```bash
  grep -rE '^\s*import.+\.\./|^\s*import.+from\s+"\./' mcp/bundled/twilio/{messaging,voice,verify,lookups,email,segment}/tools/
  ```
  Should return nothing.

**[`server.ts`](../../mcp/bundled/twilio/server.ts) changes:**
- 25 import statements update (lines 5-31). Pattern: `./tools/<service>/<tool>.js` → `./<service>/tools/<tool>.js`.
- Group the imports by service for readability:
  ```ts
  // Messaging
  import { messagesCreate } from "./messaging/tools/messages_create.js";
  // ...
  // Voice
  import { callsCreate } from "./voice/tools/calls_create.js";
  // ...
  ```
- Creds-gating logic ([server.ts:77-159](../../mcp/bundled/twilio/server.ts#L77-L159)) — **no change**.

**Test files** ([`packages/connector/tests/mcp-tools/apis/`](../../packages/connector/tests/mcp-tools/apis/)) update their `import { … } from "@mcp/bundled/twilio/<service>/tools/<tool>.js"` paths. The `@mcp` alias resolves through [`packages/connector/tsconfig.json`](../../packages/connector/tsconfig.json) — same alias, deeper path.

**Verification (W-S):**
1. `npm run build` — clean.
2. `cd packages/connector && npm test` — all 202+ pre-existing tests still pass.
3. Manual: `./scripts/start-connector.sh`, hit the inspector at <http://localhost:9090/>, confirm the `apis` MCP shows all 21 tools (or however many the creds-set permits).

**Commit message:** `Restructure mcp/bundled/twilio/ to service-first layout`

### W-A — Agent-assisted payments (tools + prompts + resource)

**Goal.** Ship the worked example end-to-end. After this workstream, an LLM driving a live call can:
1. Call `agent_pay_start` to launch a `<Payments>` capture on the live call.
2. Receive prompts (`agent_pay_card_number`, `agent_pay_expiration`, `agent_pay_security_code`) at each capture step.
3. Read live capture state from `payment://{callSid}/{paymentSid}/status`.
4. Call `agent_pay_capture_*` to advance through each step.
5. Call `agent_pay_complete` to finalize (token or charge).

**Reference**: <https://github.com/deshartman/twilio-agent-payments-mcp-server> — the design is well-trodden, this is a port into the bundled-MCP shape.

**Twilio API used**: the `<Payments>` real-time API ([Calls.payments resource](https://www.twilio.com/docs/voice/api/payment-resource)) — POST `/2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}/Payments.json` to start; POST `/2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}/Payments/{Sid}.json` to update. Status callbacks land on the existing `status-callback.ts` plumbing — agent-pay subscribes via `onStatusCallback` and correlates by `PaymentSid`.

**Distinguishing from `voice_pay.ts` (the TwiML `<Pay>` verb)**: `voice_pay` emits XML the caller paste into an `action`/`twiml` URL — Twilio runs the gather flow ENTIRELY on its side, the LLM never sees intermediate state. `agent_pay_*` operates on a LIVE call where the LLM is the conversational driver, choosing when to advance steps, reacting to errors, and reading masked state mid-capture.

**5 new tool files in [`mcp/bundled/twilio/voice/tools/`](../../mcp/bundled/twilio/voice/tools/):**

| Tool | Twilio API call | Input schema (sketch) | Output schema (sketch) |
|---|---|---|---|
| `agent_pay_start` | `client.calls(callSid).payments.create({...})` | `{callSid, statusCallback?, paymentConnector?, paymentMethod?, chargeAmount?, currency?, description?, postalCode?, securityCode?, tokenType?, validCardTypes?}` | `{paymentSid, status, accountSid, callSid, ...}` |
| `agent_pay_capture_card` | `.payments(paymentSid).update({capture: "payment-card-number"})` | `{callSid, paymentSid}` | `{paymentSid, capture, status}` |
| `agent_pay_capture_exp` | `.payments(paymentSid).update({capture: "expiration-date"})` | `{callSid, paymentSid}` | `{paymentSid, capture, status}` |
| `agent_pay_capture_cvc` | `.payments(paymentSid).update({capture: "security-code"})` | `{callSid, paymentSid}` | `{paymentSid, capture, status}` |
| `agent_pay_complete` | `.payments(paymentSid).update({status: "complete"})` | `{callSid, paymentSid}` | `{paymentSid, status, paymentToken?, paymentCardNumber?, paymentCardType?, expirationDate?}` |

All five take a Twilio client instance via the factory pattern (`export function agentPayStart(client: TwilioClient): Tool {…}`) so they're injectable for testing, same shape as the existing `messagesCreate(twilio)` / `callsCreate(twilio)` / etc.

**No resource. No payment-state module.** (Decided 2026-06-26 after the resource pattern got challenged on simplicity grounds.)

The earlier draft proposed `agent_payment_status` at `payment://{callSid}/{paymentSid}/status` backed by a Map of status-callback events. That gave the LLM a clean read-side surface — but it requires a state module, a listener registration, an LRU eviction policy, and an MCP resource template. All for a feature whose only real customer is "the LLM wants to read the masked PAN between capture steps."

Reality check: an LLM driving the flow can wait for capture completion without polling. The capture tools return promptly when Twilio confirms the capture step has begun; the LLM then waits for the human caller to enter digits (the human is the slow path, not the capture API). When the next `agent_pay_capture_*` returns successfully, the previous step is done. No polling needed.

Consequences:
- No `voice/payment-state.ts`.
- No `agent_payment_status` resource. `voice/resources/.gitkeep` placeheld until a real resource lands.
- `agent_pay_start` allocates the status-callback URL (required by the Twilio SDK) but does NOT install a listener — any procedure code that wants to subscribe does so directly via `onStatusCallback` from `status-callback.ts`.
- Prompts no longer reference `payment://...` URIs. They guide the LLM on conversational behavior (what to say, when to stay quiet, when to retry) without claiming a read-side state surface.

If a future use case genuinely needs the resource (e.g. a procedure that wants to read the final paymentToken without subscribing to callbacks), revisit. Until then this is YAGNI territory.

**7 new prompt files in [`mcp/bundled/twilio/voice/prompts/`](../../mcp/bundled/twilio/voice/prompts/):**

Each prompt is a versioned instruction template the LLM fetches via `prompts/get`. Names follow the reference repo:

| Prompt | When to use | Args |
|---|---|---|
| `agent_pay_start_capture` | At the start of a payment ask. Tells the LLM how to introduce the capture flow and what to say to the caller. | `{callSid}` |
| `agent_pay_card_number` | After `agent_pay_capture_card` returns. Guides the LLM through walking the caller through entering card digits, reading back the mask. | `{callSid, paymentSid}` |
| `agent_pay_expiration` | After `agent_pay_capture_exp`. | `{callSid, paymentSid}` |
| `agent_pay_security_code` | After `agent_pay_capture_cvc`. | `{callSid, paymentSid}` |
| `agent_pay_finish` | Before `agent_pay_complete`. Reads back the full masked state from the resource, asks caller to confirm. | `{callSid, paymentSid}` |
| `agent_pay_completion` | After `agent_pay_complete` returns successfully. Closes the flow politely. | `{callSid, paymentSid, paymentToken?}` |
| `agent_pay_error` | On any `errorType` from a status callback. Handles retries, escalation to human agent. | `{callSid, paymentSid, errorType}` |

Each prompt registers via `server.registerPrompt(name, {description, argsSchema}, handler)`. The handler returns `{messages: [{role: "user", content: {type: "text", text: "..."}}]}`. See [`mcp/local/sample/prompts/weather-briefing.ts`](../../mcp/local/sample/prompts/weather-briefing.ts) for the worked SDK shape — same SDK, same idioms.

**Creds gating** — agent-pay tools are part of the Twilio group (need `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`). The new server.ts conditional in W-S already handles this — agent-pay tools sit in the `if (twilioMissing.length === 0)` block alongside the other Twilio tools.

**5 new test files** in [`packages/connector/tests/mcp-tools/apis/voice/`](../../packages/connector/tests/mcp-tools/apis/voice/) — one per new tool, matching the existing `voice_pay.test.ts` shape: mock the Twilio client (or use the `captureRegistration` helper), call the handler, assert `outputSchema.parse(result.structuredContent)` succeeds and the right Twilio method was called.

**Commit message:** `Add agent-assisted payments (5 tools + 7 prompts + 1 resource template)`

### W-P — Service-overview prompts (the "self-documenting MCP" pattern)

**Goal.** Ship one `<service>_overview` prompt per service group. Each is a single, opinionated, versioned instruction template that explains "when to use which tool in this service, with what tradeoffs". Goal: an LLM that just connected to the MCP can fetch `prompts/get messaging_overview` (etc.) and become productive without reading every tool description.

This is the "self-documenting" property the user called out: "The MCP itself needs to be able to explain how it works."

**6 new prompt files** (one per service group; voice already gets agent-pay prompts in W-A):

| File | Path | Content shape |
|---|---|---|
| `messaging_overview.ts` | `mcp/bundled/twilio/messaging/prompts/messaging_overview.ts` | "Use messages_create for sending. Choose SMS vs WhatsApp vs RCS by channel arg. Use contentSid for templated, body for ad-hoc. Look up by SID via messages_fetch. Inspect a Messaging Service config via messaging_services_fetch." |
| `voice_overview.ts` | `mcp/bundled/twilio/voice/prompts/voice_overview.ts` | "Two payment paths: voice_pay (TwiML <Pay> for one-shot IVR — Twilio runs the gather flow end-to-end) vs agent_pay_* (live-call <Payments> for LLM-driven capture, see agent_pay_start_capture prompt). Use voice_say / voice_play / voice_dial for TwiML composition. voice_transcription_start/stop for real-time transcripts." |
| `verify_overview.ts` | `mcp/bundled/twilio/verify/prompts/verify_overview.ts` | "Flow: verify_send → caller receives OTP → verify_check. verify_services_fetch inspects a Verify service config. Use channel='sms' or 'call' for delivery. Costs apply on send; check is free." |
| `lookups_overview.ts` | `mcp/bundled/twilio/lookups/prompts/lookups_overview.ts` | "Call lookups_fetch to validate any phone number before using it elsewhere — format normalization, country detection, line-type, caller-name (when subscribed). Free, idempotent." |
| `email_overview.ts` | `mcp/bundled/twilio/email/prompts/email_overview.ts` | "email_send for outbound (use templateId + dynamic_template_data for templated; text/html for raw). email_fetch / email_search for delivery + event timeline (Pro+ SendGrid plan needed). email_templates_fetch to inspect a template before sending." |
| `segment_overview.ts` | `mcp/bundled/twilio/segment/prompts/segment_overview.ts` | "Two flows: READ profile via segment_profile_{traits,events,external_ids}; WRITE via segment_identify (traits) or segment_track (events). Use userId when known; anonymousId for pre-auth interactions. Profile reads need SEGMENT_PROFILE_PAT; writes need SEGMENT_WRITE_KEY." |

**Authoring rule** — each overview prompt:
1. Takes **zero arguments** (no `argsSchema`). It's a static template the LLM fetches once.
2. Has a **`description`** that explains what the prompt is for (e.g., "Quick reference for which Twilio messaging tool to call in which situation.").
3. Returns ONE `messages: [{role: "user", content: {type: "text", text: "..."}}]` entry. The text is the actual guidance — keep it tight (under 30 lines of prose).
4. References tool names verbatim so the LLM can ground the guidance against `tools/list`.

Worked example: copy [`mcp/local/sample/prompts/weather-briefing.ts`](../../mcp/local/sample/prompts/weather-briefing.ts) shape, drop `argsSchema`, replace the text.

**No new tests in W-P.** The boot-time `prompts/list` count being correct is the regression backstop; manual inspector check confirms each overview prompt is reachable.

**`server.ts` changes (W-P):** add the 6 new prompt imports + push them into the same gating blocks as their parent tools.

```ts
// Top of server.ts (after tool imports):
import { messagingOverview } from "./messaging/prompts/messaging_overview.js";
import { voiceOverview } from "./voice/prompts/voice_overview.js";
import { verifyOverview } from "./verify/prompts/verify_overview.js";
import { lookupsOverview } from "./lookups/prompts/lookups_overview.js";
import { emailOverview } from "./email/prompts/email_overview.js";
import { segmentOverview } from "./segment/prompts/segment_overview.js";
// Plus the agent-pay prompts from W-A — already imported there.

// Build prompts array alongside tools, gated by the same creds blocks:
const prompts: Prompt[] = [];
if (twilioMissing.length === 0) {
  prompts.push(
    messagingOverview,
    voiceOverview,
    verifyOverview,
    lookupsOverview,
    // W-A's 7 agent-pay prompts:
    agentPayStartCapture, agentPayCardNumber, agentPayExpiration,
    agentPaySecurityCode, agentPayFinish, agentPayCompletion, agentPayError,
  );
}
if (sendgridMissing.length === 0) {
  prompts.push(emailOverview);
}
if (segmentReadMissing.length === 0 || segmentWriteMissing.length === 0) {
  prompts.push(segmentOverview);
  // Segment overview surfaces if EITHER read or write creds are present —
  // the prompt itself explains which flows the LLM can use given current creds.
}

// And in the factory call:
await createMcpHttpServer({
  name: "apis",
  tools,
  prompts,
  resources, // W-A's agent_payment_status resource, gated on twilio creds
  envKeys: allEnvKeys,
});
```

**Commit message:** `Add service-overview prompts to every Twilio service group`

### W-T — Tests + verification (already partially scoped above)

**New work in W-T (beyond what W-A already lists):**

1. **Update import paths** in every existing `tests/mcp-tools/apis/**` file so they point at the new `<service>/tools/<tool>.ts` paths. Mechanical sed-style change — no logic changes.
2. **Add the 5 agent-pay tool tests** (already scoped in W-A).
3. **(Optional) One `prompts/list` smoke test** at [`packages/connector/tests/mcp-tools/apis/`](../../packages/connector/tests/mcp-tools/apis/) — spawns the Twilio MCP child, calls `prompts/list`, asserts the count matches expectations (e.g. 13 when all creds present). Pin the contract that "every overview + agent-pay prompt registers". Skip if it's a lot of plumbing for one assertion — the boot-time inspector check is sufficient.

**Commit message:** `Update test import paths; add 5 agent-pay tool tests`

### W-D — Docs (CLAUDE.md + READMEs)

Per memory `feedback_docs_update_before_merge`: update docs before the merge-to-main commit.

**Files updated:**

1. **[`mcp/bundled/twilio/README.md`](../../mcp/bundled/twilio/README.md)** — rewrite the "Tools" section to be service-grouped (matching the new layout). Add a new "Prompts" section listing all overview prompts and the agent-pay prompts. Add a new "Resources" section listing `payment://{callSid}/{paymentSid}/status`. Add an "Agent-assisted payments" section explaining the difference from `voice_pay` and walking through the start → capture → complete flow.

2. **[`CLAUDE.md`](../../CLAUDE.md)** — two edits:
   - Topology paragraph mentions `mcp/bundled/twilio/` as "Type 1 hand-written shape (Node `server.ts` + per-folder `package.json` for the `twilio` SDK)". Update the parenthetical to: "service-first layout: `<service>/{tools,prompts,resources}/` under the bundle root". One-line change.
   - "Sample tools" paragraph — Twilio inventory needs the 5 new agent-pay tools added (messaging — `messages_create`, `messages_fetch`, …, voice — `calls_create`, …, `voice_pay`, `agent_pay_start`, `agent_pay_capture_card`, `agent_pay_capture_exp`, `agent_pay_capture_cvc`, `agent_pay_complete`, voice transcription stays, …). The reader gets the full tool list from one spot.

3. **[`packages/connector/README.md`](../../packages/connector/README.md) §"Author a Type 1 MCP"** — add a brief note: "For multi-tool MCPs, prefer a service-first folder layout (`<service>/{tools,prompts,resources}/`) over a flat `tools/` directory — see `mcp/bundled/twilio/` for the worked example." Two-line addition.

4. **NOT in scope for this plan**: [`docs/AUTHOR-LOCAL-MCP.md`](../../docs/AUTHOR-LOCAL-MCP.md) — that doc is for customer drop-ins which stay flat (one folder, no service grouping). The service-first layout is specifically for **bundled, multi-service MCPs**.

Per memory `feedback_no_plans_in_customer_docs`: NO links from `mcp/bundled/twilio/README.md` or `CLAUDE.md` or `packages/connector/README.md` to this plan file. The plan file is internal-only.

**Commit message:** `Docs: service-first Twilio layout + agent-assisted payments`

## End-to-end verification (before merging to main)

1. **Build clean.** `npm run build` from the repo root.
2. **All tests pass.** `cd packages/connector && npm test` — expect 207+ tests (202 pre-existing + 5 new agent-pay tests). Existing tests must still pass; their import paths change but behavior doesn't.
3. **Inspector smoke (no creds).** `./scripts/start-connector.sh` with empty Twilio/SendGrid/Segment creds in `mcp/bundled/twilio/.env`. Inspector at <http://localhost:9090/> shows the `apis` MCP registered with **0 tools** but **0 prompts** (no creds = no prompts). Confirms creds gating still works for both tools and prompts.
4. **Inspector smoke (Twilio creds only).** Add `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` to `.env`. Inspector shows:
   - **21 tools** under `apis`: 16 pre-existing Twilio tools + 5 new agent-pay tools.
   - **11 prompts** under `apis`: 4 overview prompts (messaging/voice/verify/lookups) + 7 agent-pay prompts.
   - **0 resources** — no agent_payment_status resource (simplified out 2026-06-26).
5. **Manual `prompts/get` round-trip.** From the inspector or via a direct `tools/list`-style probe, fetch `agent_pay_start_capture` and verify the returned messages array is well-formed.
6. **Manual `resources/read` round-trip.** Fetch `payment://test-call/test-payment/status` against the empty Map — expect either a "not found" error OR an empty `{paymentSid, ...status fields all null}` shape (author's choice; document the chosen behavior in the resource file).
7. **Live agent-pay flow** (optional, gated on a real Twilio test account with a paymentConnector configured):
   - Place a call to a Twilio number that runs a TwiML app pointing at the connector-side webhook.
   - From the inspector, call `agent_pay_start({callSid: "<live SID>"})` — Twilio returns a paymentSid, capture state populates in the resource Map.
   - Call `agent_pay_capture_card` — Twilio prompts the caller; status callbacks land and update the Map.
   - Read `payment://<callSid>/<paymentSid>/status` — see the masked PAN appear as digits arrive.
   - Continue through expiration, CVC, complete.
   - Skip this in the plan's required verification; document any blockers if a live test is impossible.

## Open questions / things to flag

1. ~~**Payment state Map sharing across tools.**~~ **RESOLVED 2026-06-26**: stateless design. No Map. Resource calls `client.calls(callSid).payments(paymentSid).fetch()`. See W-A resource section.

2. ~~**TTL on payment state entries.**~~ **RESOLVED 2026-06-26**: no local state, no TTL. Twilio manages payment-object lifetime.

3. ~~**Status callback URL plumbing.**~~ **RESOLVED 2026-06-26**: `statusCallback` is an OPTIONAL arg to `agent_pay_start`. Callers who want push notifications pass `await getDefaultStatusCallback()` themselves; agent-pay doesn't allocate it by default. No changes to `status-callback.ts`.

4. **Prompts vs the controller-side Procedure UI.** Prompts live in the MCP server and are fetched at LLM-runtime. The controller's Procedure UI is authored on a different surface (hand-written, hydrated with `{{ ... }}` expressions). Are we accidentally duplicating intent? **Answer: no, different layers.** Prompts are LLM-facing scaffolding for tool sequencing; Procedure UI is controller-side authoring of agent workflows. An agent procedure CAN reference a prompt by name (`call prompt agent_pay_start_capture, then loop through capture steps`) — that's the integration point. Worth noting in the docs but not a blocker.

5. **`<Payments>` API account requirements.** Twilio's `<Payments>` resource requires a configured **payment connector** on the customer's Twilio account (Stripe, Braintree, etc.). The MCP can't bootstrap that. Document the prerequisite in the README; the `agent_pay_start` tool description should also mention it.

6. **Live-call test impossible without a payment connector + a live PSTN inbound.** This is the realistic blocker for end-to-end verification step 7 above. Document the gap; ship with unit-test coverage and an inspector-side check that the tools/prompts/resources REGISTER correctly, even if we can't drive the full Twilio API end-to-end in the test environment.

## Sequencing summary

| Order | Workstream | Files changed (approx) | Verification |
|---|---|---|---|
| 1 | W-S — Restructure | 24 file moves + `server.ts` imports + 23 test import paths | `npm test` passes |
| 2 | W-A — Agent-pay | 5 new tool files + 7 prompt files + 1 resource file + `payment-state.ts` helper + 5 new test files + `server.ts` registration | `npm test` passes; inspector shows new tools/prompts/resources |
| 3 | W-P — Service overviews | 6 new prompt files + `server.ts` registration | inspector shows overview prompts |
| 4 | W-T — Tests | (already covered in W-A and W-S; W-T is the verification gate) | `npm test` passes |
| 5 | W-D — Docs | `README.md` (twilio bundle), `CLAUDE.md`, `packages/connector/README.md` | manual read-through |
| 6 | Merge | `git merge --no-ff feature/twilio-mcp-prompts` into `main`, keep branch (memory `feedback_keep_feature_branches_after_merge`), do not push branch to origin (memory `feedback_feature_branches_local_only`) | clean main |

Mark `Status: completed YYYY-MM-DD` at the top of this file when the merge lands. Move to `.claude/plans/Done/` only if the broader plan-organisation pattern calls for it (check existing Done/ structure first).

## Out of scope (NOT in this plan)

- Conversation-relay specific tools / prompts. Twilio has a separate "Conversation Relay" product that uses different APIs and would need its own MCP service group. Defer.
- TaskRouter prompts. Different product, different surface.
- Email *templates*-prompts (an "email_template_overview" that explains template authoring) — that's a longer doc; the basic `email_overview` is enough for now.
- Drop-in / customer-authored prompt patterns. This plan is bundle-specific; customer drop-ins remain flat (`tools/`, `prompts/`, `resources/` siblings) per `docs/AUTHOR-LOCAL-MCP.md`.
- Controller-side Procedure UI changes to consume the new prompts. The MCP exposes prompts; how the procedure UI surfaces them is a controller team concern.


