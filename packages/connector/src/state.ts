import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { envString } from "./env.js";

// Persistent state for a registered connector. Currently holds just the
// registrationToken handed back by the controller on first connect; future
// fields (rotated tokens, last-known connectorId) can be added here without
// changing the customer-visible config surface.
//
// The file lives in CWD — next to the customer's `.env` and `connector.yaml`.
// Gitignored. Customer never edits it directly — clearing it forces a re-mint.
// Override via CONNECTOR_STATE_PATH if you need a different location (e.g. a
// mounted volume in a container).

export interface ConnectorState {
  /** Persisted token from the controller's register-ack. Used as the identity
   *  claim on every subsequent register frame. Absent before first connect. */
  registrationToken?: string;
}

const DEFAULT_PATH = ".connector-state.json";

export function defaultStatePath(): string {
  return resolve(envString("CONNECTOR_STATE_PATH", DEFAULT_PATH));
}

export function readState(path: string = defaultStatePath()): ConnectorState {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<ConnectorState>;
    return {
      registrationToken: typeof parsed.registrationToken === "string" ? parsed.registrationToken : undefined,
    };
  } catch (error) {
    // A corrupt state file is recoverable — treat as missing and let the
    // first-connect path mint a fresh token. Logging is the caller's job.
    throw new Error(`failed to read connector state at ${path}: ${(error as Error).message}`);
  }
}

export function writeState(state: ConnectorState, path: string = defaultStatePath()): void {
  // Empty path is the db-mode signal: `bootFromDb` passes `statePath: ""`
  // to the frame-router because the registrationToken lives in Postgres
  // (via `store.updateRegistrationToken`) instead of on disk. Without this
  // guard, the default register-ack handler would call `renameSync('.tmp', '')`
  // and throw ENOENT on every successful register-ack under db mode. The
  // caller has its own persistence — nothing to write here.
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  // Write to a sibling tmp file then rename, so a crash mid-write can never
  // leave a half-written .connector-state.json on disk. POSIX rename is
  // atomic — readers see either the old file or the new one.
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

// Clear the persisted registrationToken — used by the connector when the
// controller returns `unknown_registration_token` in register-ack, signalling
// our token no longer maps to a row (typically: controller DB reset, or the
// row was deleted out from under us). Removes the file entirely if no other
// fields remain so the next boot is a clean first-connect.
export function clearRegistrationToken(path: string = defaultStatePath()): void {
  // Same db-mode guard as writeState — db mode calls
  // `store.clearRegistrationToken(row.id)` in bootFromDb's onframe hook;
  // this call from the default frame-router handler is a no-op there.
  if (!path) return;
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // Best-effort: if unlink fails (e.g. permissions), fall back to writing
    // an empty state object so readState() at least returns no token.
    writeState({}, path);
  }
}
