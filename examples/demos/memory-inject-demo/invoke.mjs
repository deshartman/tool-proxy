// Driver for the machine-API memory-injection routes
// (docs/MEMORY-EVENTS.md / docs/MCP-PROTOCOL.md §"v1.4 — Controller API
// calls"). Plays the role of a real external system calling the connector
// directly — no MCP involved, which is what these routes exist for.
//
// ONE MODE = ONE API CALL. Nothing is combined, nothing is derived, and every
// flag is a field of that call spelled exactly as the wire spells it:
//
//   --list     POST /v1/identity/list   [--identifier --channel --limit --timeoutMs]
//   --inject   POST /v1/memory/events    --agentId --identityId --event
//                                       [--occurredAt --ttlSeconds --idempotencyKey]
//
// Only --list/--inject (which call), --port, --clientId and --clientSecret belong
// to the script; none of those appear in a request body. Reading this file should
// tell you the API. Don't add a flag that renames, combines, or derives an API
// field, and don't make one mode issue two calls.
//
//   node invoke.mjs --clientId=... --clientSecret=... \
//     --list --identifier=+15555550123
//   # -> prints matching identities + their identityIds
//   node invoke.mjs --clientId=... --clientSecret=... \
//     --inject --agentId=agt_123 --identityId=<that> --event="your flight is delayed"
//
// WHY RESOLUTION IS ITS OWN CALL. /v1/memory/events used to take the address and
// let the controller resolve it, but that resolve was find-or-CREATE: a typo'd
// digit minted a phantom customer with a real working-memory row hanging off it,
// and the mistyped write "succeeded" — nobody found out until the agent said
// nothing on the call. Lookup is now read-only and returns an empty array.
//
// `identifier` IS A SUBSTRING, SO RESOLVE CAN RETURN SEVERAL ROWS. There used to
// be a separate exact lookup (identity.find); the controller merged it into this
// one, because an exact address is a substring of itself and two query paths over
// the same data could drift. The catch: "des@example.com" also matches
// "des@example.com.au". NEVER take identities[0] as "the" customer — compare each
// result's `aliases` (always the FULL set per identity, never narrowed by the
// query) against the address you asked about. This script does exactly that below
// and flags the ambiguous cases, which is the pattern an integrator should copy.
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
// TIMING — the note SURVIVES successive turns until it expires, so ttlSeconds is
// genuine shelf life. A consume-once design (strip after any turn) was tried and
// failed in the field: customers open with a greeting, so the note was spent on a
// turn the agent had no reason to use it on and was gone by the turn that
// mattered. The cost of the fix is the opposite risk — a live note goes back on
// the wire every turn, so the agent may raise the fact MORE THAN ONCE inside the
// window. Keep --ttlSeconds tight when that matters.
//
// Pass --port=<port> (or set INSPECTOR_PORT) for a connector that isn't on 9090
// — e.g. a second instance from ./scripts/start-connector.sh 9091.
//
// Exit codes: 0 success, 1 a real failure, 3 --list matched no identity, which is
// NOT a bug — see the message it prints.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CHANNELS = ["phone", "email", "webchat-uid"];
const MODES = ["list", "inject"];

function parseFlags(argv) {
  const flags = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) flags[m[1]] = m[2] ?? "";
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));

// Retired shapes, rejected rather than ignored so a stale shell-history line says
// why instead of failing somewhere unrelated.
if ("customer" in flags) {
  // The field on the retired contract, where the address went straight to
  // /v1/memory/events and the controller resolved it internally.
  console.error("--customer no longer exists. Resolution is its own call:");
  console.error("  --list --identifier=+15555550123");
  process.exit(1);
}
if ("find" in flags) {
  // POST /v1/identity/find is gone: the controller deleted the action, because
  // list's substring `identifier` subsumes an exact lookup.
  console.error("--find no longer exists — identity.find was deleted controller-side.");
  console.error("Its exact lookup is subsumed by --list, whose --identifier is a substring:");
  console.error("  --list --identifier=+15555550123");
  console.error("Note a full address can match SEVERAL identities; check each one's aliases.");
  process.exit(1);
}
if ("match" in flags) {
  // `match` was this param's name until the find/list merge.
  console.error('--match was renamed --identifier (the field the API now takes).');
  console.error("  --list --identifier=smith --channel=email");
  process.exit(1);
}
if (flags.list) {
  // --list used to double as the `match` param, making one flag both a mode
  // selector and a body field.
  console.error("--list takes no value. The substring param is its own flag, as the API names it:");
  console.error("  --list --identifier=smith --channel=email");
  process.exit(1);
}

const chosen = MODES.filter((m) => m in flags);
if (chosen.length !== 1) {
  console.error(
    chosen.length === 0
      ? "Pick exactly one call: --list or --inject."
      : `Pick exactly one call, not ${chosen.map((m) => `--${m}`).join(" + ")}.`,
  );
  console.error("  --list                      [--identifier --channel --limit --timeoutMs]");
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

if (mode === "inject") {
  for (const [name, value] of [["agentId", agentId], ["identityId", identityId], ["event", event]]) {
    if (typeof value !== "string" || !value.trim()) {
      console.error(`--${name} is required for --inject.`);
      process.exit(1);
    }
  }
} else if (channel !== undefined && !CHANNELS.includes(channel)) {
  // Optional on list — it only narrows. Unlike the deleted find route, substring
  // matching never needs the kind in order to match (ILIKE is case-insensitive
  // on its own), so absence means "any kind".
  console.error(`--channel must be one of: ${CHANNELS.join(", ")} when supplied`);
  if (channel) console.error(`Got "${channel}". Note "sms"/"voice"/"whatsapp" all resolve as "phone".`);
  process.exit(1);
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
      console.error("Raise --timeoutMs (up to 120000), or narrow with --identifier / --channel.");
      console.error("Do NOT loop on this: the controller's query can't be cancelled, so it runs to");
      console.error("completion either way and a retry loop just stacks abandoned scans on it.");
    }
    process.exit(1);
  }
  return parsed.result;
}

