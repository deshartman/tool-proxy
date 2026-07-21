# TWILIO-HOSTED-MCP — Hosting twilio-mcp as a streamable-http service

> **Status:** investigation only, drafted 2026-06-28. No code changes. This doc captures the architectural shape and the open questions so we can return to it deliberately when the product timing is right. Cross-refs `TWILIO-MCP-BREAKOUT.md` (the stdio-shape work that already shipped) and `STATUS-CALLBACK-MCP.md` (the controller-tunneled webhook design for the customer-hosted path).

## Why this exists

`@deshartman/twilio-mcp` shipped as a stdio MCP — the customer (or our connector) spawns it as a subprocess, creds flow through env at spawn time, all outbound HTTPS to api.twilio.com goes from the customer's machine. That's the "single-tenant, customer-hosted" deployment shape. Works for Claude Desktop, Cursor, and our shim.

There's a separate compelling deployment shape: **Twilio runs twilio-mcp as a service on its own infra, customers just point at it.** Zero customer-side install, zero local cred storage, one place to deploy fixes and feature additions. This doc explores what would need to change.

## Locked-in assumption

This plan assumes the **streamable-http** MCP transport — the SDK's `StreamableHTTPServerTransport`. It's the canonical "MCP as a long-running HTTP service" shape and what the MCP spec recommends for non-local deployments. Stateful per-session-id, persistent HTTPS connection.

SSE is deprecated for new deployments. WebSocket has unresolved auth-model issues (see `TWILIO-MCP-BREAKOUT.md` investigation §"Transport-by-transport landscape"). Streamable-http is the right choice.

## The deployment shape

```
Customer's MCP host  ────HTTPS─────►  Twilio-hosted twilio-mcp service  ────HTTPS────►  api.twilio.com
   (Claude Desktop,         │            (twilio-mcp.twilio.com or
    Cursor, our shim)       │             tenant-specific subdomain)
                            │
                            │
                            ▼
                   tenant routing / cred lookup
                   (the architecturally hard bit)
```

Three pieces:

1. **Customer's MCP host** speaks streamable-http to the Twilio-hosted endpoint. Same MCP protocol they speak today over stdio — only the transport changes.
2. **Twilio-hosted twilio-mcp** is a long-running Node service. Terminates TLS, accepts streamable-http connections, serves the same 25 tools and 12 prompts.
3. **api.twilio.com** is unchanged — twilio-mcp just makes HTTPS calls outbound on the customer's behalf.

## What changes in the standalone repo

Three concrete code changes, all small:

### 1. Transport switch via CLI flag

Today's `src/index.ts` ends with:

```ts
const transport = new StdioServerTransport();
await server.connect(transport);
```

Add a `--transport` flag (or `MCP_TRANSPORT` env). When set to `http`, use `StreamableHTTPServerTransport` and bind to a Node `http` server on a configured port. Default stays stdio so existing Claude Desktop / Cursor configs keep working.

Rough shape:

```ts
if (process.env.MCP_TRANSPORT === "http") {
  const httpServer = http.createServer();
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  httpServer.on("request", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    // ... per-session transport lookup / creation, see shim's createMcpHttpServer
  });
  httpServer.listen(Number(process.env.PORT ?? 3300));
  return; // server.connect happens per-session inside the request handler
}
// otherwise existing stdio path
```

Reference implementation lives in the shim's [`packages/connector/src/sdk/http-server.ts`](../../packages/connector/src/sdk/http-server.ts). ~80 lines, well-trodden path. The breakout decision D1 ruled out depending on the shim's SDK; for the hosted variant we'd inline the same shape.

### 2. Cred-handling shift

This is the architecturally interesting part. Stdio's cred model — `process.env.TWILIO_ACCOUNT_SID` read at boot — doesn't work for a multi-tenant service. The service is long-running; its `process.env` is fixed at deployment time; it serves many tenants.

Three sub-options for the hosted-mode cred path:

**Option A: Single-tenant deployment.** The Twilio-hosted MCP is deployed once per customer (or one customer runs it on their own infra). `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` sit in the deployment's env. Every tool call uses those creds. Works today with zero protocol changes — just stdio's model applied to a long-running process.

Use case: customers who want a hosted MCP but don't want to share infra. Twilio-as-vendor offering single-tenant hosting; or customers self-hosting twilio-mcp on Fly/Render/their own k8s.

