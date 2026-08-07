# outbound-demo — demo drop-in

Self-contained: everything for this demo lives in this one folder — the
MCP tool, its capability declaration, and the driver script + config that
exercises it. Reference material — the connector does not read from
`examples/` at runtime.

Smoke test for the v1.4 controller-call tunnel mechanism
([docs/MCP-PROTOCOL.md](../../../docs/MCP-PROTOCOL.md) §"v1.4 — Controller
API calls (Twilio-bundled only)"). One tool, `invoke`, calls
`callControllerApi` to invoke the controller's `outbound.place_call` /
`outbound.send_message` action and returns the result.

**CAUTION:** running this places/sends a REAL call/message through
whatever agent/channel the controller resolves — not a simulation.

## Contents

```
outbound-demo/
├── README.md              this file
├── capabilities.ts         advisory controllerActions declaration
├── tools/invoke.ts          the MCP tool (Type 1 drop-in shape)
├── invoke.mjs               driver script — plays "the enterprise's own system"
├── run-outbound.sh          thin shell wrapper around invoke.mjs
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
cp -r examples/demos/outbound-demo bundled-mcps/outbound-demo
```

`bundled-mcps/outbound-demo/` isn't gitignored the way `customer-mcps/*`
is — it's a real folder under the tracked `bundled-mcps/` root, so either
delete it when you're done or leave it (harmless — it just spawns one more
child process at boot; it registers no schedule/network listener of its
own beyond the standard MCP HTTP endpoint). `invoke.mjs`/`config.*.json`
aren't part of the MCP itself (the connector only discovers `tools/`,
`prompts/`, `resources/`, `capabilities.ts`) — copying the whole folder is
harmless, they just come along for the ride unused by the connector.

### Prod

Add a line to `connector/Dockerfile` after the existing `bundled-mcps`
copy, mirroring `sample`/`crm`/`salesforce`'s own prod line:

```dockerfile
COPY examples/demos/outbound-demo bundled-mcps/outbound-demo
```

Not gated (bundle path) — ships live in the image immediately. Given this
demo triggers real Twilio calls/messages, think twice before adding this
line to a customer-facing image; it's meant for internal smoke-testing.

## Prerequisite: raise `tool_timeout_ms`

`outbound.place_call` / `outbound.send_message` run a synchronous LLM turn
on the controller side and need `callControllerApi`'s 30s timeout window.
But invoking the tool via the inspector's `/tool/call` loopback route (see
below) wraps every call in the connector's own outer `policy.tool_timeout_ms`
— **default 5000ms** — which aborts first regardless of what the inner
`callControllerApi` call is doing. Before running the demo, raise it in
`connector.yaml`:

```yaml
policy:
  tool_timeout_ms: 35000
```

and restart the connector. This is a deliberate manual step, not baked
into the repo's default — bumping the shared default to 35s would slow
down failure detection for every other tool call across every other MCP,
not just this one.

## Running the demo

Activate the drop-in (see above) and boot the connector with the raised
`tool_timeout_ms`, then pick whichever of these is less friction:

### Option A — config file

```bash
cd examples/demos/outbound-demo
cp config.example.json config.json
# edit: to (E.164), agentId, channelId — must be real records the
# controller already knows about (Agent + Channel bound to a supervisor
# procedure); an unknown pair fails with no_supervisor / agent_not_found.
./run-outbound.sh
```

### Option B — CLI flags, no config file needed

```bash
examples/demos/outbound-demo/run-outbound.sh \
  --to=+15555550123 --agentId=ag_123 --channelId=ch_456 --action=place_call
```

Either way: the script prints a summary, prompts `Proceed? [y/N]`, and on
confirmation POSTs to the connector inspector's `/tool/call` loopback
route. Declining exits cleanly with no request sent.

## Wire-format tool name

Through the controller, the tool appears as `outbound-demo.invoke`. The
`outbound-demo` segment comes from the folder name.
