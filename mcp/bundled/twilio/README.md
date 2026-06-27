# Twilio MCP server (Type 1 bundled example)

Type 1 MCP that wraps the Twilio messaging / voice / verify / lookups APIs,
SendGrid email, and the Segment Profile + Tracking APIs. The connector spawns
this as a child process via `tsx server.ts` — no build step, no fixed port.
Used to demonstrate that the connector treats Twilio-shipped tools the same
as any customer-side MCP, and to ship a worked example of the service-first
layout (`<service>/{tools,prompts,resources}/`) for multi-service bundles.

The `twilio` and `@sendgrid/client` SDKs live in this folder's `node_modules`
so they don't bloat the connector image's workspace install.

## Folder layout

```
mcp/bundled/twilio/
├── server.ts                       # explicit imports + creds gating
├── twilio-client.ts                # injectable Twilio client factory
├── sendgrid-client.ts              # injectable SendGrid client factory
├── segment-profile-client.ts       # Profile API (read)
├── segment-tracker.ts              # Tracking API (write)
├── status-callback.ts              # webhook ingress wired into voice flows
├── messaging/
│   ├── tools/                      # messages_create, messages_fetch, ...
│   ├── prompts/                    # messaging_overview
│   └── resources/
├── voice/
│   ├── tools/                      # calls_create, voice_pay, agent_pay_*, ...
│   ├── prompts/                    # voice_overview + 7 agent-pay prompts
│   └── resources/
├── verify/
│   ├── tools/
│   ├── prompts/                    # verify_overview
│   └── resources/
├── lookups/
│   ├── tools/
│   ├── prompts/                    # lookups_overview
│   └── resources/
├── email/
│   ├── tools/
│   ├── prompts/                    # email_overview
│   └── resources/
└── segment/
    ├── tools/
    ├── prompts/                    # segment_overview
    └── resources/
```

Service-first grouping keeps each domain's tools, prompts, and any future
resources together — easier to reason about than a flat `tools/<service>/`
tree once a service grows past three or four tools. The pattern is
bundle-scoped: customer drop-ins under `mcp/local/<name>/` stay flat.

## Tools

Tool names have no `twilio_` / `sendgrid_` prefix. The cloud-side qualifier
is `${author}.${serverName}.${toolName}` — for this MCP that resolves to
`twilio.apis.<tool>`, which flattens to e.g. `twilio_apis_messages_create`
on OpenAI's tool surface. Adding a `twilio_` tool prefix on top of that
would stutter.

### Messaging (`messaging/tools/`)

| Tool | Description | Cost |
|---|---|---|
| `messages_create({channel, to, from?, messagingServiceSid?, body?, contentSid?, ...})` | Send via SMS / WhatsApp / RCS — caller supplies either `from` or `messagingServiceSid` | **incurs charges** |
| `messages_fetch({sid})` | Look up a message by SID | free |
| `messaging_services_fetch({sid})` | Inspect a Messaging Service's sender pool + feature flags | free |
| `content_templates_fetch({sid})` | Inspect a Content template (HXxxxx); use the SID with `messages_create.contentSid` | free |

### Voice (`voice/tools/`)

| Tool | Description | Cost |
|---|---|---|
| `calls_create({to, from, twiml?, url?})` | Place an outbound voice call (inline TwiML or webhook URL) | **incurs charges** |
| `calls_fetch({sid})` | Look up a call by SID | free |
| `voice_say({...})` | Compose a `<Say>` TwiML fragment | free |
| `voice_play({...})` | Compose a `<Play>` TwiML fragment (audio URL or DTMF tones) | free |
| `voice_dial({...})` | Compose a `<Dial>` TwiML fragment | free |
| `voice_pay({...})` | Compose a `<Pay>` TwiML fragment for one-shot IVR card capture | **incurs charges on use** |
| `voice_transcription_start({...})` | Begin real-time transcription on a live call | **incurs charges** |
| `voice_transcription_stop({...})` | End real-time transcription | free |
| `agent_pay_start({callSid, ...})` | Start a live-call `<Payments>` capture (LLM-driven) | **incurs charges** |
| `agent_pay_capture_card({callSid, paymentSid})` | Advance the capture to PAN entry | free |
| `agent_pay_capture_exp({callSid, paymentSid})` | Advance to expiration entry | free |
| `agent_pay_capture_cvc({callSid, paymentSid})` | Advance to CVC entry | free |
| `agent_pay_complete({callSid, paymentSid})` | Finalize (tokenize or charge) | **incurs charges on charge** |

