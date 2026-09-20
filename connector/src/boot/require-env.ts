// Boot-time env preflight. Called from boot/lifecycle.ts before yaml load
// or auth resolution. Consolidates every required-env check into a single
// failure that an admin can fix in one .env edit pass instead of
// boot-fail-fix-reboot-repeat across scattered errors.
//
// Tunnel identity + creds live in the sealed config store — a JSON file on
// the state volume, sealed with libsodium — and are edited via the inspector's
// Configure Tunnel UI. Env-var-based identity ("env mode") was removed by
// ENV-TO-DB; DB-TO-FILE then removed POSTGRES_URL, leaving CONNECTOR_KEY_FILE
// as the single env requirement.
//
// CONNECTOR_CONFIG defaults to `./connector.yaml` (resolved from CWD). Same
// with `.env`: `import "dotenv/config"` at the entrypoint reads from CWD. So a
// customer running `npx mcp-connector start` from their project directory
// picks up `.env` + `connector.yaml` next to their `package.json` with no
// flags. Override CONNECTOR_CONFIG only when the yaml lives elsewhere.
//
// Empty-string semantics match the rest of the connector (env.ts): "" == not
// set. An admin's blank-line .env override falls back to "missing" here.

import { envOptional } from "../env.js";

// C5 (security hardening) — accept only https:// (or wss:// if an operator
// explicitly uses the WS scheme). Loopback (127.0.0.1, ::1, localhost) is
// allowed on any scheme so tests dialling a mock controller in-process
// don't need TLS certs. Anything else — a bare hostname on http:// — is
// rejected because client.ts's silent http→ws upgrade would send the
// tunnel bearer unencrypted.
export function isHttpsControllerUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  try {
    const u = new URL(trimmed);
    const isLoopback =
      u.hostname === "127.0.0.1" ||
      u.hostname === "localhost" ||
      u.hostname === "[::1]" ||
      u.hostname === "::1";
    if (isLoopback) return true;
    return u.protocol === "https:" || u.protocol === "wss:";
  } catch {
    return false;
  }
}

interface MissingEnvFinding {
  /** Multi-line block to render in the consolidated error. */
  message: string;
}

export function requireEnv(env: NodeJS.ProcessEnv = process.env): void {
  // Apply the CONNECTOR_CONFIG default before any downstream code reads it.
  // Mutating process.env here means every subsequent `envOptional("CONNECTOR_CONFIG")`
  // sees the default; skipping this and adding fallback logic at each call
  // site would fan the default across the codebase.
  if (!envOptional("CONNECTOR_CONFIG", env)) {
    env.CONNECTOR_CONFIG = "./connector.yaml";
  }

  const findings: MissingEnvFinding[] = [];

  // The master key file is the ONLY required env var. Tunnel identity
  // (controller URL, connector name) and auth creds live in the sealed config
  // store and are set through the inspector's Configure Tunnel modal. The
  // store itself is a file on the state volume, so there is no DSN to supply
  // — see architectural-plans/DB-TO-FILE.md.
  //
  // One is the floor, not a preference: the process needs the key to open the
  // sealed store BEFORE it can serve the UI that would otherwise supply it.
  if (!envOptional("CONNECTOR_KEY_FILE", env)) {
    findings.push({
      message: "  CONNECTOR_KEY_FILE is required (path to a 32-byte master key file, mode 0600). Set in .env or container env.",
    });
  }

  if (findings.length === 0) return;

  const lines = [
    "Connector boot failed: env config incomplete",
    "",
    ...findings.map((finding) => finding.message),
    "",
    "Point CONNECTOR_KEY_FILE at a 32-byte key file (mode 0600), or set CONNECTOR_KEY_B64 and let the container entrypoint write it.",
    "Everything else — controller URL, connector name, auth posture — is configured in the inspector at http://localhost:9090.",
  ];
  throw new Error(lines.join("\n"));
}
