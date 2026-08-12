// Driver for the v1.4 controller-call tunnel mechanism
// (docs/MCP-PROTOCOL.md §"v1.4 — Controller API calls (Twilio-bundled only)"),
// targeting the memory-injection actions. Round trip per run:
//
//   this script -> connector inspector's loopback /tool/call
//               -> memory-event-demo's list|invoke tool
//               -> callControllerApi -> tunnel -> controller action -> back
//
// ONE MODE = ONE TOOL CALL. Every flag is a param of that tool, spelled as the
// tool spells it:
//
//   --list     list   tool   [--identifier --channel --limit]
//   --inject   invoke tool    --agentId --identityId --event
//                            [--occurredAt --ttlSeconds --idempotencyKey]
//
// Only the mode flags and --port belong to the script. Reading this file should
// tell you the tool schemas. Don't add a flag that renames, combines, or derives
// a param, and don't let one mode issue two calls.
//
//   node invoke.mjs --list --identifier=+15555550123
//   # -> prints matching identities + their identityIds
//   node invoke.mjs --inject --agentId=agt_123 --identityId=<that> --event="..."
//
// WHY RESOLUTION IS ITS OWN CALL. /v1/memory/events used to take the address
// directly, but that resolve was find-or-CREATE — a typo minted a phantom
// customer and the write silently "succeeded". Lookup is now read-only.
//
// `identifier` IS A SUBSTRING, SO RESOLVE CAN RETURN SEVERAL ROWS. A separate
// exact lookup (identity.find) existed until the controller merged it into this
// one: an exact address is a substring of itself, and two query paths over the
// same data could drift. The catch: "des@example.com" also matches
// "des@example.com.au". NEVER take identities[0] as "the" customer — compare each
// result's `aliases` (always the FULL set per identity, never narrowed by the
// query) against the address you asked about. This script does that below and
// flags the ambiguous cases.
//
// See README.md for full setup: the drop-in must be activated into
// bundled-mcps/memory-event-demo/ (author gate — the README explains why it
// can't go in customer-mcps/ like sample/crm), and connector.yaml's
// policy.tool_timeout_ms must be raised to 10000+ before starting the connector
// (35000+ to use --list against a large account).
//
// No confirmation prompt, unlike outbound-demo's driver: writing a memory fact
// has no Twilio spend, and the controller explicitly accepts a
// duplicate-on-retry as low-harm (see README.md).
//
// Pass --port=<port> (or set INSPECTOR_PORT) for a connector that isn't on 9090
// — e.g. a second instance from ./scripts/start-connector.sh 9091.
//
// Exit codes: 0 success, 1 a real failure, 3 --list matched no identity, which is
// NOT a bug.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CHANNELS = ["phone", "email", "webchat-uid"];
const MODES = ["list", "inject"];
const TOOL = { list: "list", inject: "invoke" };

function parseFlags(argv) {
  const flags = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) flags[m[1]] = m[2] ?? "";
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));

// Retired shapes, rejected rather than ignored.
if ("customer" in flags) {
  console.error("--customer no longer exists. Resolution is its own call:");
  console.error("  --list --identifier=+15555550123");
  process.exit(1);
}
if ("find" in flags) {
  console.error("--find no longer exists — identity.find was deleted controller-side.");
  console.error("Its exact lookup is subsumed by --list, whose --identifier is a substring:");
  console.error("  --list --identifier=+15555550123");
  console.error("Note a full address can match SEVERAL identities; check each one's aliases.");
  process.exit(1);
}
if ("match" in flags) {
  console.error("--match was renamed --identifier (the param the tool now takes).");
  console.error("  --list --identifier=smith --channel=email");
  process.exit(1);
}
if (flags.list) {
  console.error("--list takes no value. The substring param is its own flag, as the tool names it:");
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
  console.error("  --list                      [--identifier --channel --limit]");
  console.error("  --inject  --agentId --identityId --event  [--occurredAt --ttlSeconds --idempotencyKey]");
  process.exit(1);
}
const mode = chosen[0];
const inspectorPort = flags.port ?? process.env.INSPECTOR_PORT ?? "9090";

// config.json supplies field defaults (agentId is the one worth keeping there).
// A positional path MUST load; the default path is optional. Flags always win.
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
for (const k of ["agentId", "identityId", "identifier", "channel", "event", "occurredAt", "idempotencyKey"]) {
  if (flags[k] !== undefined) config[k] = flags[k];
}
if (flags.ttlSeconds !== undefined) config.ttlSeconds = Number(flags.ttlSeconds);

const { agentId, identityId, identifier, channel, event, occurredAt, ttlSeconds, idempotencyKey } = config;

// --- validate everything local BEFORE touching the network -------------------

