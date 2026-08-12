// Driver for the machine-API memory-injection routes
// (docs/MEMORY-EVENTS.md / docs/MCP-PROTOCOL.md §"v1.4 — Controller API
// calls"). Plays the role of a real external system calling the connector
// directly — no MCP involved, which is what these routes exist for.
//
// ONE MODE = ONE API CALL. Nothing is combined, nothing is derived, and every
// flag is a field of that call spelled exactly as the wire spells it:
//
//   --list     POST /v1/identity/list    [--match --channel --limit --timeoutMs]
//   --find     POST /v1/identity/find     --identifier --channel
//   --inject   POST /v1/memory/events     --agentId --identityId --event
//                                        [--occurredAt --ttlSeconds --idempotencyKey]
//
// Only --list/--find/--inject (which call), --port, --clientId and
// --clientSecret belong to the script; none of those appear in a request body.
// Reading this file should tell you the API. Don't add a flag that renames,
// combines, or derives an API field, and don't make one mode issue two calls —
// an earlier version resolved-then-wrote in a single run, which made the write
// look as though it accepted an address when it only ever accepted an
// identityId.
//
// The normal sequence is find (or list) to get an identityId, then inject with
// it. They're separate runs because they're separate calls:
//
//   node invoke.mjs --clientId=... --clientSecret=... \
//     --find --identifier=+15555550123 --channel=phone
//   # -> prints identityId
//   node invoke.mjs --clientId=... --clientSecret=... \
//     --inject --agentId=agt_123 --identityId=<that> --event="your flight is delayed"
//
// WHY RESOLUTION IS ITS OWN CALL. /v1/memory/events used to take the address and
// let the controller resolve it, but that resolve was find-or-CREATE: a typo'd
// digit minted a phantom customer with a real working-memory row hanging off it,
// and the mistyped write "succeeded" — nobody found out until the agent said
// nothing on the call. Lookup is now read-only; a typo comes back as
// `identity: null`. See README.md §"Why the extra round trip".
//
// Credentials: add an API client via the inspector's Network Access panel (or
// POST /internal/network-access/clients) and pass --clientId/--clientSecret, or
// put them in config.json (cp config.example.json config.json). Flags win.
//
// No confirmation prompt, unlike outbound-demo: a memory write has no Twilio
// spend and no external side effect, and the controller accepts a
// duplicate-on-retry as low-harm (it does not dedup in v1). It does write a real
// note into a real agent's working memory, so point it at a test agent.
//
// Timing: working memory flushes to episodic after ttlSeconds of inactivity
// (default 600s) and injecting does NOT reset that clock. Inject immediately
// before the outbound leg that should mention the fact, or raise --ttlSeconds to
// hold the row open for an INBOUND contact.
//
// Pass --port=<port> (or set INSPECTOR_PORT) for a connector that isn't on 9090
// — e.g. a second instance from ./scripts/start-connector.sh 9091.
//
// Exit codes: 0 success, 1 a real failure, 3 --find found no such customer,
// which is NOT a bug — see the message it prints.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CHANNELS = ["phone", "email", "webchat-uid"];
const MODES = ["list", "find", "inject"];

function parseFlags(argv) {
  const flags = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) flags[m[1]] = m[2] ?? "";
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));

// Retired shapes, rejected rather than ignored so a stale shell-history line
// says why instead of failing somewhere unrelated.
if ("customer" in flags) {
  // Was the field on the retired contract, where the address went straight to
  // /v1/memory/events. The field find takes is `identifier`.
  console.error("--customer no longer exists. Resolution is its own call:");
  console.error("  --find --identifier=+15555550123 --channel=phone");
  process.exit(1);
}
if (flags.list) {
  // --list used to double as the `match` param, making one flag both a mode
  // selector and a body field.
  console.error("--list takes no value. The substring param is its own flag, as the API names it:");
  console.error("  --list --match=smith --channel=email");
  process.exit(1);
}

const chosen = MODES.filter((m) => m in flags);
if (chosen.length !== 1) {
  console.error(
    chosen.length === 0
      ? "Pick exactly one call: --list, --find, or --inject."
      : `Pick exactly one call, not ${chosen.map((m) => `--${m}`).join(" + ")}.`,
  );
  console.error("  --list                      [--match --channel --limit --timeoutMs]");
  console.error("  --find    --identifier --channel");
  console.error("  --inject  --agentId --identityId --event  [--occurredAt --ttlSeconds --idempotencyKey]");
  process.exit(1);
}
const mode = chosen[0];

// --port overrides INSPECTOR_PORT overrides the connector's default (9090).
const inspectorPort = flags.port ?? process.env.INSPECTOR_PORT ?? "9090";
const base = `http://127.0.0.1:${inspectorPort}`;