The two payment paths — `voice_pay` (TwiML one-shot) and `agent_pay_*`
(live-call LLM-driven) — coexist by design. See "Agent-assisted payments"
below for the live-call walkthrough.

### Verify (`verify/tools/`)

| Tool | Description | Cost |
|---|---|---|
| `verify_send({to, channel, serviceSid})` | Send an OTP via Verify | **incurs charges** |
| `verify_check({to, code, serviceSid})` | Validate the OTP the user typed back | free |
| `verify_services_fetch({sid})` | Inspect a Verify Service's code length + channel settings | free |

### Lookups (`lookups/tools/`)

| Tool | Description | Cost |
|---|---|---|
| `lookups_fetch({phone_number})` | Twilio Lookup v2 — validate a number, return E.164 + country + line type | free |

### Email — SendGrid (`email/tools/`)

| Tool | Description | Cost |
|---|---|---|
| `email_send({to, from, subject?, text?, html?, templateId?, ...})` | Send an email (ad-hoc or templated) | **incurs charges** |
| `email_fetch({msgId})` | Fetch SendGrid delivery + event timeline (Pro+ plan required) | free |
| `email_search({query?, ...})` | Search recent SendGrid messages (Pro+) | free |
| `email_templates_fetch({templateId?, ...})` | Inspect SendGrid dynamic templates | free |

### Segment (`segment/tools/`)

| Tool | Description | Cost |
|---|---|---|
| `segment_profile_traits({id_type, value, ...})` | Read latest traits for a unified profile | free |
| `segment_profile_events({id_type, value, ...})` | Read recent events on a unified profile | free |
| `segment_profile_external_ids({id_type, value})` | List external ids linked to a profile | free |
| `segment_identify({userId\|anonymousId, traits?})` | Upsert traits | free |
| `segment_track({userId\|anonymousId, event, properties?})` | Record an event | free |

## Prompts

Each service ships an `<service>_overview` prompt that takes zero arguments
and returns a short, opinionated guide to "when to use which tool in this
service". An LLM that just connected to this MCP can fetch
`prompts/get messaging_overview` (etc.) and become productive without
reading every tool description.

Voice additionally ships seven prompts for the agent-assisted payment flow.

| Prompt | When to fetch | Args |
|---|---|---|
| `messaging_overview` | LLM is about to send / look up a message and wants the tool-selection summary | — |
| `voice_overview` | LLM is composing TwiML or choosing between the two payment paths | — |
| `verify_overview` | Before starting an OTP send / check flow | — |
| `lookups_overview` | Before validating a phone number | — |
| `email_overview` | Before sending or searching SendGrid mail | — |
| `segment_overview` | Before reading or writing Segment profile data | — |
| `agent_pay_start_capture` | Opening instructions for an agent-assisted payment capture | `{callSid}` |
| `agent_pay_card_number` | After `agent_pay_capture_card` returns | `{callSid, paymentSid}` |
| `agent_pay_expiration` | After `agent_pay_capture_exp` returns | `{callSid, paymentSid}` |
| `agent_pay_security_code` | After `agent_pay_capture_cvc` returns | `{callSid, paymentSid}` |
| `agent_pay_finish` | Before `agent_pay_complete` (read back masked state, confirm) | `{callSid, paymentSid}` |
| `agent_pay_completion` | After `agent_pay_complete` succeeds | `{callSid, paymentSid, paymentToken?}` |
| `agent_pay_error` | On any `errorType` from a payment status callback | `{callSid, paymentSid, errorType}` |

Overview prompts register inside the same creds gates as their tools — if
Twilio creds are absent, the messaging / voice / verify / lookups overviews
do not appear in `prompts/list`. The segment overview surfaces if EITHER
read OR write creds are present; the prompt explains which flows are
available given the partial creds.

## Agent-assisted payments — walkthrough

`agent_pay_*` uses Twilio's live-call `<Payments>` API (POST to
`/2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}/Payments.json`). Unlike
the TwiML `<Pay>` verb (which `voice_pay` emits and which Twilio runs
end-to-end as an IVR), `<Payments>` lets the LLM drive each capture step
and react to status callbacks in between.

**Flow (LLM driving a live call):**

1. Fetch the `agent_pay_start_capture` prompt with the live call's
   `CallSid`. Tell the caller what to expect.
