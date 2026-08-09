// Smoke test for the machine-API outbound-calls route
// (docs/OUTBOUND-CALLS.md §7 / docs/MCP-PROTOCOL.md §"v1.4 — Controller
// API calls"). Drives the round trip: this script -> POST /oauth/token
// (mint a bearer) -> POST /v1/outbound/calls -> ControllerApiCoordinator
// -> tunnel -> controller's outbound.place_call / outbound.send_message
// action -> Twilio -> result back down. No MCP involved — this plays the
// role of a real external system calling the connector directly, which is
// what this route exists for.
//
// See README.md for full setup: add an API client via the inspector's
// Network Access panel (or POST /internal/network-access/clients) and
// put its client_id/client_secret in config.json or pass them as flags.
//
// CAUTION: on confirm, this places/sends a REAL call/message through
// whatever agent/channel the controller resolves for agentId/channelId —
// not a simulation.
//
// Usage — two equivalent ways to supply the values, pick whichever is less
// friction:
//
//   # 1. Config file
//   cp config.example.json config.json
//   # edit config.json with real clientId/clientSecret/agentId/channelId/to
//   node invoke.mjs
//
//   # 2. CLI flags (skips the config file entirely)
//   node invoke.mjs --clientId=... --clientSecret=... \
//     --to=+15555550123 --agentId=ag_123 --channelId=ch_456 [--action=place_call]
//
// Pass --port=<port> (or set INSPECTOR_PORT) if your connector isn't on
// the default 9090 — e.g. a second instance started with
// ./scripts/start-connector.sh 9091.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

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
// --port overrides INSPECTOR_PORT overrides the connector's own default
// (9090) — useful when running a second connector instance per CLAUDE.md's
// multi-instance dev workflow (./scripts/start-connector.sh 9091).
const inspectorPort = flags.port ?? process.env.INSPECTOR_PORT ?? "9090";
const usingFlags = Boolean(flags.to || flags.agentId || flags.channelId);

let config;
if (usingFlags) {
  config = {
    action: flags.action ?? "place_call",
    to: flags.to,
    agentId: flags.agentId,
    channelId: flags.channelId,
    callContext: flags.callContext ? JSON.parse(flags.callContext) : undefined,
    clientId: flags.clientId,
    clientSecret: flags.clientSecret,
  };
} else {
  const positional = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const configPath = resolve(process.cwd(), positional ?? resolve(here, "config.json"));
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (err) {
    console.error(`Failed to read config at ${configPath}: ${err.message}`);
    console.error("Either: cp config.example.json config.json and fill in real values,");
    console.error("or pass the values directly: node invoke.mjs --clientId=... --clientSecret=... --to=+1... --agentId=... --channelId=...");
    process.exit(1);
  }
}
// CLI flags for the credential always win, even in config-file mode — lets
// you keep a shared config.json (agentId/channelId/to) out of a client
// secret you'd rather not write to disk.
if (flags.clientId) config.clientId = flags.clientId;
if (flags.clientSecret) config.clientSecret = flags.clientSecret;

const { action, to, agentId, channelId, callContext, clientId, clientSecret } = config;
if (!["place_call", "send_message"].includes(action)) {
  console.error(`action must be "place_call" or "send_message", got: ${JSON.stringify(action)}`);
  process.exit(1);
}
if (typeof to !== "string" || typeof agentId !== "string" || typeof channelId !== "string") {
  console.error("to, agentId, and channelId must all be strings (via config.json or --to/--agentId/--channelId)");
  process.exit(1);
}
if (typeof clientId !== "string" || typeof clientSecret !== "string") {
  console.error("clientId and clientSecret must both be set (via config.json or --clientId/--clientSecret)");
  console.error("Mint a pair from the connector inspector's Network Access panel — see README.md.");
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

console.log("\nMinting a bearer token from /oauth/token ...");
let tokenRes;
try {
  tokenRes = await fetch(`http://127.0.0.1:${inspectorPort}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
} catch (err) {
  console.error(`Could not reach the connector inspector on port ${inspectorPort}: ${err.message}`);
  console.error("Is the connector running (./scripts/start-connector.sh)?");
  process.exit(1);
}
const tokenBody = await tokenRes.json();
if (!tokenRes.ok) {
  console.error(`Token mint failed: ${tokenBody.error} — ${tokenBody.error_description ?? ""}`);
  console.error("Check clientId/clientSecret — see README.md.");
  process.exit(1);
}
const { access_token: accessToken } = tokenBody;

console.log("Calling POST /v1/outbound/calls ...");
let res;
try {
  res = await fetch(`http://127.0.0.1:${inspectorPort}/v1/outbound/calls`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ action, to, agentId, channelId, ...(callContext ? { callContext } : {}) }),
  });
} catch (err) {
  console.error(`Could not reach the connector inspector on port ${inspectorPort}: ${err.message}`);
  process.exit(1);
}

const body = await res.json();
if (!res.ok) {
  console.error(`Controller action failed: ${body.error?.code} — ${body.error?.message}`);
  if (body.error?.code === "tunnel_unavailable") {
    console.error("No live tunnel — check the connector's Tunnel panel/inspector state.");
  }
  process.exit(1);
}

console.log("\nSuccess:");
console.log(JSON.stringify(body.result, null, 2));