function printIdentity(id, marker = "") {
  const aliases = (id.aliases ?? []).map((a) => `${a.channel}:${a.value}`).join(", ");
  console.log(`  ${id.identityId}${marker}`);
  // aliases is the FULL set, never narrowed by the query — search by email and
  // you still get their phone. It's also what you disambiguate on.
  console.log(`    aliases:      ${aliases || "(none)"}`);
  console.log(`    isTemp:       ${id.isTemp}   (false once a CRM hydration confirmed it)`);
  console.log(`    lastEngaged:  ${id.lastEngagedAt ?? "never"}   sessions: ${id.sessionCount}`);
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

// --- identity.list -----------------------------------------------------------

if (mode === "list") {
  console.log(
    `\nPOST /v1/identity/list ${identifier ? `(identifier substring "${identifier}")` : "(no identifier — the WHOLE account)"} ...`,
  );
  const result = await post(
    "/v1/identity/list",
    {
      ...(identifier ? { identifier } : {}),
      ...(channel ? { channel } : {}),
      // No default page size: omitting limit returns the whole account by design,
      // and substituting one here would reintroduce the silent truncation the
      // controller refused to ship.
      ...(flags.limit ? { limit: Number(flags.limit) } : {}),
      ...(flags.timeoutMs ? { timeoutMs: Number(flags.timeoutMs) } : {}),
    },
    accessToken,
  );

  const identities = result?.identities ?? [];

  if (identities.length === 0) {
    // NOT a bug, and worth spelling out — the natural but wrong reading of an
    // empty array is "injection is broken for new customers". This carries
    // exactly the meaning the deleted find route's `identity: null` had.
    console.log(`\nNo identity matched${identifier ? ` "${identifier}"` : ""}.`);
    console.log("\nThis is a normal answer, not a failure: the controller has never interacted");
    console.log("with this customer, so there is no conversation history to prepend a note to.");
    console.log("Lookup is deliberately read-only — it will not create one.");
    if (identifier && /^identity[_-]/i.test(identifier)) {
      console.log("\nThat looks like an identityId. --identifier matches ADDRESSES, not handles.");
      console.log("If you already hold the identityId, skip this call and use --inject.");
      process.exit(3);
    }
    console.log("\nFor a never-contacted customer, put the fact in the outbound call's own");
    console.log("callContext instead, where it rides the call into hydration:");
    console.log(`  ../outbound-demo/run-outbound.sh --agentId=<agt> --channelId=<chn> \\`);
    console.log(`    --to=${identifier || "<address>"} --action=place_call`);
    console.log("\nIf you expected a hit, check for a typo — or drop --identifier to list everyone.");
    process.exit(3);
  }

  // THE disambiguation step. `identifier` is a substring, so a full address can
  // pull in neighbours: "des@example.com" also matches "des@example.com.au".
  // Comparing against each identity's full alias set is the only way to tell
  // which row is the customer you meant — copy this, don't take identities[0].
  const needle = identifier?.trim().toLowerCase();
  const isExact = (id) => (id.aliases ?? []).some((a) => String(a.value).trim().toLowerCase() === needle);
  const exact = needle ? identities.filter(isExact) : [];

  console.log(`\n${identities.length} identit${identities.length === 1 ? "y" : "ies"}:\n`);
  for (const id of identities) {
    printIdentity(id, needle && isExact(id) ? "   <- exact alias match" : "");
    console.log("");
  }

  if (needle && exact.length === 1) {
    console.log("One exact alias match. Inject against it with:");
    console.log(`  --inject --agentId=<agt> --identityId=${exact[0].identityId} --event="..."`);
  } else if (needle && exact.length > 1) {
    console.log(`${exact.length} identities carry that exact alias — they may be pending a merge.`);
    console.log("Pick deliberately; don't assume the first is the right one.");
  } else if (needle) {
    console.log(`No alias equals "${identifier}" exactly — every row above is a SUBSTRING match.`);
    console.log("Injecting against one of these would target a different customer. Check the");
    console.log("aliases, or re-run with the full address.");
  } else {
    console.log("Inject against one with:");
    console.log('  --inject --agentId=<agt> --identityId=<from above> --event="..."');
  }
  process.exit(0);
}

// --- memory.inject_context ---------------------------------------------------

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
// expiresAt is the post-clamp truth. The controller's range policy is asymmetric:
// above 86400s is clamped (its absolute-age sweeper flushes a working row at 24h
// regardless of activity, so a longer promise would be a lie), while 0, negative
// and fractional values are rejected outright.
if (result?.expiresAt) {
  console.log(`\nThe note is live until ${result.expiresAt} (post-clamp).`);
  console.log("It survives successive turns until then, so the agent may raise the fact more");
  console.log("than once inside that window — keep --ttlSeconds tight if that matters.");
}
// stored: true means WRITTEN, not SPOKEN. If the agent never voices the fact it
// leaves no trace at all: the note expires either way and no episode is
// written, so the controller's own controller_action log line is the only record
// the injection happened.
console.log('\nNote: `stored: true` means written, not mentioned. If the agent never voices it,');
console.log("no episodic trace is left — only the controller's audit line.");
