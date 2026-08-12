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
API calls (Twilio-bundled only)"). Two tools — `list` and `invoke` — each
calling `callControllerApi` to invoke the matching controller action and return
its result.

**Injection is a resolve-then-write flow**, which is why there are two tools
and not one:

```
list    identity.list          address (substring) -> matching identities (may be >1)
invoke  memory.inject_context  identityId + agentId + the fact -> written
```

A third tool, `find`, wrapped `identity.find` until the controller merged that
action into `identity.list` — `identifier` is a substring, and an exact address is
a substring of itself.

`invoke` does **not** accept an address. It used to: the controller resolved
one internally, but that resolve was find-or-**create**, so a typo'd digit
minted a phantom customer with a real working-memory row hanging off it, let
an external caller grow the identity table at will, and failed *silently* —
the mistyped write "succeeded" and nobody found out until the agent said
nothing on the call. Resolution is now lookup-only.

Unlike `outbound-demo`, this one has **no real-world side effect to
confirm** — it writes a note into an agent's working memory, no Twilio
spend, no ringing phone. The controller explicitly accepts a
duplicate-on-retry as low-harm (worst case: the note appears twice), so the
driver script fires immediately with no `Proceed? [y/N]` gate.

## Contents

```
memory-event-demo/
├── README.md              this file
├── capabilities.ts         advisory controllerActions declaration (2 actions)
├── tools/list.ts            browse the account's identities, or resolve one
├── tools/invoke.ts          write the fact against an identityId
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

`memory.inject_context` is a fast identity-resolve plus row write — it uses
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

(10s is enough for `invoke` — no need for the 35000 a
tool-call-mediated `outbound.*` caller would need. Don't assume the
connector's 5s default is safe just because these actions' own timeout is
shorter than `outbound.*`'s; it's still longer than 5s.)

and restart the connector.

**`list` needs more.** `identity.list` has no server-side cap: omitting
`limit` returns the account's *entire* identity set, so `tools/list.ts`
raises `callControllerApi`'s own window to 30s. That means the outer
`tool_timeout_ms` has to clear 30s too, or the connector kills the call
first:

```yaml
policy:
  tool_timeout_ms: 35000
```

Only needed if you actually run `--list` against a large account. A timeout
here returns **nothing**, not a partial list — the controller rejected
capping at 100 because a silent truncation is indistinguishable from
"that's all of them", whereas an unbounded call can be slow but cannot
lie.

## Running the demo

Activate the drop-in (see above) and boot the connector with the raised
`tool_timeout_ms`, then pick whichever of these is less friction:

### One mode = one tool call

Each run makes exactly **one** `/tool/call` round trip. Every flag is a param of
that tool, spelled as the tool spells it:

| Mode | Tool | Required | Optional |
|---|---|---|---|
| `--list` | `list` | — | `--identifier` `--channel` `--limit` |
| `--inject` | `invoke` | `--agentId` `--identityId` `--event` | `--occurredAt` `--ttlSeconds` `--idempotencyKey` |

Only the mode flags and `--port` belong to the script. **Reading the driver should
tell you the tool schemas** — so don't add a flag that renames, combines, or
derives a param, and don't let one mode issue two calls. An earlier version
resolved *and* wrote in a single run, which made `invoke` look as though it
accepted an address when it only ever accepted an `identityId`.

```bash
cd examples/demos/memory-event-demo
cp config.example.json config.json   # agentId, so you needn't retype it

# 1. who does the account know?
./run-memory-event.sh --list
./run-memory-event.sh --list --identifier=smith --channel=email

# 2. resolve one address -> identityId (same tool, with --identifier)
./run-memory-event.sh --list --identifier=+15555550123

# 3. write the fact against that identityId
./run-memory-event.sh --inject --agentId=agt_123 \
  --identityId=identity_9f2c1a04-7b3e-4d51-8a6f-2e0b9c4d7a13 \
  --event="your flight is delayed"
