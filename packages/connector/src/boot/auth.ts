// Resolve the connector's tunnel auth posture from env vars. Two postures
// are supported and they're mutually exclusive — the operator picks one
// per controller-side row:
//   * OAuth2 client_credentials: OAUTH_CLIENT_ID + OAUTH_CLIENT_SECRET +
//     OAUTH_TOKEN_URL → an OAuthClientCredentialsProvider that mints +
//     caches a JWT for every WS handshake.
//   * Static bearer: a long-lived ts_<rowId>_<random> the controller minted
//     for a Twilio-AuthToken / API-Key row. Lives in TUNNEL_AUTH_TOKEN.
//
// Dispatch is purely on OAUTH_CLIENT_ID presence — the static-bearer path is
// the fallback. Boot fails fast if neither is configured (the failure mode
// is intentional: a silently-unauthenticated connector is exactly the bug
// the check prevents). See CLAUDE.md "WS-handshake auth is per-tunnel".
//
// Pure function over the env map so this is trivially exercisable.

import { OAuthClientCredentialsProvider } from "../auth/oauth-provider.js";
import type { ControllerRow } from "../config-store/index.js";

export interface AuthResolution {
  authToken: string | undefined;
  authProvider: OAuthClientCredentialsProvider | undefined;
  // Operator-facing string for the boot log, e.g. "set (len=84)" or
  // "oauth2 (clientId=ts_abc...)". Stamped into the inspector header too.
  status: string;
}

export function resolveAuthFromEnv(
  configAuthToken: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AuthResolution {
  const oauthClientId = env.OAUTH_CLIENT_ID;
  if (oauthClientId) {
    const provider = new OAuthClientCredentialsProvider(
      oauthClientId,
      requireOauthEnv("OAUTH_CLIENT_SECRET", env.OAUTH_CLIENT_SECRET),
      requireOauthEnv("OAUTH_TOKEN_URL", env.OAUTH_TOKEN_URL),
    );
    return {
      authToken: undefined,
      authProvider: provider,
      status: `oauth2 (clientId=${oauthClientId})`,
    };
  }
  if (configAuthToken) {
    return {
      authToken: configAuthToken,
      authProvider: undefined,
      status: `set (len=${configAuthToken.length})`,
    };
  }
  throw new Error(
    "tunnel auth missing. Set TUNNEL_AUTH_TOKEN (static bearer) or OAUTH_CLIENT_ID + OAUTH_CLIENT_SECRET + OAUTH_TOKEN_URL (OAuth2). See packages/connector/.env.example.",
  );
}

function requireOauthEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} is required when OAUTH_CLIENT_ID is set. See packages/connector/.env.example for the OAuth2 posture.`,
    );
  }
  return value;
}

export function resolveAuthFromRow(row: ControllerRow): AuthResolution {
  if (row.authMode === "oauth2-cc") {
    if (!row.oauthClientId) {
      throw new Error(`oauthClientId is required for row "${row.name}" when authMode is oauth2-cc`);
    }
    if (!row.oauthClientSecret) {
      throw new Error(`oauthClientSecret is required for row "${row.name}" when authMode is oauth2-cc`);
    }
    if (!row.oauthTokenUrl) {
      throw new Error(`oauthTokenUrl is required for row "${row.name}" when authMode is oauth2-cc`);
    }
    const provider = new OAuthClientCredentialsProvider(
      row.oauthClientId,
      row.oauthClientSecret,
      row.oauthTokenUrl,
    );
    return {
      authToken: undefined,
      authProvider: provider,
      status: `oauth2 (clientId=${row.oauthClientId})`,
    };
  }
  // static-bearer mode
  if (!row.tunnelAuthToken) {
    throw new Error(`tunnelAuthToken is required for row "${row.name}" when authMode is static-bearer`);
  }
  return {
    authToken: row.tunnelAuthToken,
    authProvider: undefined,
    status: `set (len=${row.tunnelAuthToken.length})`,
  };
}
