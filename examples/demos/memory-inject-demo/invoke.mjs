// Smoke test for the machine-API memory-events route
// (docs/MEMORY-EVENTS.md / docs/MCP-PROTOCOL.md §"v1.4 — Controller API
// calls"). Drives the round trip: this script -> POST /oauth/token (mint a
// bearer) -> POST /v1/memory/events -> ControllerApiCoordinator -> tunnel ->
// controller's memory.append_event action -> identity resolve + episodic
// write -> result back down. No MCP involved — this plays the role of a real
// external system calling the connector directly, which is what this route
// exists for.
//
// See README.md for full setup: add an API client via the inspector's
// Network Access panel (or POST /internal/network-access/clients) and put its
// client_id/client_secret in config.json or pass them as flags.
//
// No confirmation prompt, unlike outbound-demo: a memory write has no Twilio
// spend and no real-world side effect, and the controller accepts a
// duplicate-on-retry as low-harm (it does not dedup in v1). It does write a
// real fact into a real customer's memory, so point it at a test identity.
//
// Usage — two equivalent ways to supply the values, pick whichever is less
// friction:
//
//   # 1. Config file
//   cp config.example.json config.json
//   # edit config.json with real clientId/clientSecret + identity/event
//   node invoke.mjs
//
//   # 2. CLI flags (skips the config file entirely)
//   node invoke.mjs --clientId=... --clientSecret=... \
//     --channel=sms --value=+15555550123 --event="your flight is delayed" \
//     [--type=episodic|semantic|working] \
//     [--occurredAt=2026-08-11T10:00:00Z] [--idempotencyKey=k-123]
//
// Pass --port=<port> (or set INSPECTOR_PORT) if your connector isn't on the
// default 9090 — e.g. a second instance started with
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
// --port overrides INSPECTOR_PORT overrides the connector's own default
// (9090) — useful when running a second connector instance per CLAUDE.md's
// multi-instance dev workflow (./scripts/start-connector.sh 9091).
const inspectorPort = flags.port ?? process.env.INSPECTOR_PORT ?? "9090";
const usingFlags = Boolean(flags.channel || flags.value || flags.event);

let config;
if (usingFlags) {
  config = {
    channel: flags.channel,
    value: flags.value,
    event: flags.event,
    type: flags.type,
    occurredAt: flags.occurredAt,
    idempotencyKey: flags.idempotencyKey,
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
    console.error('or pass the values directly: node invoke.mjs --clientId=... --clientSecret=... --channel=sms --value=+1... --event="..."');
    process.exit(1);
  }
}
// CLI flags for the credential always win, even in config-file mode — lets
// you keep a shared config.json (identity/event) out of a client secret you'd
// rather not write to disk.
if (flags.clientId) config.clientId = flags.clientId;
if (flags.clientSecret) config.clientSecret = flags.clientSecret;
if (flags.type) config.type = flags.type;

const { channel, value, event, type, occurredAt, idempotencyKey, clientId, clientSecret } = config;
if (typeof channel !== "string" || typeof value !== "string" || typeof event !== "string") {
  console.error("channel, value, and event must all be strings (via config.json or --channel/--value/--event)");
  process.exit(1);
}
// The route enforces this too (400 bad_request) — checking here just turns a
// round trip into an immediate, clearer message.
const MEMORY_TYPES = ["episodic", "semantic", "working"];
if (type !== undefined && !MEMORY_TYPES.includes(type)) {
  console.error(`type must be one of ${MEMORY_TYPES.join(", ")} when set, got: ${JSON.stringify(type)}`);
  console.error("Omit it entirely to let the controller pick its default (episodic).");
  process.exit(1);
}
if (typeof clientId !== "string" || typeof clientSecret !== "string") {
  console.error("clientId and clientSecret must both be set (via config.json or --clientId/--clientSecret)");
  console.error("Mint a pair from the connector inspector's Network Access panel — see README.md.");
  process.exit(1);
}

// The connector does NOT validate this against the controller's 9-value
// IDENTITY_CHANNEL_KINDS enum by design (that enum is the controller's single
// source of truth). Warn locally so a typo reads as a typo instead of coming
// back as an opaque invalid_params from three hops away.
const KNOWN_CHANNELS = ["voice", "sms", "rcs", "mms", "whatsapp", "webchat", "email", "chat", "test-harness"];
if (!KNOWN_CHANNELS.includes(channel)) {
  console.warn(`Warning: "${channel}" isn't a channel the controller is known to accept.`);
  console.warn(`Expected one of: ${KNOWN_CHANNELS.join(", ")}`);
  console.warn("Sending anyway — the controller is the authority and will answer invalid_params if it disagrees.\n");
}

console.log("Appending a memory event:");
console.log(`  identity:  ${channel} / ${value}`);
console.log(`  event:     ${event}`);
console.log(`  type:      ${type ?? "(omitted — controller default)"}`);
if (occurredAt) console.log(`  occurredAt: ${occurredAt}`);
if (idempotencyKey) console.log(`  idempotencyKey: ${idempotencyKey}`);

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

console.log("Calling POST /v1/memory/events ...");
let res;
try {
  res = await fetch(`http://127.0.0.1:${inspectorPort}/v1/memory/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      identity: { channel, value },
      event,
      ...(type ? { type } : {}),
      ...(occurredAt ? { occurredAt } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }),
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
  if (body.error?.code === "invalid_params") {
    console.error(`The controller rejected the params — most commonly an unrecognized identity.channel ("${channel}").`);
  }
  process.exit(1);
}

console.log("\nSuccess:");
console.log(JSON.stringify(body.result, null, 2));
