# memory-event-demo — demo drop-in

Self-contained: everything for this demo lives in this one folder — the
MCP tool, its capability declaration, and the driver script + config that
exercises it. Reference material — the connector does not read from
`examples/` at runtime. This is now the reference example for the
Twilio-bundled-MCP-calls-out shape (`callControllerApi` via a Type 1
drop-in tool, reached through `/tool/call`) — `../outbound-demo/` used to
be its sibling but was rewired to demo the external machine-API route
(`POST /v1/outbound/calls`) directly instead; see
[`../outbound-demo/README.md`](../outbound-demo/README.md) for why.

Smoke test for the v1.4 controller-call tunnel mechanism
([docs/MCP-PROTOCOL.md](../../../docs/MCP-PROTOCOL.md) §"v1.4 — Controller
API calls (Twilio-bundled only)"). One tool, `invoke`, calls
`callControllerApi` to invoke the controller's `memory.append_event`
action and returns the result.

Unlike `outbound-demo`, this one has **no real-world side effect to
confirm** — it writes an episodic memory fact, no Twilio spend, no ringing
phone. The controller explicitly accepts a duplicate-on-retry as low-harm
(worst case: the fact is recalled twice), so the driver script fires
immediately with no `Proceed? [y/N]` gate.

## Contents

```
memory-event-demo/
├── README.md              this file
├── capabilities.ts         advisory controllerActions declaration
├── tools/invoke.ts          the MCP tool (Type 1 drop-in shape)
├── invoke.mjs               driver script — plays "the enterprise's own system"
├── run-memory-event.sh      thin shell wrapper around invoke.mjs
└── config.example.json      tracked template; copy to config.json and fill in real values
```

**Type 1 drop-in.** No `server.ts`, no `package.json`, no yaml entry.

## Installing this drop-in

`callControllerApi` is gated to `author === "twilio"` — the connector
rejects the call with `not_authorized` before the frame ever reaches the
tunnel if the calling MCP isn't Twilio-bundled. That's the opposite of
`sample`/`crm`/`salesforce`, whose dev activation path (symlink into
`customer-mcps/<name>`) deliberately simulates the *customer* drop-in flow
and gets tagged `author: "customer"`. This demo needs the Twilio-bundled
gate to pass, so **both** dev and prod activate it the same way `sample`/
`crm`/`salesforce` do in *prod*:

### Dev

```bash
cp -r examples/demos/memory-event-demo bundled-mcps/memory-event-demo
```

`bundled-mcps/memory-event-demo/` isn't gitignored the way `customer-mcps/*`
is — it's a real folder under the tracked `bundled-mcps/` root, so either
delete it when you're done or leave it (harmless — it just spawns one more
child process at boot). `invoke.mjs`/`run-memory-event.sh`/`config.*.json`
aren't part of the MCP itself (the connector only discovers `tools/`,
`prompts/`, `resources/`, `capabilities.ts`) — copying the whole folder is
harmless, they just come along for the ride unused by the connector.

### Prod

Add a line to `connector/Dockerfile` after the existing `bundled-mcps`
copy, mirroring `sample`/`crm`/`salesforce`'s own prod line:

```dockerfile
COPY examples/demos/memory-event-demo bundled-mcps/memory-event-demo
```

Not gated (bundle path) — ships live in the image immediately.

## Prerequisite: raise `tool_timeout_ms`

`memory.append_event` is a fast identity-resolve + episodic write — it uses
`callControllerApi`'s **default ~8s timeout**, no override needed (unlike
`outbound.*`, which needs a 30s override for its LLM-turn-gated actions).
But the same underlying conflict still applies: invoking the tool via the
inspector's `/tool/call` loopback route wraps every call in the
connector's own outer `policy.tool_timeout_ms` — **default 5000ms** — which
is still shorter than this action's 8s default. Before running the demo,
raise it in `connector.yaml`:

```yaml
policy:
  tool_timeout_ms: 10000
```

(10s is enough here — no need for the 35000 a tool-call-mediated
`outbound.*` caller would need. Don't assume the connector's 5s default is
safe just because this action's own timeout is shorter than
`outbound.*`'s; it's still longer than 5s.)

and restart the connector.

## Running the demo

Activate the drop-in (see above) and boot the connector with the raised
`tool_timeout_ms`, then pick whichever of these is less friction:

### Option A — config file

```bash
cd examples/demos/memory-event-demo
cp config.example.json config.json
# edit: channel (one of the values below), value (the identifier on that
# channel, e.g. a phone number for sms/voice/whatsapp), event
./run-memory-event.sh
```

### Option B — CLI flags, no config file needed

```bash
examples/demos/memory-event-demo/run-memory-event.sh \
  --channel=sms --value=+15555550123 --event="your flight is delayed"
```

Valid `channel` values (mirrors the controller's own `IDENTITY_CHANNEL_KINDS`
in `server/src/memory/append-event-controller-action.ts`): `voice`, `sms`,
`rcs`, `mms`, `whatsapp`, `webchat`, `email`, `chat`, `test-harness`.

Either way: the script prints a summary and immediately POSTs to the
connector inspector's `/tool/call` loopback route — no confirmation prompt
(see the note at the top of this README for why).

## Wire-format tool name

Through the controller, the tool appears as `memory-event-demo.invoke`.
The `memory-event-demo` segment comes from the folder name.