// config.json supplies credentials (and any field defaults) so a client secret
// needn't be pasted into a shell. A positional path MUST load; the default path
// is optional. Flags always win.
const positional = process.argv.slice(2).find((a) => !a.startsWith("--"));
let config = {};
try {
  config = JSON.parse(await readFile(resolve(process.cwd(), positional ?? resolve(here, "config.json")), "utf8"));
} catch (err) {
  if (positional) {
    console.error(`Failed to read config at ${positional}: ${err.message}`);
    process.exit(1);
  }
}
for (const k of ["clientId", "clientSecret", "agentId", "identityId", "identifier", "channel", "event", "occurredAt", "idempotencyKey"]) {
  if (flags[k] !== undefined) config[k] = flags[k];
}
if (flags.ttlSeconds !== undefined) config.ttlSeconds = Number(flags.ttlSeconds);

const { clientId, clientSecret, agentId, identityId, identifier, channel, event, occurredAt, ttlSeconds, idempotencyKey } = config;

// --- validate everything local BEFORE touching the network -------------------
// A caller who mistyped --channel should be told that, not handed a "connector
// unreachable" from an unrelated hop.

if (typeof clientId !== "string" || !clientId || typeof clientSecret !== "string" || !clientSecret) {
  console.error("clientId and clientSecret are both required (config.json or --clientId/--clientSecret).");
  console.error("Mint a pair from the inspector's Network Access panel — see README.md.");
  process.exit(1);
}

function requireStrings(pairs) {
  for (const [name, value] of pairs) {
    if (typeof value !== "string" || !value.trim()) {
      console.error(`--${name} is required for --${mode}.`);
      process.exit(1);
    }
  }
}

// channel is REQUIRED on find and never derived: the controller's normalisation
// is kind-aware (lowercase for email, trim-only for phone and webchat-uid), so
// an exact lookup is impossible without knowing the kind. Sniffing it from the
// string shape is what the retired contract did, and is why opaque webchat UIDs
// were unreachable. On list it's optional — it only narrows.
function requireChannel(optional) {
  if (optional && channel === undefined) return;
  if (!CHANNELS.includes(channel)) {
    console.error(`--channel must be one of: ${CHANNELS.join(", ")}${optional ? " when supplied" : ""}`);
    if (channel) console.error(`Got "${channel}". Note "sms"/"voice"/"whatsapp" all resolve as "phone".`);
    process.exit(1);
  }
}

if (mode === "find") {
  requireStrings([["identifier", identifier]]);
  requireChannel(false);
} else if (mode === "inject") {
  requireStrings([
    ["agentId", agentId],
    ["identityId", identityId],
    ["event", event],
  ]);
} else {
  requireChannel(true);
}

// --- transport ---------------------------------------------------------------

async function post(path, body, token) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`Could not reach the connector inspector on port ${inspectorPort}: ${err.message}`);
    console.error("Is the connector running (./scripts/start-connector.sh)?");
    process.exit(1);
  }
  const parsed = await res.json();
  if (!res.ok) {
    const err = parsed.error;
    console.error(`${path} failed: ${err?.code} — ${err?.message}`);
    if (err?.code === "tunnel_unavailable") {
      console.error("No live tunnel — check the connector's Tunnel panel.");
    }
    if (err?.code === "cross_account") {
      console.error("That agentId or identityId belongs to a different account than this tunnel session.");
    }
    if (err?.code === "timeout" && path === "/v1/identity/list") {
      console.error("identity.list has no cap — a large account can exceed the window, and a timeout");
      console.error("returns NOTHING rather than a partial list.");
      console.error("Raise --timeoutMs (up to 120000), or narrow with --match / --channel.");
      console.error("Do NOT loop on this: the controller's query can't be cancelled, so it runs to");
      console.error("completion either way and a retry loop just stacks abandoned scans on it.");
    }
    process.exit(1);
  }
  return parsed.result;
}

function printIdentity(id, indent = "  ") {
  const aliases = (id.aliases ?? []).map((a) => `${a.channel}:${a.value}`).join(", ");
  console.log(`${indent}identityId:   ${id.identityId}`);
  // aliases is the FULL set, never narrowed by the query — search by email and
  // you still get their phone.
  console.log(`${indent}aliases:      ${aliases || "(none)"}`);
  console.log(`${indent}isTemp:       ${id.isTemp}   (false once a CRM hydration confirmed it)`);
  console.log(`${indent}lastEngaged:  ${id.lastEngagedAt ?? "never"}   sessions: ${id.sessionCount}`);
}

// --- bearer ------------------------------------------------------------------

