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
// provider is constructed once in main() and reused across reconnects so
// the cached JWT survives WS-level redials — only a controller restart
// long enough to outlive expires_in forces a fresh mint.
//
// Mint failures are thrown — the caller (TunnelClient.connect) lets that
// surface to index.ts's existing connect-failure path which schedules an
// auto-reconnect with backoff. We never log client_secret or the JWT.
export class OAuthClientCredentialsProvider {
  private cached?: { jwt: string; expiresAt: number };

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
    this.cached = {
      jwt: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    log.info({ expiresIn: data.expires_in }, `access token minted`);
    return data.access_token;
  }
}