```

`--list` prints the `identityId` to paste into `--inject`.

**`--identifier` is a SUBSTRING, so a full address can match several rows** —
`des@example.com` also matches `des@example.com.au`. The script marks which rows
carry your exact address in their `aliases` rather than picking one; don't take
`identities[0]`.

The script prints a summary and immediately POSTs to the connector inspector's
`/tool/call` loopback route — no confirmation prompt (see the note at the top of
this README for why).

## The fields

**`identifier`** (optional, on `list`) is a case-insensitive **substring** on
alias values. Omit it to browse the whole account; supply a full address to
resolve one customer. Because it's a substring, a full address can match more
than one identity — `des@example.com` also matches `des@example.com.au` — so
compare each result's `aliases` (always the full set per identity, never narrowed
by your query) rather than taking `identities[0]`.

**`channel`** (optional, on `list`) only narrows the result set. It was
*required* on the deleted `find` tool, whose equality lookup ran against a
kind-normalised column; substring matching needs no kind. Valid values are
`phone`, `email`, `webchat-uid` — note that `sms`, `voice`, `whatsapp`, `rcs` and
`mms` all resolve as `phone`, and `test-harness` is refused on input (it's a
controller-internal construct that can only *appear* in a returned `aliases`
array, which means an identity whose only alias is `test-harness` can be browsed
but not filtered for).

Being able to state the kind is what makes opaque **webchat UIDs reachable**. The
retired address-sniffing shape could only handle self-describing values, so it
had to reject everything that wasn't a phone number or an email.

**`agentId`** is required on `invoke` and must be an agent in the same
account as the tunnel session — working memory is keyed
`(accountId, agentId, identityKey)`, so there's no way to write it without
naming an agent. Note the asymmetry: **`invoke` needs an `agentId`; `list` does
not.** Identity is per-account, not per-agent — a customer can
be well known to the account while never having used the agent you're
injecting against. That case works.

Both `agentId` and `identityId` are checked against the account, so a
handle from the wrong one comes back as `cross_account` — not
`invalid_params`.

**`ttlSeconds`** (optional, on `invoke`) is **genuine multi-turn shelf life** — a
live injected note survives successive turns until it expires. The trade is the
opposite risk: it goes back on the wire every turn, so the agent may raise the
fact more than once inside the window. Keep it tight when that matters. (A
consume-once design was tried and failed in the field — a customer's opening
greeting spent the note before the turn that needed it.)
Default 600s, which equals the controller's `quietFlushMs`, so omitting it
behaves exactly as it did before the field existed. The range policy is
asymmetric: above 86400s is *clamped* (read `expiresAt` for the truth), while 0,
negative and fractional values are *rejected* with `invalid_params`. Raise it when
you want inject-then-wait-for-**inbound** rather than inject-then-outbound; that
case was impossible before, because a row holding only injected notes looked
*empty* to the flush sweeper and was destroyed before the customer ever made
contact. That branch is unit-covered, not field-proven — see
[docs/MEMORY-EVENTS.md](../../../docs/MEMORY-EVENTS.md) §12 step 7.

Also worth knowing: **`stored: true` means written, not mentioned.** A fact the
agent never voices leaves no trace at all — the note expires either way, no episode
written — so the controller's audit line is the only record.

## When `list` comes back empty

Not an error, and not a bug to file. It means the controller has never
interacted with that customer, so there's no conversation history to prepend
a note to. The driver exits **3** for this case, distinct from a real
failure's 1. This carries exactly the meaning the deleted `find` tool's
`identity: null` did.

The correct move for a never-contacted customer is to place the outbound
call with the fact in its own `callContext`, where it rides the call into
hydration — see [`../outbound-demo/`](../outbound-demo/README.md). Memory
injection prepares an *existing* conversational surface; it isn't how you
brief an agent about a stranger.

## Wire-format tool names

Through the controller, the tools appear as `memory-event-demo.list` and
`memory-event-demo.invoke`. The
`memory-event-demo` segment comes from the folder name.