console.log(`Minting a bearer token from ${base}/oauth/token ...`);
let tokenRes;
try {
  tokenRes = await fetch(`${base}/oauth/token`, {
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
const accessToken = tokenBody.access_token;

// --- 1. identity.list --------------------------------------------------------

if (mode === "list") {
  const match = flags.match || undefined;
  console.log(`\nPOST /v1/identity/list ${match ? `(match="${match}")` : "(no match — the WHOLE account)"} ...`);
  const result = await post(
    "/v1/identity/list",
    {
      ...(match ? { match } : {}),
      ...(channel ? { channel } : {}),
      // No default page size: omitting limit returns the whole account by
      // design, and substituting one here would reintroduce the silent
      // truncation the controller refused to ship.
      ...(flags.limit ? { limit: Number(flags.limit) } : {}),
      ...(flags.timeoutMs ? { timeoutMs: Number(flags.timeoutMs) } : {}),
    },
    accessToken,
  );
  const identities = result?.identities ?? [];
  console.log(`\n${identities.length} identit${identities.length === 1 ? "y" : "ies"}:\n`);
  for (const id of identities) {
    printIdentity(id);
    console.log("");
  }
  console.log("Inject against one with:");
  console.log('  --inject --agentId=<agt> --identityId=<from above> --event="..."');
  process.exit(0);
}

// --- 2. identity.find --------------------------------------------------------

if (mode === "find") {
  console.log(`\nPOST /v1/identity/find (${channel}: ${identifier}) ...`);
  const result = await post("/v1/identity/find", { identifier, channel }, accessToken);

  const identity = result?.identity ?? null;
  if (!identity) {
    // NOT a bug, and worth spelling out — the natural but wrong reading of null
    // is "injection is broken for new customers".
    console.log(`\nNo identity found for ${channel}: ${identifier}`);
    console.log("\nThis is a normal answer, not a failure: the controller has never interacted");
    console.log("with this customer, so there is no conversation history to prepend a note to.");
    console.log("Lookup is deliberately read-only — it will not create one.");
    // Most likely cause of an unexpected null: --list prints identityIds, so
    // it's easy to feed one back in here. A hint, NOT validation — the
    // identifier is deliberately opaque (a webchat-uid can be any string, and
    // shape-sniffing the address is the retired contract's mistake). Safe to
    // guess on a path that has already failed.
    if (/^identity[_-]/i.test(identifier)) {
      console.log("\nThat looks like an identityId. --identifier takes the ADDRESS the identity is");
      console.log("known by, e.g. --identifier=+61401277115 --channel=phone. If you already hold");
      console.log("the identityId, you don't need this call at all — go straight to --inject.");
      process.exit(3);
    }
    console.log("\nFor a never-contacted customer, put the fact in the outbound call's own");
    console.log("callContext instead, where it rides the call into hydration:");
    console.log(`  ../outbound-demo/run-outbound.sh --agentId=<agt> --channelId=<chn> \\`);
    console.log(`    --to=${identifier} --action=place_call`);
    console.log("\nIf you expected a hit, check for a typo — or run --list to see who is known.");
    process.exit(3);
  }

  console.log("");
  printIdentity(identity);
  console.log("\nInject against it with:");
  console.log(`  --inject --agentId=<agt> --identityId=${identity.identityId} --event="..."`);
  process.exit(0);
}

// --- 3. memory.inject_context ------------------------------------------------

console.log("\nPOST /v1/memory/events ...");
console.log(`  agentId:    ${agentId}`);
console.log(`  identityId: ${identityId}`);
console.log(`  event:      ${event}`);
if (occurredAt) console.log(`  occurredAt: ${occurredAt}`);
if (ttlSeconds !== undefined) console.log(`  ttlSeconds: ${ttlSeconds}`);
if (idempotencyKey) console.log(`  idempotencyKey: ${idempotencyKey}`);

const result = await post(
  "/v1/memory/events",
  {
    agentId,
    identityId,
    event,
    ...(occurredAt ? { occurredAt } : {}),
    // `!== undefined`, not truthiness: the controller REJECTS ttlSeconds: 0 with
    // invalid_params, and dropping the 0 here would silently substitute the 600s
    // default so the caller never learns they asked for something invalid.
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  },
  accessToken,
);

console.log("\nSuccess:");
console.log(JSON.stringify(result, null, 2));
// expiresAt is the post-clamp truth. The controller's range policy is
// asymmetric: above 86400s is clamped (its absolute-age sweeper flushes a
// working row at 24h regardless of activity, so a longer promise would be a
// lie), while 0, negative and fractional values are rejected outright.
if (result?.expiresAt) {
  console.log(`\nThe note is live until ${result.expiresAt} (post-clamp).`);
  console.log("Inject-then-outbound works regardless; inject-then-wait-for-inbound needs a TTL");
  console.log("long enough to cover the gap — pass --ttlSeconds.");
}
