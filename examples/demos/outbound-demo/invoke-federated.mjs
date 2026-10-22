// Smoke test for the machine-API outbound-calls route in FEDERATED mode
// (docs/NETWORK-ACCESS.md "Federated mode" + docs/OUTBOUND-CALLS.md §7).
//
// Federated mode differs from invoke.mjs (self-issued) in exactly one way:
// the connector does NOT mint the bearer. An external IdP signs an RS256
// JWT, and the connector verifies it against that IdP's published JWKS. So
// there is no POST /oauth/token step here — instead this script PLAYS THE
// IDP:
//   1. generate a throwaway RSA keypair,
//   2. serve its public half as a JWKS on a local port,
//   3. configure the connector's trusted issuer to point at that JWKS
//      (POST /internal/network-access/trusted-issuer),
//   4. sign an RS256 token with iss/aud matching that config,
//   5. POST /v1/outbound/calls with it,
//   6. restore the connector's prior trusted-issuer config (or clear it).
//
// That gives you a one-command, zero-external-dependency proof that the
// federated path works end to end. When you're ready to test against a REAL
// IdP (Auth0/Okta/Entra/Keycloak/…), skip the keypair generation with
// --token=<a real RS256 JWT> and point the connector at the real JWKS with
// --issuer/--jwksUrl/--audience (or just configure it once in the inspector
// UI and pass only --token).
//
// CAUTION: on confirm, this places/sends a REAL call/message through
// whatever agent/channel the controller resolves — not a simulation.
//
// Usage:
//   # stub-IdP mode (default) — reuses config.json for action/to/agentId/channelId
//   node invoke-federated.mjs --port=9091
//   # bring-your-own real IdP token (connector already configured, or pass the 3 fields)
//   node invoke-federated.mjs --port=9091 --token=<jwt> \
//     [--issuer=... --jwksUrl=... --audience=...]

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createServer } from "node:http";
import { generateKeyPairSync, createSign } from "node:crypto";

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
const base = `http://127.0.0.1:${inspectorPort}`;
const csrf = { "content-type": "application/json", "x-inspector-request": "1" };
const b64url = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

// Call params come from config.json (same file invoke.mjs uses) unless
// overridden by flags. clientId/clientSecret are ignored here — federated
// mode has no connector-minted credential.
const usingFlags = Boolean(flags.to || flags.agentId || flags.channelId);
let cfg;
if (usingFlags) {
  cfg = { action: flags.action ?? "place_call", to: flags.to, agentId: flags.agentId, channelId: flags.channelId,
          callContext: flags.callContext ? JSON.parse(flags.callContext) : undefined };
} else {
  const configPath = resolve(here, "config.json");
  try { cfg = JSON.parse(await readFile(configPath, "utf8")); }
  catch (err) {
    console.error(`Failed to read ${configPath}: ${err.message}`);
    console.error("cp config.example.json config.json and fill in action/to/agentId/channelId, or pass --to/--agentId/--channelId.");
    process.exit(1);
  }
}
const { action, to, agentId, channelId, callContext } = cfg;
if (!["place_call", "send_message"].includes(action)) {
  console.error(`action must be "place_call" or "send_message", got: ${JSON.stringify(action)}`);
  process.exit(1);
}
if (typeof to !== "string" || typeof agentId !== "string" || typeof channelId !== "string") {
  console.error("to, agentId, and channelId must all be strings (config.json or --to/--agentId/--channelId).");
  process.exit(1);
}

// Federated identity. In stub mode these default; with a real IdP, pass them.
const issuer = flags.issuer ?? "https://demo-idp.local/outbound-federated";
const audience = flags.audience ?? "tool-proxy-outbound-demo";
const kid = "outbound-demo-key";

