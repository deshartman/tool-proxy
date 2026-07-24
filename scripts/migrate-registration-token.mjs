#!/usr/bin/env node
// One-shot migration helper — seed the legacy .connector-state.json's
// registrationToken into the db-mode controllers row.
//
// Context: under env mode the connector persisted its controller-issued
// registrationToken to ./.connector-state.json. Under db mode it lives
// in controllers.registration_token_ct (sealed with the master key).
// When an operator migrates env→db, the DB row is created fresh (no
// token yet), but the controller's connectors table still remembers the
// prior connector row bound to the old token. First register-ack under
// db mode is rejected with `organisation_has_connector` because the
// register frame carries no registrationToken to reuse.
//
// This script seeds the existing token from disk into the DB row so the
// next register frame presents it and the controller binds cleanly.
//
// Usage:
//   node scripts/migrate-registration-token.mjs
//
// Preconditions:
//   - Run from the repo root (paths are relative).
//   - .env or shell env has POSTGRES_URL and CONNECTOR_KEY_FILE set to
//     the same values the connector uses.
//   - .connector-state.json exists at CWD with { registrationToken: … }.
//   - A controllers row exists (configure via the inspector first).
//
// Behavior:
//   - Refuses to overwrite an existing sealed token (row already has one).
//   - Prints the sealed byte length on success as a sanity check.
//
// After this succeeds: click Reconnect in the inspector. On the first
// successful register-ack the connector will delete .connector-state.json
// itself (per plan decision D11), so the migration is one-shot.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import "dotenv/config";

const ROOT = process.cwd();
const STATE_PATH = resolve(ROOT, ".connector-state.json");

if (!existsSync(STATE_PATH)) {
  console.error(`no .connector-state.json at ${STATE_PATH} — nothing to migrate`);
  process.exit(1);
}

const state = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
if (!state.registrationToken || typeof state.registrationToken !== "string") {
  console.error(`.connector-state.json at ${STATE_PATH} has no registrationToken field`);
  process.exit(1);
}

if (!process.env.POSTGRES_URL || !process.env.CONNECTOR_KEY_FILE) {
  console.error("POSTGRES_URL and CONNECTOR_KEY_FILE must be set (in .env or the shell). Load your db-mode config first.");
  process.exit(1);
}

const { ConfigStore } = await import(`${ROOT}/connector/dist/config-store/index.js`);
const { resolveMasterKey } = await import(`${ROOT}/connector/dist/config-store/master-key.js`);
const { initSodium } = await import(`${ROOT}/connector/dist/config-store/seal.js`);

await initSodium();
const masterKey = resolveMasterKey();
const store = await ConfigStore.open(masterKey);

const row = await store.getController();
if (!row) {
  console.error("no controllers row in DB — configure the tunnel via http://127.0.0.1:9090/ first, then rerun this script");
  await store.close();
  process.exit(1);
}

if (row.registrationToken) {
  console.log(`row ${row.id} already has a registrationToken (len=${row.registrationToken.length}); NOT overwriting`);
  await store.close();
  process.exit(0);
}

await store.updateRegistrationToken(row.id, state.registrationToken);
console.log(`seeded registrationToken (len=${state.registrationToken.length}) into row ${row.id}`);
console.log(`next: click Reconnect in the inspector — first successful register-ack will delete ${STATE_PATH}`);
await store.close();
