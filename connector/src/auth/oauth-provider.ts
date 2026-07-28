import { z } from "zod";
import { createLogger } from "../logger.js";

const log = createLogger("oauth");

// Runtime shape check for the token endpoint's JSON body. Enforces:
//   - access_token: non-empty string (else next handshake sends `Bearer undefined`)
//   - token_type: case-insensitive "bearer" — RFC 6749 §5.1 (reject MAC / DPoP / etc.
//     because the connector doesn't know how to present them)
//   - expires_in: integer ≥ 60s (the cache check uses 60s headroom; anything lower
//     would cause a tight refresh loop)
// Failure throws through mint() into the same connect-failure path as an HTTP error.
const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine(
    (v) => v.toLowerCase() === "bearer",
    { message: "expected token_type=bearer" },
  ),
  expires_in: z.number().int().min(60),
});

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
    const parsed = TokenResponse.safeParse(await res.json());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.join(".") || "response";
      throw new Error(
        `OAuth token mint returned invalid ${field}: ${issue?.message ?? "unknown"}`,
      );
    }
    const data = parsed.data;
    this.cached = {
      jwt: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    log.info({ expiresIn: data.expires_in }, `access token minted`);
    return data.access_token;
  }
}
