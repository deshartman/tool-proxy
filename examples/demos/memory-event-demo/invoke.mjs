// Smoke test for the v1.4 controller-call tunnel mechanism
// (docs/MCP-PROTOCOL.md §"v1.4 — Controller API calls (Twilio-bundled
// only)"), targeting memory.append_event. Drives the round trip: this
// script -> connector inspector's loopback /tool/call -> memory-event-demo's
// invoke tool -> callControllerApi -> tunnel -> controller's
// memory.append_event action -> episodic memory write -> result back down.
//
// See README.md for full setup: the drop-in must be activated into
// bundled-mcps/memory-event-demo/ (author gate — see the README for why it
// can't go in customer-mcps/ like sample/crm), and connector.yaml's
// policy.tool_timeout_ms must be raised to 10000+ before starting the
// connector.
//
// Unlike outbound-demo's driver, this one does NOT prompt for confirmation
// — writing a memory fact has no Twilio spend, and the controller
// explicitly accepts a duplicate-on-retry as low-harm (see README.md).
//
// Usage — two equivalent ways to supply the fields, pick whichever is less
// friction:
//
//   # 1. Config file
//   cp config.example.json config.json
//   # edit config.json with real channel/value/event
//   node invoke.mjs
//
//   # 2. CLI flags (skips the config file entirely)
//   node invoke.mjs --channel=sms --value=+15555550123 --event="your flight is delayed"
//
// Pass --port=<port> (or set INSPECTOR_PORT) if your connector isn't on
// the default 9090 — e.g. a second instance started with
// ./scripts/start-connector.sh 9091.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function parseFlags(argv) {
  const flags = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) flags[m[1]] = m[2];
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
const inspectorPort = flags.port ?? process.env.INSPECTOR_PORT ?? "9090";
const usingFlags = Boolean(flags.channel || flags.value || flags.event);

let config;
if (usingFlags) {
  config = {
    channel: flags.channel,
    value: flags.value,
    event: flags.event,
    occurredAt: flags.occurredAt,
    idempotencyKey: flags.idempotencyKey,
  };
} else {
  const positional = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const configPath = resolve(process.cwd(), positional ?? resolve(here, "config.json"));
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (err) {
    console.error(`Failed to read config at ${configPath}: ${err.message}`);
    console.error("Either: cp config.example.json config.json and fill in real values,");
    console.error("or pass the fields directly: node invoke.mjs --channel=sms --value=+1... --event=\"...\"");
    process.exit(1);
  }
}

const { channel, value, event, occurredAt, idempotencyKey } = config;
if (typeof channel !== "string" || typeof value !== "string" || typeof event !== "string") {
  console.error("channel, value, and event must all be strings (via config.json or --channel/--value/--event)");
  process.exit(1);
}

console.log("About to append_event:");
console.log(`  identity.channel: ${channel}`);
console.log(`  identity.value:   ${value}`);
console.log(`  event:            ${event}`);
if (occurredAt) console.log(`  occurredAt:       ${occurredAt}`);

console.log("\nCalling connector inspector's /tool/call ...");
let res;
try {
  res = await fetch(`http://127.0.0.1:${inspectorPort}/tool/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-inspector-request": "1" },
    body: JSON.stringify({
      server: "memory-event-demo",
      tool: "invoke",
      args: {
        identity: { channel, value },
        event,
        ...(occurredAt ? { occurredAt } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    }),
  });
} catch (err) {
  console.error(`Could not reach the connector inspector on port ${inspectorPort}: ${err.message}`);
  console.error("Is the connector running (./scripts/start-connector.sh)?");
  process.exit(1);
}

const body = await res.json();
if (!body.ok) {
  console.error(`Dispatch failed: ${body.error}`);
  console.error("If this looks like a timeout, check connector.yaml's policy.tool_timeout_ms — see README.md.");
  process.exit(1);
}

const result = body.result;
if (result?.isError) {
  const parsed = JSON.parse(result.content?.[0]?.text ?? "{}");
  console.error(`Controller action failed: ${parsed.error?.code} — ${parsed.error?.message}`);
  process.exit(1);
}

console.log("\nSuccess:");
console.log(JSON.stringify(result?.structuredContent ?? result, null, 2));