**Option B: Per-request creds via headers.** The MCP client passes `X-Twilio-Account-Sid` + `X-Twilio-Auth-Token` (or some bearer / signed-JWT shape) on every streamable-http request. The MCP route handler reads them off the request, builds a per-call Twilio client, makes the API call, releases the client.

Use case: true multi-tenant — one Twilio-hosted MCP serving all customers. Customer authenticates themselves on every request rather than being authenticated by a deployment-level secret.

The MCP spec does not standardise this. We'd be inventing a header shape. Not portable to other MCP hosts unless they all agree on the same header convention. **Considered out of scope unless the spec moves first.**

**Option C: OAuth2 / signed JWT at the session level.** The client opens a streamable-http session with an `Authorization: Bearer` header carrying a Twilio-minted JWT that encodes the AccountSid. The MCP service caches the tenant identity for the lifetime of the session, builds a Twilio client at session-open, reuses it per-call.

Slightly cleaner than B because the auth check happens once per session not per request, and OAuth2 / JWT is at least a standardised auth shape. Still requires the spec or community to agree on "Authorization carries tenant identity," which it doesn't today.

**Recommendation:** start with Option A. It composes with everything; it answers the "I want twilio-mcp running on a server" question without inventing protocol. Option B/C is a follow-up if multi-tenant SaaS becomes a real customer ask. The breakout's stdio shape already covers the "many customers, each runs their own" model, so multi-tenant hosting is purely additive.

### 3. Status-callback handling

Today's standalone uses `@deshartman/mcp-status-callback` (ngrok) to mint a public URL Twilio can POST to. A Twilio-hosted twilio-mcp already has a public HTTPS endpoint — adding a second route is free.

Architectural cleanup:

```
LLM ──MCP──▶ twilio-mcp ──HTTPS──▶ api.twilio.com [statusCallback=https://twilio-mcp/.../callbacks/PKxxx]
                ▲                          │
                │                          │
                └────HTTPS POST ───────────┘
                  (Twilio → Twilio, internal)
```

Both ends of the callback path are inside Twilio's infra. No ngrok, no third-party tunnel, no customer-side public surface.

Implementation: add a route handler `POST /sessions/<sessionId>/callbacks/<paymentSid>` (or some routing scheme that ties callbacks back to an MCP session). When a callback arrives:

- Look up the session-id → outbound MCP transport.
- Emit the event as an MCP `notifications/message` (or a custom server-initiated notification) on that session's stream.
- The LLM driving that session sees the event arrive in real-time.

