import { createLogger } from "../logger.js";

const log = createLogger("oauth");

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

// OAuth2 client_credentials provider for the WS-handshake bearer.
//
// On each call to accessToken() returns a cached JWT if it has more than
// 60s of life left, otherwise mints a fresh one against tokenUrl. The
// provider is constructed once during boot and reused across reconnects so
// the cached JWT survives WS-level redials — only a controller restart
// long enough to outlive expires_in forces a fresh mint.
//
// Mint failures are thrown — the caller (TunnelClient.connect) lets that
// surface to the boot lifecycle's existing connect-failure path which
// schedules an auto-reconnect with backoff. We never log client_secret or
// the JWT.
export class OAuthClientCredentialsProvider {
  private cached?: { jwt: string; expiresAt: number };
  // C6 (security hardening) — single-flight guard. Concurrent callers near
  // expiry would otherwise each fire their own fetch() to the token
  // endpoint. Store the in-flight mint promise; new callers await it
  // instead of re-minting.
  private mintPromise?: Promise<string>;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly tokenUrl: string,
  ) {}

  async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - 60_000 > now) {
      return this.cached.jwt;
    }
    // Single-flight: if a mint is already in-flight, await it instead of
    // firing a duplicate fetch.
    if (this.mintPromise) return this.mintPromise;
    this.mintPromise = this.mint().finally(() => {
      this.mintPromise = undefined;
    });
    return this.mintPromise;
  }

  private async mint(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    log.info({ tokenUrl: this.tokenUrl, clientId: this.clientId }, `minting access token`);
    const res = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`OAuth token mint failed: ${res.status}`);
    }
    const data = (await res.json()) as TokenResponse;
    // Defensive floor: contract guarantees expires_in is a positive integer
    // seconds ≥ 300. Anything below 60 would cause a tight refresh loop
    // (the cache check uses 60s headroom) — fail loudly instead, so a
    // controller-side regression surfaces as a clear error rather than a
    // log flood.
    if (typeof data.expires_in !== "number" || data.expires_in < 60) {
      throw new Error(
        `OAuth token mint returned invalid expires_in: ${String(data.expires_in)} (expected positive integer seconds ≥ 60)`,
      );
    }
    // C9 (security hardening) — validate access_token is a non-empty string.
    // Without this, a malformed provider response ({expires_in: 3600,
    // access_token: null} or missing entirely) caches `undefined` and the
    // connector sends `Bearer undefined` on next handshake.
    if (typeof data.access_token !== "string" || !data.access_token) {
      throw new Error(
        `OAuth token mint returned invalid access_token: ${String(data.access_token)} (expected non-empty string)`,
      );
    }
    this.cached = {
      jwt: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    log.info({ expiresIn: data.expires_in }, `access token minted`);
    return data.access_token;
  }
}
