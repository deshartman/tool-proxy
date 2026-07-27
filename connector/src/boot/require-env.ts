// Boot-time env preflight. Called from boot/lifecycle.ts before yaml load
// or auth resolution. Consolidates every required-env check into a single
// failure that an admin can fix in one .env edit pass instead of
// boot-fail-fix-reboot-repeat across three different scattered errors.
//
// Two modes, controlled by CONNECTOR_CREDS_SOURCE (default: "db"):
//   * "env" — legacy mode: tunnel creds from CONTROLLER_URL, CONNECTOR_NAME,
//            and auth posture (TUNNEL_AUTH_TOKEN or OAUTH_*), read from env.
//   * "db"  — default mode: tunnel creds live in Postgres; only requires
//             POSTGRES_URL and CONNECTOR_KEY_FILE at boot.
//
// CONNECTOR_CONFIG defaults to `./connector.yaml` (resolved from CWD). Same
// with `.env`: `import "dotenv/config"` at the entrypoint reads from CWD. So a
// customer running `npx mcp-connector start` from their project directory
// picks up `.env` + `connector.yaml` next to their `package.json` with no
// flags. Override CONNECTOR_CONFIG only when the yaml lives elsewhere.
//
// The auth posture check (env mode only) is the interesting one. We surface it
// as an "incomplete posture" rather than three separate "X is required" lines so
// the admin sees the *intent* of their config: "you set OAUTH_CLIENT_ID so
// you're going for OAuth2; here's what else you need" beats "OAUTH_CLIENT_ID,
// OAUTH_CLIENT_SECRET, OAUTH_TOKEN_URL all missing" which obscures the
// posture.
//
// Empty-string semantics match the rest of the connector (env.ts): "" == not
// set. An admin's blank-line .env override falls back to "missing" here.

import { envOptional } from "../env.js";
import { resolveCredsSource } from "./creds-source.js";

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

  const credsSource = resolveCredsSource(env);
  const findings: MissingEnvFinding[] = [];

  if (credsSource === "env") {
    // Legacy env-mode: requires per-controller vars.
    // YAML interpolation inputs. Required because connector.yaml.example uses
    // ${CONTROLLER_URL} and ${CONNECTOR_NAME} with no defaults — the
    // interpolator would throw a less actionable error than a single
    // consolidated preflight.
    const controllerUrl = envOptional("CONTROLLER_URL", env);
    if (!controllerUrl) {
      findings.push({
        message: "  CONTROLLER_URL is required (HTTPS root of the controller, e.g. https://controller.example.com). Set in .env.",
      });
    } else if (!isHttpsControllerUrl(controllerUrl)) {
      // C5 (security hardening) — refuse plaintext. client.ts upgrades
      // http:// → ws:// silently, sending the tunnel bearer unencrypted.
      // Reject at boot so an operator's typo doesn't leak creds on the
      // wire before anyone notices.
      findings.push({
        message: `  CONTROLLER_URL must use https:// (got: ${controllerUrl}). Plaintext http:// would send the tunnel bearer over an unencrypted socket.`,
      });
    }
    if (!envOptional("CONNECTOR_NAME", env)) {
      findings.push({
        message: "  CONNECTOR_NAME is required (must match the controller-side Tunnel Security row name, case-sensitive). Set in .env.",
      });
    }

    // Auth posture. Exactly one of:
    //   - TUNNEL_AUTH_TOKEN
    //   - OAUTH_CLIENT_ID + OAUTH_CLIENT_SECRET + OAUTH_TOKEN_URL
    // OAUTH_CLIENT_ID presence is the trigger — if it's set, the other two
    // OAuth2 vars become required. If neither posture starts (no
    // OAUTH_CLIENT_ID and no TUNNEL_AUTH_TOKEN), report both options.
    const oauthClientId = envOptional("OAUTH_CLIENT_ID", env);
    const oauthClientSecret = envOptional("OAUTH_CLIENT_SECRET", env);
    const oauthTokenUrl = envOptional("OAUTH_TOKEN_URL", env);
    const tunnelAuthToken = envOptional("TUNNEL_AUTH_TOKEN", env);

    if (oauthClientId) {
      // Operator chose OAuth2 — finish the posture.
      const missingOauth: string[] = [];
      if (!oauthClientSecret) missingOauth.push("OAUTH_CLIENT_SECRET");
      if (!oauthTokenUrl) missingOauth.push("OAUTH_TOKEN_URL");
      if (missingOauth.length > 0) {
        findings.push({
          message: `  Auth posture incomplete: OAUTH_CLIENT_ID is set, so ${missingOauth.join(" and ")} ${missingOauth.length === 1 ? "is" : "are"} also required. See .env.example for the OAuth2 posture.`,
        });
      }
    } else if (!tunnelAuthToken) {
      // Neither posture started — report both options so the admin can pick.
      findings.push({
        message: "  Auth posture missing: set either TUNNEL_AUTH_TOKEN (static-bearer posture) OR OAUTH_CLIENT_ID + OAUTH_CLIENT_SECRET + OAUTH_TOKEN_URL (OAuth2 posture). See .env.example.",
      });
    }
  } else {
    // credsSource === "db": requires DB + key file only.
    if (!envOptional("POSTGRES_URL", env)) {
      findings.push({
        message: "  POSTGRES_URL is required (e.g. postgres://user:pass@host:5432/mcp). Set in .env or container env.",
      });
    }
    if (!envOptional("CONNECTOR_KEY_FILE", env)) {
      findings.push({
        message: "  CONNECTOR_KEY_FILE is required (path to a 32-byte master key file, mode 0600). Set in .env or container env.",
      });
    }
  }

  if (findings.length === 0) return;

  const lines = [
    "Connector boot failed: env config incomplete",
    "",
    ...findings.map((finding) => finding.message),
    "",
    "See .env.example (bundled with the package) for the full template, or run 'mcp-connector init' to scaffold a fresh .env in the current directory.",
  ];
  throw new Error(lines.join("\n"));
}