console.log(`About to ${action} (FEDERATED / RS256 bearer):`);
console.log(`  to:        ${to}`);
console.log(`  agentId:   ${agentId}`);
console.log(`  channelId: ${channelId}`);
if (callContext) console.log(`  callContext: ${JSON.stringify(callContext)}`);
console.log(`  issuer:    ${issuer}`);
console.log(`This will trigger a REAL ${action === "place_call" ? "phone call" : "SMS"} via Twilio — not a simulation.`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question("Proceed? [y/N] ");
rl.close();
if (!/^y(es)?$/i.test(answer.trim())) { console.log("Aborted — no request sent."); process.exit(0); }

// ── Build the token + (in stub mode) the JWKS server ────────────────────────
let token = flags.token;
let jwksUrl = flags.jwksUrl;
let jwksServer;
if (!token) {
  // Stub-IdP mode: generate a keypair, serve JWKS locally, sign a token.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
  jwksServer = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((r) => jwksServer.listen(0, "127.0.0.1", r));
  jwksUrl = `http://127.0.0.1:${jwksServer.address().port}/jwks.json`;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid };
  const payload = { sub: "outbound-demo-caller", iss: issuer, aud: audience, iat: now, exp: now + 600 };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  token = `${signingInput}.${createSign("RSA-SHA256").update(signingInput).sign(privateKey).toString("base64url")}`;
  console.log(`\nStub IdP: serving JWKS at ${jwksUrl}, signed a 10-min RS256 token.`);
} else if (!jwksUrl) {
  console.log("\nUsing supplied --token; assuming the connector's trusted issuer is already configured (inspector UI or a prior run).");
}

// Snapshot the connector's current trusted-issuer config so we can RESTORE it
// afterward instead of clobbering a real one you may already have set.
let priorConfig = null;
try {
  const r = await fetch(`${base}/internal/network-access/trusted-issuer`);
  priorConfig = (await r.json()).config ?? null;
} catch (err) {
  console.error(`Could not reach the connector inspector on ${base}: ${err.message}`);
  console.error("Is the connector running (./scripts/start-connector.sh <port>) and on this port?");
  jwksServer?.close();
  process.exit(1);
}

async function setTrustedIssuer(config) {
  const r = await fetch(`${base}/internal/network-access/trusted-issuer`, { method: "POST", headers: csrf, body: JSON.stringify(config) });
  if (!r.ok) throw new Error(`trusted-issuer config failed: HTTP ${r.status} ${await r.text()}`);
}

let exitCode = 0;
try {
  // Configure the trusted issuer for this run (skip only if using a real
  // token AND not given the 3 fields — then we trust the existing config).
  if (jwksUrl) {
    await setTrustedIssuer({ issuer, jwksUrl, audience });
    console.log(`Configured trusted issuer on ${base}.`);
  }

  console.log("Calling POST /v1/outbound/calls with the RS256 bearer ...");
  const res = await fetch(`${base}/v1/outbound/calls`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, to, agentId, channelId, ...(callContext ? { callContext } : {}) }),
  });
  const body = await res.json();
  if (!res.ok) {
    exitCode = 1;
    console.error(`\nFailed: ${body.error?.code} — ${body.error?.message}`);
    if (body.error?.code === "tunnel_unavailable") console.error("No live tunnel — check the connector's Tunnel panel.");
    if (body.error?.code === "not_authorized") console.error("Auth rejected — token iss/aud must match the trusted-issuer config, and the JWKS must be reachable from the connector.");
  } else {
    console.log("\nSuccess:");
    console.log(JSON.stringify(body.result, null, 2));
  }
} catch (err) {
  exitCode = 1;
  console.error(`\nError: ${err.message}`);
} finally {
  // Restore the connector to its prior state so this test leaves no trace:
  // put back a real config if one existed, otherwise clear (unless --keep-issuer).
  if (jwksUrl && !("keep-issuer" in flags)) {
    try {
      if (priorConfig) { await setTrustedIssuer(priorConfig); console.log("Restored the connector's prior trusted-issuer config."); }
      else { await fetch(`${base}/internal/network-access/trusted-issuer/clear`, { method: "POST", headers: csrf, body: "{}" }); console.log("Cleared the trusted-issuer config (there was none before)."); }
    } catch (err) { console.error(`Cleanup warning: ${err.message}`); }
  }
  jwksServer?.close();
}
process.exit(exitCode);
