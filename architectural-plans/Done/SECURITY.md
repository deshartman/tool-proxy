# SECURITY — Connector ↔ Controller Auth Hardening

> **Status:** **Shipped (options 1, 2, and 4).** Controller-side: `tunnel_security_configs` table covers all three credential types (Twilio Auth Token, Twilio API Key, OAuth 2.0 client_credentials). Connector-side: posture dispatched purely by env. Static-bearer path: paste `ts_<rowId>_<random>` into `TUNNEL_AUTH_TOKEN`. OAuth path: [packages/connector/src/auth/oauth-provider.ts](../../packages/connector/src/auth/oauth-provider.ts) POSTs to `OAUTH_TOKEN_URL` for a 1h JWT, refreshed <60s before expiry; constructed once in `main()` and threaded into every `TunnelClient` so the cached JWT survives auto-reconnect. Header build at [packages/connector/src/tunnel/client.ts:65-71](../../packages/connector/src/tunnel/client.ts#L65-L71) prefers the provider over the static token. Option 3 (mTLS) remains deferred per the comparison-matrix verdict. The exploration text below is preserved for context.

## Why this exists

Today the connector authenticates to our private controller with a single shared bearer token (`TUNNEL_AUTH_TOKEN`) on the WS upgrade. Fine for a demo; not viable for production where security teams want proof the connector points only at the right destination *and* belongs to the customer it claims to.

The controller is intended to be folded into Twilio later. Design goal: **harden auth now in a way that maximises controller-side work and minimises connector-side work**. The controller has a UI, holds state, and can verify against Twilio APIs. The connector should ideally remain a paste-and-go process whose `.env` carries one secret and nothing else.

This document evaluates four candidate options and recommends a path. Each option is split into a **Controller-side spec** (the brief for the controller-side developer) and a **Connector-side spec** (what changes in this repo).

---

## Today's auth surface (grounded)

Verified in code on both repos as of this writing:

- **Connector → controller WS dial.** [packages/connector/src/tunnel/client.ts:65](../../packages/connector/src/tunnel/client.ts#L65) sets `Authorization: Bearer ${TUNNEL_AUTH_TOKEN}`. Single auth touchpoint on the connector side.
- **Controller WS validation.** `server/src/mcp/terminator.ts:108-133` regex-matches `^Bearer\s+(.+)$`, string-equality compares against `TUNNEL_AUTH_TOKEN` env, 401 on mismatch.
- **Controller REST validation.** `server/src/middleware/requireAuthToken.ts:13-34` — same shape; applied to `POST /api/connectors`.
- **Controller TLS.** `http.createServer(app)` — plain HTTP. TLS terminates upstream (ngrok / cloud LB). **No native HTTPS today.**
- **Controller crypto deps.** `node:crypto` only. Twilio SDK v6.0.2 is already a dep.
- **Connectors table.** `server/src/db/schema-pg.ts:78-93` — `id`, `tenantId`, `name`, `environment`, `region`, `registrationToken`. No `account_sid` / `api_key_id` / `client_id` columns.
- **Connector fail-fast.** Connector refuses to boot without `TUNNEL_AUTH_TOKEN` ([packages/connector/src/index.ts:94-104](../../packages/connector/src/index.ts#L94-L104)). Symmetric with `${CONNECTOR_NAME}` interpolation, which throws at YAML load if unset.

## Structural insight

Options 1 and 2 are **identical from the connector's perspective**: the controller produces an opaque shared secret derived from real Twilio credentials; the customer pastes it into `TUNNEL_AUTH_TOKEN` exactly like today. **Zero connector code change.** The differences (which Twilio credential the controller verifies, what columns the controller stores, rotation UX) all live on the controller side.

Option 4 (OAuth2) is structurally different on the connector: the connector mints a fresh access token from a token endpoint on every reconnect. New connector code path, new yaml block, new state.

Option 3 (mTLS) splits cleanly: controller-side dev handles enrollment UX + signing; connector consumes cert/key as files and feeds them to the WS client.

---

## Option 1 — AccountSid + AuthToken → derived shared secret

The customer pastes their Twilio AccountSid + AuthToken into a controller UI form. The controller verifies the credentials against Twilio's API, then generates a random opaque secret (`tunnel_secret`), stores its hash + the AccountSid in the `connectors` row, and returns the plaintext secret **once** to the UI. The customer copies that secret into the connector's `TUNNEL_AUTH_TOKEN` env var. The wire shape stays exactly as today — `Authorization: Bearer <tunnel_secret>` — but the controller now compares against a per-connector hashed value instead of a single shared env var.

### Wire shape

`Authorization: Bearer <tunnel_secret>` on the WS upgrade. Identical to today.

### What sits on the wire

A long-lived random 256-bit secret (recommend `ts_` + 32 random bytes hex). The customer's AuthToken **never** touches the wire after the initial exchange.

### Verifiability

The controller proves the customer holds a valid AccountSid+AuthToken pair *at exchange time* via `new Twilio(accountSid, authToken).api.v2010.accounts(accountSid).fetch()`. After that, every subsequent connect proves only that the presenter holds the `tunnel_secret`. That's the same trust level as today's bearer; the upgrade is **provenance** (we know which Twilio account the connector belongs to) and **revocability** (UI can rotate without redeploying the controller).

### Reverse-engineering / leak surface

- **Captured WS upgrade request:** reveals the `tunnel_secret`. Same exposure as today; a bcrypt'd-on-controller storage shape doesn't change that.
- **Compromised connector container:** attacker reads `.env`, gets `tunnel_secret`. They cannot derive the customer's AuthToken from it (no inverse).
- **Compromised controller DB:** attacker gets bcrypt hashes; brute-force-resistant. AuthToken is *not* stored — only used at exchange time.

### Controller-side spec

**UI surface — new "Connectors → Create" screen (or extend the existing one):**
- Fields: `Connector name`, `Account SID`, `Auth Token`, optional `Environment` (dev/staging/prod), optional `Region`.
- Submit button: "Verify & generate shared secret".
- On success: show the generated `tunnel_secret` once in a copy-to-clipboard box, with a clear "this is shown only once" warning. Offer a "Rotate secret" button on the connector detail page later.

**API surface — new endpoint:**
```
POST /api/connectors/exchange
Authorization: <existing operator/admin auth>
Content-Type: application/json
Body: { name, accountSid, authToken, environment?, region? }
```
- Verify: `new Twilio(accountSid, authToken).api.v2010.accounts(accountSid).fetch()`. Map SDK errors:
  - HTTP 401 from Twilio → return `401 {code: "invalid_credentials"}`.
  - Network/timeout → return `503 {code: "twilio_unreachable"}`. Operator retry.
  - Other → return `502 {code: "twilio_error", detail}`.
- On success: generate `tunnel_secret = "ts_" + crypto.randomBytes(32).toString("hex")`. Compute `tunnel_secret_hash = bcrypt.hash(tunnel_secret, 12)`. Insert/update connectors row with `account_sid`, `tunnel_secret_hash`, `name`, etc. Return `{tunnel_secret, connector_id, account_sid_last4}` — full secret in plaintext, **once**.
- Idempotency: name collision returns 409 with explicit "rotate via the connector detail page" guidance. The exchange endpoint always *creates*; rotation is a separate endpoint.

**Rotation endpoint:**
```
POST /api/connectors/:id/rotate-secret
```
Mints a new `tunnel_secret`, moves current hash to `tunnel_secret_hash_prev`, sets `secret_rotation_grace_until = now + 24h`. Verification accepts either hash within the grace window. Mirrors Twilio's documented 24h grace ([Twilio FAQ](https://www.twilio.com/docs/iam/oauth-apps/faqs)).

**Verification path changes:**
- WS upgrade in `server/src/mcp/terminator.ts:108-133`: parse the bearer, then look up the row. **Two lookup options to evaluate:**
  - **(a) Connector includes `account_sid` in the register frame body**, controller looks up by it. Requires a tiny connector change to forward the value (one-line addition in `tunnel/frames.ts` + populate from yaml). Cleaner.
  - **(b) Try-each-hash:** if the connector still presents only the bearer, the controller can't index. Doesn't scale beyond a handful of connectors. Don't do this.
  - **(c) Connector name in a header**, e.g. `X-Connector-Name`. Connector already knows its name. No connector code change needed beyond adding the header.
  - **Recommend (c)** for option 1 because it preserves "zero connector code change" goal. Add `X-Connector-Name: <CONNECTOR_NAME>` to the WS upgrade headers; controller looks up the row by name + tenant.
- After lookup: `bcrypt.compare(presented, row.tunnel_secret_hash)` (and `tunnel_secret_hash_prev` if within grace). 401 on miss.
- REST middleware `server/src/middleware/requireAuthToken.ts`: same shape — find the row, bcrypt-compare. The existing single-env-token path stays as a fallback for one release behind a `LEGACY_BEARER_ENABLED` flag, then is removed.

**DB additions:** add columns to `connectors`:
```sql
ALTER TABLE connectors
  ADD COLUMN account_sid TEXT,
  ADD COLUMN tunnel_secret_hash TEXT,
  ADD COLUMN tunnel_secret_hash_prev TEXT,
  ADD COLUMN secret_rotated_at TIMESTAMPTZ,
  ADD COLUMN secret_rotation_grace_until TIMESTAMPTZ;
CREATE INDEX idx_connectors_account_sid ON connectors(account_sid);
CREATE UNIQUE INDEX idx_connectors_tenant_name ON connectors(tenant_id, name);
```

**New deps:** `bcrypt` (or `argon2`). Twilio SDK already present.

**Failure UI:** plain banner text on the form for each failure mode — "Twilio rejected those credentials", "Twilio API unreachable, please retry", "A connector with this name already exists in this tenant". Twilio API outage means new-connector enrollment is blocked until it returns; existing connectors are unaffected because they reconnect with the cached `tunnel_secret`.

### Connector-side spec

**Code changes:** **None** (subject to the lookup-key decision above — recommendation (c) adds one header to the WS upgrade in [packages/connector/src/tunnel/client.ts:64-65](../../packages/connector/src/tunnel/client.ts#L64-L65), roughly:
```typescript
if (this.authToken) headers["authorization"] = `Bearer ${this.authToken}`;
if (this.connectorName) headers["x-connector-name"] = this.connectorName;
```
plus threading `connectorName` through the constructor. ~5 lines.

**`.env` change:** none in shape — `TUNNEL_AUTH_TOKEN=ts_<...>` instead of `TUNNEL_AUTH_TOKEN=<plain string>`. Same key, different value.

**Yaml change:** none.

**Deps:** none.

**Fail-fast behaviour:** unchanged — connector still refuses to boot without `TUNNEL_AUTH_TOKEN` set.

### Customer setup flow

1. Customer logs into the controller UI, clicks "Create connector".
2. Pastes `Connector name = my-customer-prod`, `Account SID = ACxxx`, `Auth Token = <token>`. Clicks Verify & generate.
3. Controller calls Twilio, succeeds. UI shows `ts_abc...xyz` with copy button + "shown once" warning.
4. Customer copies the secret into `packages/connector/.env`:
   ```
   CONNECTOR_NAME=my-customer-prod
   TUNNEL_AUTH_TOKEN=ts_abc...xyz
   CONTROLLER_URL=https://controller.example.com
   ```
5. Customer runs `./scripts/start-connector.sh`. WS upgrade succeeds; controller looks up row by `X-Connector-Name`, bcrypt-compares the bearer.

### Twilio-as-issuer migration cost

When Twilio takes over: the exchange endpoint is retired or proxied to a Twilio equivalent; verification path changes inside the controller. Connector-side: zero changes (still pastes the same shape of secret).

### Verdict

**Shipped.** Lowest connector-side risk, all the work lands in the controller, and verification against Twilio gives the resulting secret real provenance. Connector-side delta was 5 lines for the `X-Connector-Name` header.

---

## Option 2 — AccountSid + ApiKey/Secret → derived shared secret

**Identical to option 1 from the connector's perspective.** The differences are entirely on the controller side: which Twilio credential is verified at exchange time and what's stored in DB for operator visibility.

### Wire shape, what's on the wire, leak surface

Same as option 1. The output of the exchange is the same `tunnel_secret`.

### Verifiability

Verification call is `new Twilio(apiKeySid, apiKeySecret, {accountSid}).api.v2010.accounts(accountSid).fetch()`. Same proof shape — the customer holds a valid Twilio credential — but the credential is revocable from the Twilio Console without rotating the master AuthToken, and is scopable.

### Controller-side spec — diffs from option 1

**UI surface:** same screen, two extra fields. Either:
- A toggle "Use Auth Token / Use API Key" that swaps the form fields between `Auth Token` and `API Key SID + API Key Secret`, OR
- A single form with both Auth Token and API Key fields, exactly one of which is required. UX call for the controller dev — recommendation is the toggle for clarity.

**API surface:**
- `POST /api/connectors/exchange` accepts an additional pair of fields. Body becomes `{name, accountSid, authToken?, apiKeySid?, apiKeySecret?, ...}`. Validate exactly one credential pair is present.
- Verification call uses whichever pair was provided.
- On success: same `tunnel_secret` flow. Additionally store `api_key_sid` (the SID, NOT the secret) in the connectors row when API key was used. This is operator-visible — it tells them which API key authorized this connector, which matters when rotating Twilio API keys.

**DB additions — diff from option 1:**
```sql
ALTER TABLE connectors ADD COLUMN api_key_sid TEXT;
```
Just the SID — the secret is never stored.

**Customer-facing setup doc:** points at Twilio Console → Account → API keys & tokens → Create API key.

### Connector-side spec

**Identical to option 1: zero changes** (modulo the shared `X-Connector-Name` header recommendation).

### Why both 1 and 2?

The two flows produce the same artifact. AuthToken is the master credential — simpler for the customer to find but rotating it breaks every Twilio integration they have. ApiKey/Secret is revocable/scoped — better hygiene for security-conscious customers. The controller offers both forms; the customer picks the one their security posture dictates. The connector doesn't care which one was used.

### Verdict

**Shipped alongside option 1.** Same connector-side change (none). The controller's Tunnel Security UI exposes both Twilio Auth Token and Twilio API Key as security types in the same flow.

---

## Option 3 — mTLS

The connector presents a TLS client certificate during the WS handshake. The controller validates the cert against a known CA + thumbprint. There is no app-level shared secret on the wire; identity is proven cryptographically by the handshake itself.

The user's question: how much of this can live in the controller UI?

### Wire shape

TLS handshake exchanges client certificate. After handshake, the WS upgrade carries no `Authorization` header (or a vestigial one for tenant routing). Controller maps the cert thumbprint to a connector row.

### What sits on the wire

The TLS handshake. No long-lived bearer in app-layer headers. Per-session keys are ephemeral.

### Verifiability

The controller proves the connector holds the *private key* for a cert it has either signed or pinned. Strongest of the four options on the wire.

### Reverse-engineering / leak surface

- **Captured WS handshake:** reveals the client cert (public), nothing else useful.
- **Compromised connector container:** attacker reads the private key from disk. Same exposure shape as today's `TUNNEL_AUTH_TOKEN`.
- **Compromised controller:** attacker gets thumbprints; can't impersonate without private keys.

### Controller-side spec — two enrollment paths to evaluate

**Path A — controller is the CA (recommended for the UI-driven shape).**
- UI: "Create connector" → "Generate client certificate" button. Controller's issuer key signs a fresh client cert (CN = connector_id, SAN = connector name, validity ~90 days). UI returns `client.crt` + `client.key` as a downloadable zip or two copy-paste text blobs.
- Controller stores cert thumbprint + connector_id + expiry in the connectors row.
- Renewal: scheduled job warns 14 days before expiry; UI offers a "Renew" button that issues a new cert. Customer drops the new files into the connector's volume and restarts.
- Pro: all enrollment in the UI; customer downloads two files and pastes paths into yaml. No customer-side PKI required.
- Con: controller becomes a CA. Need an issuer key, a revocation story (CRL or short-lived certs), key-rotation runbook.

**Path B — customer brings their own cert.**
- UI: "Add connector" → upload CSR or pre-signed cert + thumbprint. Controller stores thumbprint.
- Pro: fits enterprises with existing PKI.
- Con: terrible UX for SMB customers. Probably not the primary path.

**Either path requires:** the controller's `http.createServer` becomes `https.createServer({requestCert: true, rejectUnauthorized: true, ca, cert, key})`, OR the cloud LB / ngrok terminates mTLS upstream and forwards the verified-client-cert (e.g. as `X-Client-Cert-Thumbprint`). Today's controller serves plain HTTP — moving to native HTTPS is a deployment shape change (cert provisioning for the controller itself, port changes, ngrok config update).

**This is the structural blocker.** Option 3 cannot ship without resolving where TLS terminates and how mTLS pass-through works in the production deployment shape.

**DB additions:**
```sql
ALTER TABLE connectors
  ADD COLUMN client_cert_thumbprint TEXT,
  ADD COLUMN client_cert_expires_at TIMESTAMPTZ,
  ADD COLUMN client_cert_revoked_at TIMESTAMPTZ;
CREATE INDEX idx_connectors_thumbprint ON connectors(client_cert_thumbprint);
```

**New controller deps (path A):** `node-forge` or similar for CA operations. Or shell out to `openssl`. Either way it's net-new infrastructure on the controller side.

### Connector-side spec

**Yaml change:** new optional block under `tunnel`:
```yaml
tunnel:
  controller_url: ${CONTROLLER_URL}
  name: ${CONNECTOR_NAME}
  tls:
    client_cert_file: /etc/mcp-connector/client.crt
    client_key_file: /etc/mcp-connector/client.key
    ca_file: /etc/mcp-connector/ca.crt   # optional
```

**Code change:** [packages/connector/src/tunnel/client.ts:67-69](../../packages/connector/src/tunnel/client.ts#L67-L69) wires `cert` / `key` / `ca` into the `WebSocket` constructor's options (passed through to `https.Agent`). About 30 lines including the yaml schema additions in `config.ts`.

**Deps:** none. `ws` + `node:tls` already in tree.

**Customer setup:** customer downloads two PEM files from the controller UI, mounts them into the container at the configured paths, points yaml at them. `TUNNEL_AUTH_TOKEN` becomes optional (or stays as a belt-and-braces second factor — TLS proves identity, the bearer can authenticate the *operator* who enrolled this connector).

### Customer setup flow

1. Customer logs into controller UI, clicks "Create connector".
2. Picks "mTLS" auth mode, clicks "Generate certificate".
3. UI returns `client.crt` + `client.key`. Customer downloads.
4. Customer mounts files into container, updates yaml `tls:` block, restarts connector.
5. WS handshake presents cert; controller validates thumbprint.

### Twilio-as-issuer migration cost

Orthogonal. Twilio's OAuth Apps don't use mTLS. If we ship mTLS as an alternative auth mode and Twilio takes over, mTLS would either be retired or kept as a Twilio-independent "enterprise mode". This is the only option whose migration story isn't "config flip".

### Verdict

**Defer.** Strongest wire-level security, but: (a) deployment shape change (native HTTPS or LB pass-through), (b) controller becomes a CA, (c) cert lifecycle ops the connector image doesn't have today, (d) doesn't fit the Twilio-migration story. Belt-and-braces for security-paranoid enterprise customers; revisit after options 1+2 ship and we have real customer pull for it.

---

## Option 4 — OAuth2 (client_credentials)

Customer pastes `client_id` + `client_secret` into the connector's `.env`. Connector POSTs them to a token endpoint, gets back a short-lived JWT, presents the JWT on the WS upgrade. Token endpoint is on the controller today; flips to `https://oauth.twilio.com/v2/token` post-Twilio-migration with no connector code change.

This is what the prior version of this doc picked. Re-evaluating with the controller-vs-connector lens.

### Wire shape

`Authorization: Bearer <jwt>` on WS upgrade. Different from today's static bearer in that the value is a 1-hour JWT minted by the token endpoint, not a long-lived secret.

### What sits on the wire

A short-lived (1h) signed JWT on each WS connect. The `client_secret` only touches the wire when the connector mints a new token (every ~55 minutes).

### Verifiability

Controller proves the presenter holds a valid JWT signed by the issuer. JWT carries `account_sid`, so the same identity-binding as options 1+2. Stronger wire-level posture due to short-lived tokens; weaker provenance unless the controller verifies the customer's Twilio AccountSid at OAuth-client creation time (which it should).

### Reverse-engineering / leak surface

- **Captured WS upgrade:** reveals a JWT with ≤1h validity. Useful for that hour, expires after.
- **Compromised connector container:** attacker reads `client_id` + `client_secret` from `.env`. Can mint fresh JWTs until secret is rotated. Same exposure window as option 1's `tunnel_secret` until rotated.
- **Compromised controller signing key:** attacker can forge JWTs for any `account_sid`. Mitigation: signing key in a separate config var; rotate on incident.

### Controller-side spec

**UI surface — new "Connectors → OAuth Clients" screen:**
- "Create OAuth client" form. Fields: `Connector name`, `Account SID`, `Auth Token` (or API key — whichever the customer prefers, mirroring options 1+2's verification step).
- On submit: controller verifies Twilio creds (same call as option 1), then mints `client_id` + `client_secret`, returns both to UI. `client_secret` shown once.
- Per-client "Rotate secret" button — same 24h overlap as Twilio's documented behaviour.

**API surface:**
- `POST /oauth2/token` — accepts `application/x-www-form-urlencoded` with `client_id`, `client_secret`, `grant_type=client_credentials`. No operator auth (this is a public OAuth endpoint). Verifies secret hash, mints HMAC-SHA256 JWT with claims `{iss, sub: client_id, aud: "mcp-tunnel", account_sid, exp, iat, jti}`. Returns Twilio-shape body byte-for-byte:
  ```json
  {
    "access_token": "<jwt>",
    "id_token": null,
    "token_type": "Bearer",
    "expires_in": 3600,
    "refresh_token": null
  }
  ```
- `POST /api/oauth-clients` — operator-auth, creates a new OAuth client (verifies Twilio creds, mints id+secret).
- `POST /api/oauth-clients/:id/rotate` — operator-auth, rotates secret with 24h grace.

**Verification path changes:**
- WS upgrade and REST middleware: parse the bearer as a JWT, verify HMAC signature with `OAUTH_SIGNING_KEY`, check `exp` and `aud`. Look up `oauth_clients` row by `sub` (client_id) to get `account_sid` for downstream authz. 401 on signature/expiry failure.

**DB additions — new table:**
```sql
CREATE TABLE oauth_clients (
  client_id            TEXT PRIMARY KEY,
  account_sid          TEXT NOT NULL,
  client_secret_hash   TEXT NOT NULL,
  client_secret_hash_prev TEXT,
  rotation_grace_until TIMESTAMPTZ,
  name                 TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL,
  rotated_at           TIMESTAMPTZ,
  disabled_at          TIMESTAMPTZ
);
CREATE INDEX idx_oauth_clients_account_sid ON oauth_clients(account_sid);
```

**New deps:** `bcrypt` for secret hashing. HMAC via `node:crypto` (no JWT lib needed; can roll the JWT manually in ~20 lines). Adding `jose` is optional — buys nicer ergonomics for ~30KB.

**New env:** `OAUTH_SIGNING_KEY` (32+ random bytes hex/base64). Required when OAuth mode is enabled.

### Connector-side spec

**New code module — `packages/connector/src/auth/oauth-provider.ts`** (~80 lines):
- `OAuthClientCredentialsProvider` class.
- Constructor: `client_id`, `client_secret`, `token_url`.
- Single method: `async headers(): Promise<Record<string,string>>` returning `{authorization: "Bearer <access_token>"}`.
- Internally: caches access_token + expiry, refreshes when <60s remain, POSTs to `token_url` via Node 18 `fetch`.

**Yaml change:** new `tunnel.auth` block:
```yaml
tunnel:
  controller_url: ${CONTROLLER_URL}
  name: ${CONNECTOR_NAME}
  auth:
    mode: oauth_client_credentials
    client_id: ${OAUTH_CLIENT_ID}
    client_secret: ${OAUTH_CLIENT_SECRET}
    token_url: ${OAUTH_TOKEN_URL:-${CONTROLLER_URL}/oauth2/token}
```

**Code change:** [packages/connector/src/tunnel/client.ts](../../packages/connector/src/tunnel/client.ts) accepts an `AuthProvider` instead of a static `authToken`. Replace the constant header build at line 64-65 with `Object.assign(headers, await provider.headers())`. [packages/connector/src/index.ts:204-205](../../packages/connector/src/index.ts#L204-L205) builds the right provider from `config.tunnel.auth.mode`. Total: ~150 lines of new connector code.

**Deps:** none. Node 18 `fetch` covers the token POST.

**`.env` change:** new keys `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` / optional `OAUTH_TOKEN_URL`. `TUNNEL_AUTH_TOKEN` becomes irrelevant in this mode.

### Customer setup flow

1. Customer logs into controller UI, clicks "Create OAuth client".
2. Pastes `Connector name`, `Account SID`, `Auth Token`. Submits.
3. UI shows `client_id = ck_...` and `client_secret = cs_...`. Both copy-to-clipboard.
4. Customer pastes both into `.env`:
   ```
   OAUTH_CLIENT_ID=ck_...
   OAUTH_CLIENT_SECRET=cs_...
   ```
5. Customer updates yaml `tunnel.auth.mode: oauth_client_credentials`.
6. Connector boots, mints first JWT against the controller's token endpoint, presents it on WS upgrade.

### Twilio-as-issuer migration cost

Customer creates a Twilio OAuth App (Console → Org settings → Org API access), gets new `client_id` / `client_secret`. Flips `OAUTH_TOKEN_URL` to `https://oauth.twilio.com/v2/token`. **Connector code: zero changes.** Controller's `/oauth2/token` endpoint is retired or kept behind a feature flag during cutover. This is the option whose migration story is genuinely "config flip".

### Verdict

**Shipped (after options 1+2).** Customer-side cost came in well under the original ~150-line estimate — `OAuthClientCredentialsProvider` is ~70 lines including the defensive `expires_in` floor. Posture dispatch is purely env-driven (`OAUTH_CLIENT_ID` set → OAuth path) so the existing `ts_<...>` deployments are untouched. Twilio-takeover migration is now genuinely a `OAUTH_TOKEN_URL` flip with no code change.

---

## Comparison matrix

| Dimension | Option 1 (AuthToken→secret) | Option 2 (ApiKey→secret) | Option 3 (mTLS) | Option 4 (OAuth2) |
|---|---|---|---|---|
| **Connector code change** | None (or 5 lines for X-Connector-Name) | None (same as option 1) | New yaml + ~30 lines | New provider + ~150 lines |
| **Connector deps added** | None | None | None | None |
| **Connector `.env` change** | Same key, different value | Same key, different value | New cert/key file paths | New OAUTH_* keys |
| **Controller UI work** | Create-connector form + verify | Same + ApiKey toggle | Cert generation + download UX | OAuth clients screen + rotation |
| **Controller DB work** | 5 columns on connectors | Same + api_key_sid | Thumbprint columns | New oauth_clients table |
| **Controller deps added** | bcrypt | bcrypt | CA lib (path A) or none | bcrypt (+ optional jose) |
| **Controller TLS change** | None | None | **Native HTTPS required** | None |
| **What's on the wire** | Long-lived 256-bit secret | Long-lived 256-bit secret | Cert handshake; no app secret | 1h JWT |
| **Verified against Twilio?** | Yes (at exchange) | Yes (at exchange) | No | Should be (at OAuth client creation) |
| **Captured-request leak** | Reveals long-lived secret | Same | Reveals nothing useful | Reveals 1h JWT |
| **Twilio migration cost** | Re-exchange via UI | Re-exchange via UI | N/A — orthogonal | Config flip (token_url) |
| **Operational weight** | Low | Low | High (CA, rotation, revocation) | Medium (token mint per reconnect) |

---

## Recommendation

**Shipped: options 1 + 2 + 4.** Each Tunnel Security row on the controller picks one of the three security types (Twilio Auth Token, Twilio API Key, OAuth 2.0 client_credentials). Posture dispatch on the connector side is purely env-driven, mutually exclusive — `OAUTH_CLIENT_ID` set → OAuth path, otherwise the static `TUNNEL_AUTH_TOKEN` path. Boot fails if neither is configured.

**Deferred: option 3 (mTLS).** Strongest wire security, but blocked by deployment shape (controller serves plain HTTP today) and forces operational weight (CA, rotation, revocation) that isn't justified for the typical customer. Belt-and-braces for security-paranoid enterprises; revisit if customer pull materialises.

## Implementation pointer (historical, for context)

Connector-side ships:
- `X-Connector-Name` header on the WS upgrade — [packages/connector/src/tunnel/client.ts:65-71](../../packages/connector/src/tunnel/client.ts#L65-L71)
- `OAuthClientCredentialsProvider` for the OAuth posture — [packages/connector/src/auth/oauth-provider.ts](../../packages/connector/src/auth/oauth-provider.ts)
- env-driven posture dispatch — [packages/connector/src/index.ts](../../packages/connector/src/index.ts)
- `.env.example`, README, deploy guides describe both postures

Controller-side (in `AgenticProcedure/server/`): `tunnel_security_configs` table, Tunnel Security UI under Tools → Connectors, `/api/tunnel-security` CRUD with Twilio-credential verification, `/oauth2/token` endpoint, bcrypt-compare on the WS upgrade.

---

## Out of scope

- **Multi-account support in one connector** — 1:1 only; matches Twilio's per-account OAuth model. MSPs run one container per customer account.
- **Per-tool authorization** — the "trust boundary is per MCP server, not per tool" property in [CLAUDE.md](../../CLAUDE.md) stays as-is.
- **Replacing `registrationToken`** — orthogonal. Access tokens authorize the *connection*; `registrationToken` binds *which controller row* the connector reconnects to.
- **Inspector lockdown / TLS pinning** — separate hardening track; revisit after the primary auth path lands.