if (mode === "inject") {
  for (const [name, value] of [["agentId", agentId], ["identityId", identityId], ["event", event]]) {
    if (typeof value !== "string" || !value.trim()) {
      console.error(`--${name} is required for --inject.`);
      process.exit(1);
    }
  }
} else if (channel !== undefined && !CHANNELS.includes(channel)) {
  // Optional on list — it only narrows. Substring matching never needs the kind
  // in order to match, unlike the deleted find route's equality lookup.
  console.error(`--channel must be one of: ${CHANNELS.join(", ")} when supplied`);
  if (channel) console.error(`Got "${channel}". Note "sms"/"voice"/"whatsapp" all resolve as "phone".`);
  process.exit(1);
}

// --- transport ---------------------------------------------------------------
// Unwraps the two nested failure layers this path has: the dispatch envelope
// (body.ok) and the tool's own isError result carrying { code, message }.

async function callTool(tool, args) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${inspectorPort}/tool/call`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-inspector-request": "1" },
      body: JSON.stringify({ server: "memory-event-demo", tool, args }),
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
    const code = parsed.error?.code;
    console.error(`Controller action failed (${tool}): ${code} — ${parsed.error?.message}`);
    if (code === "cross_account") {
      console.error("That agentId or identityId belongs to a different account than this tunnel session.");
    }
    if (code === "timeout" && tool === TOOL.list) {
      console.error("identity.list has no cap, and a timeout returns NOTHING rather than a partial list.");
      console.error("Narrow with --identifier / --channel, or raise policy.tool_timeout_ms.");
      console.error("Do NOT loop on this: the controller's query can't be cancelled, so a retry loop");
      console.error("just stacks abandoned full-account scans on it.");
    }
    process.exit(1);
  }
  return result?.structuredContent ?? result;
}

function printIdentity(id, marker = "") {
  const aliases = (id.aliases ?? []).map((a) => `${a.channel}:${a.value}`).join(", ");
  console.log(`  ${id.identityId}${marker}`);
  // aliases is the FULL set, never narrowed by the query — and it's what you
  // disambiguate on.
  console.log(`    aliases:      ${aliases || "(none)"}`);
  console.log(`    isTemp:       ${id.isTemp}`);
  console.log(`    lastEngaged:  ${id.lastEngagedAt ?? "never"}   sessions: ${id.sessionCount}`);
}

// --- list --------------------------------------------------------------------

if (mode === "list") {
  console.log(
    `Calling the \`list\` tool ${identifier ? `(identifier substring "${identifier}")` : "(no identifier — the WHOLE account)"} ...`,
  );
  const out = await callTool(TOOL.list, {
    ...(identifier ? { identifier } : {}),
    ...(channel ? { channel } : {}),
    // No default page size — omitting limit returns the whole account by design.
    ...(flags.limit ? { limit: Number(flags.limit) } : {}),
  });
  const identities = out?.identities ?? [];

  if (identities.length === 0) {
    // NOT a bug — an empty array carries exactly the meaning the deleted find
    // route's `identity: null` had.
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
    console.log("callContext instead, where it rides the call into hydration.");
    console.log("\nIf you expected a hit, check for a typo — or drop --identifier to list everyone.");
    process.exit(3);
  }

  // THE disambiguation step — `identifier` is a substring, so a full address can
  // pull in neighbours. Comparing against each identity's full alias set is the
  // only way to tell which row is the customer you meant.
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
    console.log("Injecting against one of these would target a different customer.");
  } else {
    console.log("Inject against one with:");
    console.log('  --inject --agentId=<agt> --identityId=<from above> --event="..."');
  }
  process.exit(0);
}

// --- inject ------------------------------------------------------------------

console.log("Calling the `invoke` tool (memory.inject_context):");
console.log(`  agentId:    ${agentId}`);
console.log(`  identityId: ${identityId}`);
console.log(`  event:      ${event}`);
if (occurredAt) console.log(`  occurredAt: ${occurredAt}`);
if (ttlSeconds !== undefined) console.log(`  ttlSeconds: ${ttlSeconds}`);
if (idempotencyKey) console.log(`  idempotencyKey: ${idempotencyKey}`);

const out = await callTool(TOOL.inject, {
  agentId,
  identityId,
  event,
  ...(occurredAt ? { occurredAt } : {}),
  // `!== undefined`, not truthiness: the controller REJECTS ttlSeconds: 0 with
  // invalid_params, and dropping the 0 would silently substitute the 600s
  // default so the caller never learns they asked for something invalid.
  ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
  ...(idempotencyKey ? { idempotencyKey } : {}),
});

console.log("\nSuccess:");
console.log(JSON.stringify(out, null, 2));
// expiresAt is post-clamp. The note survives successive turns until then, so
// ttlSeconds is genuine shelf life — with the opposite risk attached: a live note
// goes back on the wire every turn, so the fact may be raised more than once.
if (out?.expiresAt) {
  console.log(`\nThe note is live until ${out.expiresAt} (post-clamp), and survives successive turns.`);
}
// stored: true means WRITTEN, not SPOKEN. A fact the agent never voices leaves no
// trace — the note expires either way, no episode written, recorded only in the
// controller's own audit line.
console.log('\nNote: `stored: true` means written, not mentioned.');
