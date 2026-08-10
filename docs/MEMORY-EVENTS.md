# MEMORY-EVENTS — enterprise-injects-a-memory-fact walkthrough

> **Status:** demo — `examples/demos/memory-event-demo/` is reference material (not auto-loaded); the mechanism it exercises (v1.4 controller-call) is shipped.
> **Repo location:** `examples/demos/memory-event-demo/` — self-contained: MCP tool, capability declaration, driver script, and config all in one folder.

This document walks through the flow that lets an enterprise's own system inject a fact into a customer's memory through the tunnel, from the connector side. It's the sibling of [`docs/OUTBOUND-CALLS.md`](OUTBOUND-CALLS.md) — same mechanism, different controller action (`memory.append_event` instead of `outbound.place_call`/`outbound.send_message`), and a materially lower-stakes one: no Twilio spend, no real-world side effect to confirm before firing.

## 1. The flow, end to end

```
enterprise's own system
  -> examples/demos/memory-event-demo/run-memory-event.sh   (plays the role of "the enterprise's own system")
  -> POST /tool/call on the connector's inspector             ({server, tool, args})
  -> memory-event-demo's invoke tool
  -> callControllerApi("memory.append_event", { identity, event, occurredAt?, idempotencyKey? })
  -> POST /internal/controller-api/call on the connector's inspector
  -> ControllerApiCoordinator.call() -> controller-call frame over the tunnel WS
  -> controller's ControllerActionRegistry.invoke()
  -> registerMemoryAppendEventAction -> identity resolve -> episodic memory write
  -> result flows back down the same path as controller-call-response -> tool result -> HTTP response
```

Every hop after the driver script is generic mechanism shared with the outbound demo — see `docs/MCP-PROTOCOL.md` §"v1.4 — Controller API calls (Twilio-bundled only)" for the wire contract (`ControllerCallFrame` / `ControllerCallResponseFrame`) that everything below rides on.

## 2. Params and result

Unlike `outbound.*`, this action takes no `agentId`/`channelId` — memory is customer-scoped and deliberately cross-channel/cross-agent (a fact learned on one channel is recallable on any other). The bundle only ever collects "who is the customer" (`identity`) and "what happened" (`event`):

```ts
{
  identity: { channel: string, value: string },  // see valid channel values below
  event: string,            // the fact, stored verbatim, e.g. "your flight is delayed"
  occurredAt?: string,      // ISO 8601; defaults to now
  idempotencyKey?: string,  // optional — see Idempotency below
}

// result
{ identityId: string, stored: true }
```

Valid `identity.channel` values (mirrors the controller's own `IDENTITY_CHANNEL_KINDS` in `server/src/memory/append-event-controller-action.ts`): `voice`, `sms`, `rcs`, `mms`, `whatsapp`, `webchat`, `email`, `chat`, `test-harness`. An unrecognized value fails with `invalid_params`.

## 3. Why no confirmation gate, unlike the outbound demo

`docs/OUTBOUND-CALLS.md`'s driver script prompts `Proceed? [y/N]` because it triggers real Twilio spend and a real ringing phone. This action has neither — it's a memory write with no external side effect. The controller has also explicitly decided `idempotencyKey` is optional and **not deduped in v1**: a retry-after-timeout can create a duplicate memory entry, accepted as low-harm (worst case, the fact is recalled twice) rather than the double-dial risk `outbound.place_call` carries without one. So this demo's tool doesn't mint a key on the caller's behalf — pass one only if you specifically want dedup-adjacent behavior on your own retries. (`outbound.place_call`'s own caller-facing surface, `/v1/outbound/calls`, mints one for you if you omit it — see `docs/OUTBOUND-CALLS.md` §3 — since dialing twice is a real side effect worth defaulting to safe.)

## 4. Running it

Full setup (activation, `tool_timeout_ms` prerequisite, config format) lives in [`examples/demos/memory-event-demo/README.md`](../examples/demos/memory-event-demo/README.md) — the short version:

```bash
# 1. Activate the drop-in (author-gated to "twilio" — see the README for why
#    this can't go through the usual customer-mcps/ dev path).
cp -r examples/demos/memory-event-demo bundled-mcps/memory-event-demo

# 2. Raise connector.yaml's policy.tool_timeout_ms to 10000+ (see §5) and
#    boot the connector.
./scripts/start-connector.sh

# 3. Configure and run the driver — config file (below) or CLI flags,
#    see examples/demos/memory-event-demo/README.md for both.
cd examples/demos/memory-event-demo
cp config.example.json config.json
# edit: channel, value, event
./run-memory-event.sh
```

The script prints a summary and fires immediately — no prompt (see §3).

## 5. The `tool_timeout_ms` gotcha, smaller version

`memory.append_event` uses `callControllerApi`'s default ~8s timeout — no override needed, unlike `outbound.*`'s 30s. But the demo script still reaches the tool through the connector's inspector `/tool/call` route, which wraps every MCP tool call in the connector's own outer `policy.tool_timeout_ms` — **5000ms by default** (`connector/src/config.ts`). 8s is still longer than 5s, so the same class of conflict applies, just with a smaller fix:

```yaml
policy:
  tool_timeout_ms: 10000
```

10 seconds is enough here — no need for the 35000 a tool-call-mediated `outbound.*` caller would need (see `docs/OUTBOUND-CALLS.md` §7). Don't assume the connector's 5s default is automatically safe just because this action's own timeout is shorter than `outbound.*`'s; it's still longer than 5s.

## 6. Error codes

This action's contract states its own subset of the baseline table in `docs/MCP-PROTOCOL.md` — notably **not** `cross_account` or `no_supervisor` (those are `outbound.*`-specific account-scope / channel-availability checks that don't apply to a customer-scoped memory write):

| Code | Where it comes from |
|---|---|
| `timeout` | Connector-side only — the controller didn't reply in time. |
| `unknown_action` | Controller has no handler for the requested action. |
| `not_authorized` | Either the connector's local gate (calling MCP isn't Twilio-authored) or the controller's own session check. |
| `invalid_params` | Controller: `params` failed the action's own schema validation — most commonly an unrecognized `identity.channel`. |
| `controller_error` | Controller: everything else. |