2. Call `agent_pay_start({callSid, chargeAmount?, paymentConnector?, ...})`.
   The tool returns a `paymentSid`. Hold onto both `callSid` and
   `paymentSid` — every subsequent step needs them.
3. Call `agent_pay_capture_card({callSid, paymentSid})`. Fetch the
   `agent_pay_card_number` prompt to guide your conversation while the
   caller enters digits.
4. Repeat for `agent_pay_capture_exp` (use `agent_pay_expiration` prompt)
   and `agent_pay_capture_cvc` (use `agent_pay_security_code` prompt).
5. Fetch `agent_pay_finish` to read back the masked state and confirm.
6. Call `agent_pay_complete({callSid, paymentSid})`. The tool returns the
   payment token / final status. Use the `agent_pay_completion` prompt to
   close the flow politely.
7. On any `errorType` arriving via the existing status-callback path
   (`status-callback.ts`), fetch `agent_pay_error` for retry / escalation
   guidance.

**Prerequisite.** The Twilio account needs a configured **Pay Connector**
(Stripe, Braintree, etc.). Without one, `agent_pay_start` returns an error
from the Twilio API. The same prerequisite applies to `voice_pay`.

**Reference.** The agent-pay design is ported from
<https://github.com/deshartman/twilio-agent-payments-mcp-server> — same
flow, refolded into the bundled-MCP shape so it ships pre-installed
alongside the rest of the Twilio surface.

## Creds gating

Each service group registers independently — customers running only some
services see only those groups' tools and prompts:

| Group | Required env | Tools | Prompts |
|---|---|---|---|
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | messaging / voice / verify / lookups (21 tools, including 5 agent-pay) | `messaging_overview`, `voice_overview`, `verify_overview`, `lookups_overview` + 7 agent-pay prompts |
| SendGrid | `SENDGRID_API_KEY` | email (4 tools) | `email_overview` |
| Segment — read | `SEGMENT_SPACE_ID`, `SEGMENT_PROFILE_PAT` | profile traits / events / external_ids (3 tools) | `segment_overview` (shared with write) |
| Segment — write | `SEGMENT_WRITE_KEY` | identify / track (2 tools) | `segment_overview` (shared with read) |

Within a group, missing keys are all-or-nothing — supplying
`TWILIO_ACCOUNT_SID` without `TWILIO_AUTH_TOKEN` registers zero Twilio
tools and zero Twilio prompts. The Twilio and Segment-read groups each
need both env vars set.

`SEGMENT_PROFILE_HOST` is an optional override (default
`https://profiles.segment.com`); set it to
`https://profiles.euw1.segment.com` for EU-resident Segment workspaces.

## Setup

```bash
# From the repo root.
npm install                              # workspace install (installs tsx for the connector spawner)
(cd mcp/bundled/twilio && npm install)   # twilio + @sendgrid/client SDKs live here, not in the workspace

cp mcp/bundled/twilio/.env.example mcp/bundled/twilio/.env
# Fill in TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN.
# Plus SENDGRID_API_KEY if you'll use the email_* tools.
# Plus SEGMENT_SPACE_ID + SEGMENT_PROFILE_PAT (read) and/or SEGMENT_WRITE_KEY (write).
# Operational values (from numbers, service SIDs, sender emails) are
# caller-supplied per tool call — they don't come from .env.
```

The entry already exists in `packages/connector/connector.yaml.example`:

```yaml
- name: apis
  transport: http
  dir: ../../mcp/bundled/twilio
```

`./scripts/start-connector.sh` from the repo root will boot the connector,
which in turn spawns this server at an auto-assigned port and dials the
tunnel. The first boot registers itself with the controller using the
`tunnel.name` in `packages/connector/connector.yaml`. The inspector at
<http://localhost:9090/> shows the `apis.*` tools and prompts (server
name = `apis`, folder = `mcp/bundled/twilio`).

## Notes

- Real Twilio infrastructure would call these APIs in-process, not through
  an external MCP server. This bundle exists to show the connector path
  and to ship a worked example of the service-first layout, not to
  recommend an architecture.
- The bundle is AuthToken-only. API Key / Secret was previously supported
  but removed to keep auth aligned with the controller's Twilio-bundled
  auto-fill (see [`docs/MCP-PROTOCOL.md`](../../../docs/MCP-PROTOCOL.md)
  "Twilio-bundled auto-fill"). For revocable per-service credentials, mint
  a scoped subaccount and use its AuthToken.
- The connector loads `mcp/bundled/twilio/.env` into *this child's*
  process only — credentials do not reach other MCP children.
