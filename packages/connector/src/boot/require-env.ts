// Boot-time env preflight. Called from boot/lifecycle.ts before yaml load
// or auth resolution. Consolidates every required-env check into a single
// failure that an admin can fix in one .env edit pass instead of
// boot-fail-fix-reboot-repeat across three different scattered errors.
//
// Required env vars at boot:
//   * CONNECTOR_CONFIG     — path to connector.yaml (defaults to ./connector.yaml)
//   * CONTROLLER_URL       — interpolated into yaml; absent → yaml load throws
//   * CONNECTOR_NAME       — interpolated into yaml; absent → yaml load throws
//   * Auth posture (one of):
//       - TUNNEL_AUTH_TOKEN   (static-bearer)
//       - OAUTH_CLIENT_ID + OAUTH_CLIENT_SECRET + OAUTH_TOKEN_URL  (OAuth2)
//
// CONNECTOR_CONFIG defaults to `./connector.yaml` (resolved from CWD). Same
// with `.env`: `import "dotenv/config"` at the entrypoint reads from CWD. So a
// customer running `npx mcp-connector start` from their project directory
// picks up `.env` + `connector.yaml` next to their `package.json` with no
// flags. Override CONNECTOR_CONFIG only when the yaml lives elsewhere.
//
// The auth posture check is the interesting one. We surface it as an
// "incomplete posture" rather than three separate "X is required" lines so
// the admin sees the *intent* of their config: "you set OAUTH_CLIENT_ID so
// you're going for OAuth2; here's what else you need" beats "OAUTH_CLIENT_ID,
// OAUTH_CLIENT_SECRET, OAUTH_TOKEN_URL all missing" which obscures the
// posture.
//
// Empty-string semantics match the rest of the connector (env.ts): "" == not
// set. An admin's blank-line .env override falls back to "missing" here.

import { envOptional } from "../env.js";

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

  // YAML interpolation inputs. Required because connector.yaml.example uses
  // ${CONTROLLER_URL} and ${CONNECTOR_NAME} with no defaults — the
  // interpolator would throw a less actionable error than a single
  // consolidated preflight.
  if (!envOptional("CONTROLLER_URL", env)) {
    findings.push({
      message: "  CONTROLLER_URL is required (HTTPS root of the controller, e.g. https://controller.example.com). Set in .env.",
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