`getDefaultStatusCallback()` in [twilio-mcp/src/status-callback.ts](https://github.com/deshartman/twilio-mcp/blob/main/src/status-callback.ts) returns ngrok URL today; hosted-mode returns the service's own URL pattern. Tool code unchanged.

Reference: the shim's [`packages/connector/src/sdk/webhook.ts`](../../packages/connector/src/sdk/webhook.ts) + [`STATUS-CALLBACK-MCP.md`](STATUS-CALLBACK-MCP.md) cover the controller-tunneled equivalent. Hosted MCP is structurally simpler because the service IS the public endpoint — no tunnel needed.

## Why this is architecturally cleaner than the ngrok status-callback path

For the hosted deployment shape:

1. **One trust relationship instead of two.** Customer authenticates with Twilio (the hosted MCP). MCP authenticates with Twilio (api.twilio.com). Callback goes Twilio → Twilio. No third-party tunnel provider, no separate auth, no second thing that can go down.
2. **Customer side stays outbound-only.** Same load-bearing property as the shim's design: nothing inbound to customer infra.
3. **Latency is internal.** Twilio → Twilio callback should be milliseconds. Twilio → ngrok.com → customer laptop is round-trip across two providers.
4. **Failure modes are owned.** When ngrok has an outage, every customer running stdio twilio-mcp loses callbacks silently. The hosted variant fails the same incident response that handles api.twilio.com.
5. **Aligns with the multi-tenant story.** If we ever do Option B/C, per-tenant callback routing falls out naturally — each session's session-id is the tenant key.

## What this doesn't solve

- **Local-development case.** Customers building their own MCP or testing things locally still need a way to receive callbacks. Ngrok or our shim's controller-tunneled webhook path remain useful for the customer-hosted shape. Hosted is for the Twilio-as-vendor deployment.
- **Non-Twilio callbacks.** SendGrid event webhooks have the same shape but go to a different service. Each callback-producing vendor needs its own route on a hosted MCP. Not architectural — just a `routes/` directory to maintain.
- **Multi-tenant cred handling.** Option A doesn't solve "one twilio-mcp for many tenants." Option B/C does but requires protocol extension. Park it.

## Open questions to resolve before implementing

1. **Single deployment or per-customer deployment?** Affects the cred model decision (Option A single-tenant deployment, vs Option B/C true multi-tenant). Product decision more than architecture.
2. **Hosting target.** Fly / Render / k8s / Twilio's own infra. Affects TLS termination, session affinity, scaling story. Recommend Fly for the MVP — minimal setup, good session-affinity options.
3. **Domain / DNS.** `twilio-mcp.twilio.com` requires the marketing / DevRel approval cycle. A `mcp.deshartman.com`-style domain works for initial customer testing without that gate.
4. **Status-callback URL minting.** Per-session (clean) vs per-deployment with a routing map (simpler, but reinvents session routing). Recommend per-session — the transport already gives us session-id, use it.
5. **Versioning / backward compat.** Stdio-mode `twilio-mcp` keeps the existing CLI shape; HTTP-mode is added under the same package. One repo, two transports, same tools/prompts. Or split into `@deshartman/twilio-mcp` (stdio) and `@deshartman/twilio-mcp-server` (http). Recommend single repo, transport-mode flag.

## Scope boundaries — what's NOT in this plan

1. **Multi-tenant per-request creds.** Out of scope without an MCP spec change. If a customer asks, we point them at single-tenant hosting (Option A) on their own infra.
2. **Twilio-bundled status-callback for the customer-hosted stdio shape.** Already solved by `@deshartman/mcp-status-callback` (ngrok) and the shim's controller-tunneled webhook path. The hosted path is a third option, not a replacement.
3. **Hosting Segment MCP the same way.** Segment's tools don't have async callbacks (no statusCallback shape on Segment APIs), so the architectural pitch is weaker. Could host Segment MCP for the "zero-install" benefit alone, but the prerequisite (deployment env, infra, etc.) is the same as Twilio's; not the lead use case.
4. **Wire-protocol changes to the shim.** The shim already supports streamable-http upstreams via `transport: streamable-http` on roster entries. A Twilio-hosted twilio-mcp is just another roster entry to the shim — nothing new to wire on our connector side.

## How this composes with the shim

The shim doesn't need to change to consume a Twilio-hosted twilio-mcp. The customer would:

1. Stop running the stdio standalone locally.
2. In the controller UI, add a new 3rd-party MCP: transport `streamable-http`, URL `https://twilio-mcp.example.com/mcp`, auth shape `bearer` with their Twilio API key (or `header` with custom X-headers — depends on what Option A/B/C goes for).
3. Connector dials the hosted endpoint over streamable-http. Existing `connectHttp` adapter handles it. Auth resolver attaches the right header from controllerEnv.

So the shim path through to a hosted twilio-mcp is **already wired** — the architectural work is purely on the hosted MCP side.

## Estimated work

Rough estimate, single-tenant (Option A) hosted variant:

- Repo work: ~150 lines (transport flag + http server + per-session route + callback handler).
- Infra work: depends on hosting target. Fly: ~1 day including TLS + DNS + secrets handling. k8s: more, depends on existing platform.
- Cred-model decision: ~1 day of product/architecture conversation before any code.

Multi-tenant (Option B/C): protocol-extension territory; can't estimate without spec direction.

## Cross-references

- [TWILIO-MCP-BREAKOUT.md](Done/TWILIO-MCP-BREAKOUT.md) — the stdio-shape work that shipped; this plan is its natural follow-up.
- [STATUS-CALLBACK-MCP.md](STATUS-CALLBACK-MCP.md) — the controller-tunneled webhook design for the customer-hosted shape; the hosted variant replaces this for its own deployment shape.
- [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) — wire format; nothing here requires protocol changes for Option A.
- `@modelcontextprotocol/sdk` — `StreamableHTTPServerTransport` is the SDK class to use.

## Resume prompt (paste after /clear)

```
Read .claude/plans/TWILIO-HOSTED-MCP.md fully. This is investigation-only;
no code work has started. Before implementing anything, confirm with the
user which of Option A / B / C from §"Cred-handling shift" we're going
for, since that decision shapes everything else.
```
