// Smoke test for the v1.4 controller-call tunnel mechanism
// (docs/MCP-PROTOCOL.md §"v1.4 — Controller API calls (Twilio-bundled
// only)"). Drives the round trip: this script -> connector inspector's
// loopback /tool/call -> outbound-demo's invoke tool -> callControllerApi
// -> tunnel -> controller's outbound.place_call / outbound.send_message
// action -> Twilio -> result back down.
//
// See README.md for full setup: the drop-in must be activated into
// bundled-mcps/outbound-demo/ (author gate — see the README for why it
// can't go in customer-mcps/ like sample/crm), and connector.yaml's
// policy.tool_timeout_ms must be raised to 35000+ before starting the
// connector.
//
// CAUTION: on confirm, this places/sends a REAL call/message through
// whatever agent/channel the controller resolves for agentId/channelId —
// not a simulation.
//
// Usage — two equivalent ways to supply the IDs, pick whichever is less
// friction:
//
//   # 1. Config file
//   cp config.example.json config.json
//   # edit config.json with real agentId/channelId/to
//   node invoke.mjs
//
//   # 2. CLI flags (skips the config file entirely)
//   node invoke.mjs --to=+15555550123 --agentId=ag_123 --channelId=ch_456 [--action=place_call]

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const here = dirname(fileURLToPath(import.meta.url));
const inspectorPort = process.env.INSPECTOR_PORT ?? "9090";

function parseFlags(argv) {
  const flags = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) flags[m[1]] = m[2];
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
const usingFlags = Boolean(flags.to || flags.agentId || flags.channelId);

let config;
if (usingFlags) {
  config = {
    action: flags.action ?? "place_call",
    to: flags.to,
    agentId: flags.agentId,
    channelId: flags.channelId,
    callContext: flags.callContext ? JSON.parse(flags.callContext) : undefined,
  };
} else {
  const positional = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const configPath = resolve(process.cwd(), positional ?? resolve(here, "config.json"));
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (err) {
    console.error(`Failed to read config at ${configPath}: ${err.message}`);
    console.error("Either: cp config.example.json config.json and fill in real values,");
    console.error("or pass the IDs directly: node invoke.mjs --to=+1... --agentId=... --channelId=...");
    process.exit(1);
  }
}

const { action, to, agentId, channelId, callContext } = config;
if (!["place_call", "send_message"].includes(action)) {
  console.error(`action must be "place_call" or "send_message", got: ${JSON.stringify(action)}`);
  process.exit(1);
}
if (typeof to !== "string" || typeof agentId !== "string" || typeof channelId !== "string") {
  console.error("to, agentId, and channelId must all be strings (via config.json or --to/--agentId/--channelId)");
  process.exit(1);
}

console.log(`About to ${action}:`);
console.log(`  to:        ${to}`);
console.log(`  agentId:   ${agentId}`);
console.log(`  channelId: ${channelId}`);
if (callContext) console.log(`  callContext: ${JSON.stringify(callContext)}`);
console.log(`This will trigger a REAL ${action === "place_call" ? "phone call" : "SMS"} via Twilio — not a simulation.`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question("Proceed? [y/N] ");
rl.close();
if (!/^y(es)?$/i.test(answer.trim())) {
  console.log("Aborted — no request sent.");
  process.exit(0);
}

console.log("\nCalling connector inspector's /tool/call ...");
let res;
try {
  res = await fetch(`http://127.0.0.1:${inspectorPort}/tool/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-inspector-request": "1" },
    body: JSON.stringify({
      server: "outbound-demo",
      tool: "invoke",
      args: { action, to, agentId, channelId, ...(callContext ? { callContext } : {}) },
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
