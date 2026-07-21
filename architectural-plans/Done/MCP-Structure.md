# Twilio MCP — Curated Tool Structure

> **Status: implemented (2026-06-12).** All 10 tools from the inventory below ship in
> `mcp/bundled/twilio/tools/` and are wired through `mcp/bundled/twilio/server.ts`.
> The MCP server name is `apis` (yaml entry: `- name: apis`) so the cloud qualifier
> `${author}.${serverName}.${toolName}` reads `twilio.apis.<verb>` →
> `twilio_apis_messages_create` on OpenAI's flattened tool surface.
> The grouped folder layout under `tools/messaging/`, `tools/voice/`, etc. described
> in "Implementation notes" was *not* applied — `tools/` is flat. Folder grouping is
> a future refactor.

## Problem

The official Twilio MCP (https://www.twilio.com/docs/ai/mcp) ships **two meta-tools** —
`twilio__search` and `twilio__retrieve` — that dynamically dispatch over the full Twilio
API surface (~1,800 endpoints, 30+ products). Total coverage, but every tool call costs
two LLM round-trips before any work happens (search → retrieve schema → call). For our
procedure-agent runtime that's the wrong altitude: procedure authors want to name a
verb in a prompt and have the connector dispatch it directly.

This plan curates a fixed, high-altitude tool set that mirrors the **Node SDK call shape**
(`client.<resource>.<action>`) so authors who already know the Twilio SDK can guess tool
names without docs.

## Design rules

1. **Mirror the SDK.** Tool name = `<resource>_<action>`, derived from
   `client.<resource>.<action>(...)`. Example: `client.messages.create` →
   `messages_create`. Sub-resources collapse with the parent: `client.calls(sid).recordings.list`
   → `call_recordings_list`.
2. **Underscore form.** Tool names stay in `[a-z0-9_]` for maximum MCP-client
   portability (slashes work in our connector but aren't universal).
3. **One tool per SDK call, not per channel.** SMS, WhatsApp, and RCS all go through
   `client.messages.create` with a `whatsapp:` / `rcs:` prefix on `to`/`from`. We expose
   **one** `messages_create` tool with a `channel` enum that does the prefixing
   internally — instead of three near-duplicate tools.
4. **80/20 cut, not full coverage.** If a procedure author needs an obscure endpoint
   they can add a Type 1 MCP under `mcp/local/`, or we extend this set. Don't ship a
   tool for every operation that exists.
5. **No `_list` tools.** Account-wide listings are not useful to a procedure — every
   `client.<resource>.list()` returns the entire account's history, not what the
   *current caller / current procedure run* did. Procedures get SIDs by *creating*
   things or by being handed them in their input; from there `_fetch` is the right
   verb. Adding `_list` would invite the LLM to scan the account for context that
   isn't its to read.
6. **No service administration.** This MCP does not create or delete Twilio Services
   (Messaging Services, Verify Services). Those are account-level configuration
   objects managed in the Console / IaC. The MCP only **lists**, **fetches**, and
   **acts on** existing Services (e.g. sending a message that references a
   `messagingServiceSid`). Same rule applies to any future `_services` resource
   (Conversations Services, Notify Services, etc.).

## Channel handling — `messages_create`

```
messages_create
  channel:  "sms" | "whatsapp" | "rcs"   // required; selects to/from prefix
  to:       string                       // E.164, no prefix — tool prepends
  body?:    string
  contentSid?: string                    // Content API template (WhatsApp/RCS)
  contentVariables?: Record<string, string>
  mediaUrl?: string[]                    // MMS / WhatsApp media
  from?:    string                       // overrides TWILIO_FROM_NUMBER /
                                         // TWILIO_WHATSAPP_FROM / TWILIO_RCS_AGENT
  messagingServiceSid?: string           // alternative to `from`
  statusCallback?: string
```

Internally:
- `channel: "whatsapp"` → prepend `whatsapp:` to `to`/`from`
- `channel: "rcs"` → prepend `rcs:` to `from` (RCS uses an agent ID, not a number)
- `channel: "sms"` → no prefix

The tool description tells the model: *"Sends a message over SMS, WhatsApp, or RCS.
For WhatsApp/RCS templated sends, set `contentSid`."*

## Tool inventory

### Messaging — `client.messages.*` (2 tools)

| Tool | SDK call | Notes |
|---|---|---|
| `messages_create`     | `client.messages.create`        | unified SMS/WhatsApp/RCS (above) |
| `messages_fetch`      | `client.messages(sid).fetch`    | by SID — typically the SID returned from `messages_create` |

Skipped: `messages.list` (rule 5); `messages.update` (niche — only useful for body
redaction, which is a compliance task done out-of-band); `messages.remove` (deletes a
log row, not a procedure operation); `messages.feedback`, `messages.media`
sub-resources.

### Messaging Services — `client.messaging.v1.services.*` (1 tool)

Read-only by rule 6. A Messaging Service is account-level configuration (sender pool,
fallback URL, opt-out keywords) — provisioned in the Console / IaC, then *referenced*
by procedures via `messagingServiceSid` on `messages_create`. The procedure already
knows the SID (from env / its input); fetching is just for inspecting capabilities.

| Tool | SDK call |
|---|---|
| `messaging_services_fetch`  | `client.messaging.v1.services(sid).fetch` |

Skipped: `create`, `update`, `remove` (rule 6); `list` (rule 5).
Skipped sub-resources (`phoneNumbers`, `shortCodes`, `alphaSenders`, `usAppToPerson`):
sender-pool config, same reasoning.

### Voice — `client.calls.*` (2 tools)

| Tool | SDK call | Notes |
|---|---|---|
| `calls_create`            | `client.calls.create`              | dial out; takes `twiml` *or* `url` |
| `calls_fetch`             | `client.calls(sid).fetch`          | by SID — typically the SID returned from `calls_create` |

Skipped: `calls.list` (rule 5); `calls.update` (mid-call redirect / hang-up — normally
TwiML-driven, niche from a procedure); `calls.remove` (deletes a log row); and
`recordings`, `events`, `payments`, `siprec`, `userDefinedMessage`, `streams`,
`transcriptions` sub-resources.

### Verify — `client.verify.v2.*` (3 tools)

The day-to-day Verify shape is **send OTP → check OTP**. Service config is provisioned
out-of-band (Console / IaC) per rule 6 — the procedure receives a `TWILIO_VERIFY_SERVICE_SID`
via env and uses it; it doesn't go shopping for one.

| Tool | SDK call | Notes |
|---|---|---|
| `verify_send`              | `client.verify.v2.services(sid).verifications.create`     | sends OTP via sms/call/email/whatsapp |
| `verify_check`             | `client.verify.v2.services(sid).verificationChecks.create`| validates submitted code |
| `verify_services_fetch`    | `client.verify.v2.services(sid).fetch`                    | inspect an existing Verify Service |

Conventions:
- `verify_send`/`verify_check` accept a `serviceSid` arg, defaulting to
  `TWILIO_VERIFY_SERVICE_SID` env var so most procedures don't pass it.
- `channel` arg on `verify_send` is `"sms" | "call" | "email" | "whatsapp"`
  (mirrors Verify's own enum, distinct from the Messages channel enum).

Skipped: `services.create` / `services.update` / `services.remove` (rule 6);
`services.list` (rule 5).
Also skipped: `entities`, `factors`, `challenges`, `webhooks`, `rateLimits`, `templates` —
configuration / push-2FA enrollment, not procedure-time operations.

### Lookup — `client.lookups.v2.*` (1 tool)

Lookup is one SDK call with a `fields` selector. Mirror that exactly:

| Tool | SDK call |
|---|---|
| `lookup_phone` | `client.lookups.v2.phoneNumbers(phoneNumber).fetch({ fields })` |

```
lookup_phone
  phoneNumber: string                   // E.164
  fields?: Array<                       // mirrors Lookup data packets
    "caller_name" | "sim_swap" | "call_forwarding" |
    "line_type_intelligence" | "line_status" | "identity_match" |
    "reassigned_number" | "sms_pumping_risk" |
    "phone_number_quality_score" | "pre_fill"
  >
```

One tool, one decision (which packets), priced per-packet by Twilio. Don't shard this
into 10 tools — the model picks `fields` the same way a developer would.

### Content (templates) — `client.content.v1.*` (1 tool)

Read-only at runtime. Content templates are *built* in the Console / Content Builder
(rule 6); a procedure picks one by SID (passed in via env / its input) and hands it to
`messages_create` for templated WhatsApp / RCS sends.

| Tool | SDK call |
|---|---|
| `content_templates_fetch` | `client.content.v1.contents(sid).fetch` |

Skipped: `contents.list` (rule 5).

## Deferred — full products skipped on purpose

Each is a self-contained product surface that doesn't fit "use the Twilio APIs from a
procedure." Recorded here so future readers don't re-litigate.

- **Conversations** (`client.conversations.v1.*`) — multi-channel persistent threads.
  Dropped on user request — different state model from one-shot `messages_create` and
  not currently exercised by any procedure. Add when a procedure needs threaded
  multi-channel state.
- **Voice — Conferences** (`client.conferences.*`) — mute/hold/kick on live
  conferences. Dropped on user request. Live-call control is normally driven by TwiML
  webhooks, not REST from a procedure.
- **Voice — Queues** (`client.queues.*`) — pre-TaskRouter queue primitive. Dropped on
  user request — modern customers use TaskRouter (also deferred), and queues without
  the routing layer aren't useful from a procedure.
- **Voice — Recordings** (`client.recordings.*`, `client.calls(sid).recordings.*`) —
  start/pause/stop on live recordings + account-wide recording inventory. Dropped on
  user request. Recording is normally configured at call-creation time (via TwiML or
  the `record` flag on `calls_create`), not driven mid-call from a procedure.
- **Phone Numbers (incoming)** (`client.incomingPhoneNumbers.*`) — number inventory.
  Dropped on user request — a procedure either knows the number it's sending from
  (env var) or doesn't need to.
- **TaskRouter** (`client.taskrouter.v1.*`) — runtime contact-center routing
  (tasks/workers/reservations). Dropped from the curated set on user request — sits
  closer to "build a contact center" than "use the Twilio APIs." Add only if a
  procedure needs to drive routing directly.
- **Studio** (`client.studio.v2.*`) — flow execution trigger/end. Dropped on user
  request. Procedures and Studio flows are parallel orchestration surfaces; running one
  from the other is mostly a workaround. Add if a customer specifically needs to
  invoke an existing Studio flow from a procedure.
- **Sync** (`client.sync.v1.*`) — runtime state primitives (documents, lists, maps,
  streams). Dropped on user request. Procedure state has its own home (the controller);
  Sync would create a second source of truth. Add only if a procedure needs to share
  state with a non-procedure client.
- **Usage** (`client.usage.records.*`) — billing/usage records. Dropped on user
  request — operational telemetry, not "using the API."
- **Monitor** (`client.monitor.v1.*`) — alerts/events diagnostics. Dropped on user
  request — operational telemetry, not "using the API."
- **Voice Intelligence / Conversation Intelligence** (`client.intelligence.v2.*`) —
  transcript analysis, custom operators. Worth adding once we have a procedure that
  needs post-call summarization; the shape is `submit transcript → fetch operator
  results`. Doc URL was 404 at write-time — verify SDK path before implementing.
- **Flex API** (`client.flexApi.*`) — Flex configuration, plugins, channels.
  Flex-specific admin and runtime is the Flex UI's job, not a procedure's.
- **Trust Hub / Regulatory** (`client.trusthub.v1.*`) — sender vetting, A2P 10DLC
  brand/campaign registration, regulatory bundles. One-time onboarding, all admin.
- **Numbers v2 / Bulk-Hosted-Numbers** (`client.numbers.v2.*`) — number porting,
  hosted number orders. Admin / procurement.
- **Trunking / Elastic SIP** (`client.trunking.v1.*`) — trunk configuration, IP ACLs,
  origination URIs. Admin.
- **Wireless / Super SIM / Microvisor** — IoT product surfaces. Out of scope unless
  a customer brings an IoT use case.
- **Video** (`client.video.v1.*`) — rooms, compositions, recordings. Different
  runtime model (browser SDK does the heavy lifting); Twilio is sunsetting Programmable
  Video for new customers.
- **Notify** (`client.notify.v1.*`) — push notification fan-out. Layered on top of
  primitive channel sends; if a procedure needs push, it's almost always single-target,
  so use the channel-specific SDK directly.
- **Pricing** (`client.pricing.v*.*`) — message/voice/number price lookups. Static
  data, better fetched once and cached than queried per procedure call.
- **Bulk Exports** (`client.bulkexports.v1.*`) — CSV exports of historical message/call
  data. Operational scale + runtime mismatch (jobs run for minutes); use direct SDK if
  needed.
- **Serverless** (`client.serverless.v1.*`) — Functions/Assets deploy API. Build-time,
  not runtime — only `services.logs` is runtime, and procedures rarely need to tail
  Functions logs through an MCP. Skip.
- **IAM / Organizations / SSO** (`client.iam.*`, organizations, accounts.subaccounts) —
  admin. Hard rule by user request.
- **Events / Sinks / Subscriptions** (`client.events.v1.*`) — event-streaming pipeline
  config. Admin.
- **Push 2FA / Authy legacy** (Verify factors/challenges) — already excluded from the
  Verify section; called out here for completeness.
- **Preview / Beta** namespaces — by definition unstable; pin to GA only.

If a customer surfaces a real procedure that needs one of these, lift it out of the
deferred list — don't pre-emptively add tools.

## Total surface

| Product                       | Tools |
|---                            |---|
| Messaging (SMS/WhatsApp/RCS)  | 2  |
| Messaging Services            | 1  |
| Voice — Calls                 | 2  |
| Verify                        | 3  |
| Lookup                        | 1  |
| Content templates             | 1  |
| **Total**                     | **10** |

10 curated tools vs. the official MCP's 2 meta-tools over 1,800 endpoints. Coverage of
"the operational shape a procedure cares about for *using* Twilio's communication
APIs at the moment" — send a message, place a call, run an OTP, look up a number,
fetch a Content template / Messaging Service / Verify Service the procedure was
already pointed at. No account-wide listings (rule 5), no service admin (rule 6), no
orchestration surfaces (TaskRouter / Studio), no state primitives (Sync), no
telemetry (Usage / Monitor), no live-call mutation (Conferences / Recordings),
no threaded state (Conversations).

## Phasing

| Phase | Adds                                                           | Total | Drives                          |
|---    |---                                                             |---    |---                              |
| **1** | Messaging, Verify, Lookup, Calls, Msg-Services, Content        | 10    | OTP + send + outbound voice + templated WhatsApp/RCS |

One-phase rollout. The "extensions" we considered (Phases 2–3 in earlier drafts) all
got dropped — see "Deferred" for the trail. Add a Phase 2 only when a real procedure
demands it.

## Implementation notes

- Each tool is a thin wrapper: parse args (zod), call the SDK, return
  `content: [{ type: "text", text: ... }]`. The existing `send-sms.ts` is the template.
- **Group files by product**, one folder per Twilio product area. One tool per file
  (kebab-case filename matches the snake_case tool name). Each folder has an
  `index.ts` that re-exports the folder's tools as a single `Tool[]`.

  ```
  mcp/bundled/twilio/
    server.ts                        # imports each group's array, concatenates, hands to createMcpHttpServer
    twilio-client.ts                 # shared SDK client
    tools/
      messaging/
        index.ts                     # export const messagingTools: Tool[] = [...]
        messages-create.ts
        messages-fetch.ts
        messaging-services-fetch.ts
        content-templates-fetch.ts
      voice/
        index.ts
        calls-create.ts
        calls-fetch.ts
      verify/
        index.ts
        verify-send.ts
        verify-check.ts
        verify-services-fetch.ts
      lookup/
        index.ts
        lookup-phone.ts
  ```

  Mapping: **Messaging Services** and **Content templates** fold into `messaging/`
  (both are sender-side concerns). **Verify** and **Lookup** stay their own groups
  (each a distinct SDK root and mental model).
- `server.ts` imports each group's `Tool[]` and concatenates:
  ```ts
  import { messagingTools } from "./tools/messaging/index.js";
  import { voiceTools }     from "./tools/voice/index.js";
  import { verifyTools }    from "./tools/verify/index.js";
  import { lookupTools }    from "./tools/lookup/index.js";

  await createMcpHttpServer({
    name: "twilio-mcp-server",
    tools: [...messagingTools, ...voiceTools, ...verifyTools, ...lookupTools],
  });
  ```
  No registration ceremony beyond the spread — adding a tool is one new file plus one
  line in the group's `index.ts`.
- Defaults via `.env`: `TWILIO_FROM_NUMBER`, `TWILIO_WHATSAPP_FROM`, `TWILIO_RCS_AGENT`,
  `TWILIO_VERIFY_SERVICE_SID`, `TWILIO_MESSAGING_SERVICE_SID`. A tool argument always
  overrides the env default. This keeps procedure prompts terse for the common case.
- Tool descriptions on write operations must say **"INCURS CHARGES"** (already the
  pattern in `send-sms.ts`). The dispatcher doesn't gate on this — it's a hint to the
  procedure-side LLM.
- Keep the existing three tools (`send_sms`, `lookup_phone_number`, `list_recent`) as
  aliases during migration, then delete them once procedures move over.

## What this is *not*

- Not a replacement for the official Twilio MCP. Customers who want full API access
  can run that one alongside this one — they'd appear as separate `ServerDescriptor`s
  in the manifest.
- Not extensible from the customer side without a code change. That's the deal:
  curated > comprehensive. Customers add their own MCPs under `mcp/local/` for
  workloads beyond this set.
- Not a Conversations / Flex / TaskRouter / Studio integration. Those have their own
  runtime shapes (long-lived state, event-driven, orchestration) that don't fit the
  request/response tool model cleanly. See "Deferred."
- Not a recordings or conference-control surface. Those are normally driven by TwiML
  webhooks, not by REST-from-a-procedure. See "Deferred."
- Not an inventory tool. No `_list` operations (rule 5) — procedures act on SIDs they
  produce or are given, not on whatever else lives in the account.

## Open questions

1. Should `messages_create` accept raw `to: "whatsapp:+15551234567"` as a fallback
   for power-users who don't want to set `channel`? Cleaner: no — pick a lane.
2. Verify supports `channel: "whatsapp"`. We need both a `TWILIO_VERIFY_SERVICE_SID`
   (Verify-side) and a separately-onboarded WhatsApp sender. Document the
   prerequisite in the tool description so the procedure surfaces a useful error.
3. `calls_create` takes either `twiml` or `url`. The procedure agent rarely hosts a
   webhook — assume `twiml` is the common case and lead with it in the description.
