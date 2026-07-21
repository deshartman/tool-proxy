# Code Hygiene 2 — Security & Robustness Sweep

> **Status: TODO.** Drafted + decided 2026-06-29; not yet executed. Prior round at [Done/CODE_HYGINE.md](Done/CODE_HYGINE.md) covered SDK bumps, the `main()` split, the `servers/` cycle, and the rename pass. This plan picks up the security + robustness findings from the 2026-06-29 review.

## How to execute this plan (read first)

This plan is self-contained — a fresh agent should be able to `/clear`, read it, and execute end-to-end without re-asking the user. Decisions are pinned in the "Decisions log" at the bottom; do NOT re-litigate them.

**Prerequisites.**
- Confirm clean working tree: `git status` shows nothing.
- Confirm on `main` and current: `git log --oneline -3` matches `origin/main`.
- Pre-flight build: `cd packages/connector && npm run build` exits clean (clear `tsconfig.tsbuildinfo` first if a dep bump landed — see Done/CODE_HYGINE.md Step 0c deviation).

**Branch setup.**
```bash
git checkout -b fix/code-hygine
```
Single branch, three commits. **Do NOT push to origin** — feature branches stay local per the project rule (only `main` belongs on origin).

**Per-commit loop.**
1. Implement the commit's items (see §"Findings — detail" for diffs).
2. Build clean: `npm run build` from `packages/connector`.
3. Run tests: `npm test` from `packages/connector`.
4. Test-suite update: if the commit introduces a regression test, append a row to [.claude/plans/TEST-SUITE.md](TEST-SUITE.md) — date, scenario, source file, test file, status (`failing` → `passing`).
5. Commit with the message templates in §"Commit messages".

**Branch wrap-up (after commit 3).**
1. Update [CLAUDE.md](../../CLAUDE.md) with the two architectural pins commits 1 + 2 add — exact wording in §"CLAUDE.md updates required".
2. Update [packages/connector/README.md](../../packages/connector/README.md) if it references the affected behaviors (search for "CONTROLLER_URL", "OAuth", "manifest").
3. Merge with `--no-ff`:
   ```bash
   git checkout main
   git merge --no-ff fix/code-hygine
   ```
4. **Do NOT delete `fix/code-hygine`** — keep the ref per the keep-feature-branches-after-merge rule.
5. Flip this file's status to `Status: completed YYYY-MM-DD` and `git mv` it to `.claude/plans/Done/`.

**Success criteria — done when ALL of these hold.**
- `npm run build` clean from `packages/connector`.
- `npm test` clean from `packages/connector`.
- `npx madge --circular --extensions ts packages/connector/src` reports zero cycles.
- Connector boots via `./scripts/start-connector.sh`; inspector at `http://localhost:9090/` shows the 5 MCP servers + tools panel populated.
- `CONTROLLER_URL=http://example.com` (non-localhost) fails boot with a clear error naming the var.
- `CONTROLLER_URL=http://localhost:3001` boots and emits the `warn` line about insecure-localhost.
- New regression test (commit 2) passes — pins the "one bad MCP doesn't sink the manifest" property.

## Source of findings

External review delivered 2026-06-29. Eleven items across `connector/`, the inspector, and the Twilio bundle. This document re-verifies each one against today's tree (`main`), separates real bugs from style debt from misreads, and proposes a minimal fix surface per item.

## TL;DR — verdicts

| # | Finding | Verdict | Severity (mine) | Fix size |
|---|---|---|---|---|
| 1 | `controller_url` accepts `http://`, bearer over plaintext WS | **Real** | High | 1-line zod refine + boot-time check |
| 2 | Inspector `readJsonBody` unbounded | **Real** | Medium-High | 10-line cap on accumulator |
| 3 | OAuth token response under-validated | **Real** | Medium-High | Zod schema for `TokenResponse` |
| 4 | `buildManifest` fails globally on one bad `tools/list` | **Real** | High | Wrap `server.listTools()` in `safeList` (same helper already exists for prompts/resources) |
| 5 | `as any` casts at Twilio/Segment SDK boundaries | **Disagree — intentional** | n/a | None this pass (per user 2026-06-29); optional future narrow-to-SDK-types follow-up |
| 6 | Tool name validation only checks for `.` | **Real, low-impact** | Low-Medium | Validate both halves non-empty |
| 7a | `lifecycle.ts:364` `stopAll().then()` no catch | **Real** | Medium | Try/catch/finally around shutdown |
| 7b | `webhook.ts:192` `await postRevoke().catch()` | **Dropped 2026-06-29** | n/a | None |
| 8 | `void this.handleRpcFrame(...)` no top-level catch | **Real, low-risk** | Low-Medium | Try/catch wrapper that replies with `E_INTERNAL` |
| 9 | `i`/`16`/`ssReq`/`ssRes` naming | **Style only** | Low | One small commit |
| 10 | "tools deferred" logs interpreted as TODOs | **Not a finding** — productized gating | n/a | None |
| 11 | Inheritance / TODO stubs | **Not a finding** | n/a | None |

Two of the eleven aren't real findings (10, 11 — evaluator already flagged these as "no finding", we agree). One is a misread (7b). One I'd push back on (5). The other seven are real; six are small, well-scoped fixes. **Item 4 is the load-bearing one** — one bad MCP currently can sink the whole manifest at boot.

## Findings — detail

### 1. Plaintext WS leak when `controller_url=http://` (High, real)

**Evidence verified.**
- [src/config.ts:90](packages/connector/src/config.ts#L90) — `controller_url: z.string().url()` accepts any URL scheme.
- [src/tunnel/client.ts:67](packages/connector/src/tunnel/client.ts#L67) — `url.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:")` mirrors the controller's scheme into the WS scheme verbatim.
- [src/tunnel/client.ts:73-79](packages/connector/src/tunnel/client.ts#L73-L79) — `Authorization: Bearer <token>` is set on the WS upgrade headers regardless of scheme.

So `CONTROLLER_URL=http://controller.internal` ships the bearer token and `X-Connector-Name` across plaintext TCP. CLAUDE.md says "HTTPS root" but doesn't enforce.

**Why it's real.** Default-deny is the right posture for a customer-side secret. A misconfigured `.env` file shouldn't be the difference between a TLS-protected and a plaintext bearer. The current behavior is "trust whatever the operator typed" which is exactly the class of bug an env-var refine is supposed to catch.

**Counterpoint to weigh.** Local dev sometimes runs the controller on `http://localhost:3001` and dials it directly without ngrok. A blanket `https://`-only rule breaks that loop. The fix needs a localhost-allowed exception (or a `INSECURE_HTTP=1` opt-in) or it'll just get bypassed during dev.

**Proposed fix (decided 2026-06-29).** `z.string().url().refine(...)` in [src/config.ts:90](packages/connector/src/config.ts#L90):
- `https://...` → always allowed.
- `http://localhost` / `http://127.0.0.1` → allowed (dev convenience).
- Anything else `http://...` → reject with admin-actionable error naming the var (`CONTROLLER_URL`) and the recovery (switch to `https://`).
- **No `ALLOW_INSECURE_CONTROLLER` flag** — per user direction, escape-hatch flags drift toward permanent.

Also emit a `warn` line at boot when the localhost-http branch fires, so the dev convenience never silently masks a misconfig in a deployed container.

### 2. Inspector JSON body parsing unbounded (Medium-High, real)

**Evidence verified.**
- [src/inspector/server.ts:298-303](packages/connector/src/inspector/server.ts#L298-L303) — `chunks: Buffer[] = []`, `for await (const chunk of req) chunks.push(...)`, then `JSON.parse`. No byte cap, no chunk-count cap.
- Used by `handleRevoke`, `handleToolCall`, `handleMcpAction` (≥ 4 POST handlers).

**Why it's real but lower-impact.** The inspector binds to `127.0.0.1` only ([src/inspector/server.ts](packages/connector/src/inspector/server.ts), enforced in `server.listen(port, "127.0.0.1", …)`). Anyone who can reach it is already past the connector's trust boundary — that's the productized property. So this isn't a remote-attacker DoS; it's a defense-in-depth concern for shared-container localhost and for "operator pasted a giant blob by mistake" scenarios.

**Proposed fix (decided 2026-06-29).** Cap at 64 KiB and return **HTTP 413 Payload Too Large** (distinct from the existing 400 "malformed body" — the operator's recovery is different: trim the payload, not fix the JSON). The cap is enforced inside `readJsonBody` via a typed sentinel error so the per-handler catch can branch:

```ts
const MAX_INSPECTOR_BODY_BYTES = 64 * 1024; // 64 KiB — operator-pasted JSON

class BodyTooLargeError extends Error {
  constructor() { super("request body exceeds 64 KiB"); this.name = "BodyTooLargeError"; }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_INSPECTOR_BODY_BYTES) {
      req.destroy(); // stop reading; client gets a reset
      throw new BodyTooLargeError();
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
```

Each handler's existing `try { body = await readJsonBody(...) } catch { 400 }` becomes:

```ts
try { body = (await readJsonBody(req) as RevokeBody) ?? {}; }
catch (error) {
  if (error instanceof BodyTooLargeError) { res.statusCode = 413; res.end("payload too large"); return; }
  res.statusCode = 400; res.end("malformed body"); return;
}
```

Four POST handlers touch this (`handleRevoke`, `handleToolCall`, `handleMcpAction` × 2 actions). Same six-line catch in each.

### 3. OAuth token response under-validated (Medium-High, real)

**Evidence verified.** [src/auth/oauth-provider.ts:48-61](packages/connector/src/auth/oauth-provider.ts#L48-L61):
- Checks `res.ok` (catches HTTP-level error).
- Casts the JSON body to `TokenResponse` via TS interface (zero runtime check).
- Validates `expires_in` is a number ≥ 60.
- **Does NOT validate** `access_token` (could be `undefined`, empty string, or wrong type → `Bearer undefined` later).
- **Does NOT validate** `token_type` (RFC 6749 says SHOULD be `"Bearer"`).

**Why it's real.** A controller bug returning `{expires_in: 3600}` with no `access_token` boots fine here, caches `{jwt: undefined, expiresAt: ...}`, and presents `Bearer undefined` to the controller — which fails the handshake with HTTP 401 but the connector loops forever because it thinks it has a valid cached token. The diagnostic from the controller side is much harder to read than "oauth response missing access_token".

**Proposed fix.** Replace the TS interface with a zod schema:

```ts
const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine(
    (v) => v.toLowerCase() === "bearer",
    "expected token_type=bearer",
  ),
  expires_in: z.number().int().min(60),
});

const data = TokenResponse.parse(await res.json());
```

`.parse` throws on shape mismatch with a useful message. Failure surfaces through the same connect-failure path that already handles `OAuth token mint failed: {status}`.

**Decided 2026-06-29.** Case-insensitive `bearer` match (`v.toLowerCase() === "bearer"`); anything else (`MAC`, `DPoP`, etc.) → reject. Aligns with RFC 6749 §5.1 ("case insensitive") and refuses tokens our connector doesn't know how to present.

### 4. `buildManifest` fails globally on one bad `tools/list` (High, real)

**Evidence verified.**
- [src/manifest/build.ts:57-71](packages/connector/src/manifest/build.ts#L57-L71) — `Promise.all([...servers.values()].map(async (server) => …))`. One rejection collapses the whole array.
- [src/manifest/build.ts:110](packages/connector/src/manifest/build.ts#L110) — `const tools = await server.listTools();` is unguarded inside the map.
- Compare to [src/manifest/build.ts:124-128](packages/connector/src/manifest/build.ts#L124-L128) — prompts/resources/templates already go through `safeList()` (defined at line 161). The asymmetry is the bug: prompts/resources degrade per-server, tools take the whole manifest down.

**Why it's real and load-bearing.** One Type 2 MCP whose upstream returns an error on `tools/list` (network blip, expired creds, broken proxy) currently kills the connector's manifest build at boot, which throws out of `lifecycle.ts`, which prevents register. Every other MCP — including the trusted Twilio bundle — loses its tools too. That's the wrong trust boundary; tools/list failure should be local to the offending MCP.

**Proposed fix.** Extend the `safeList` pattern to tools:

```ts
async function buildServerDescriptor(server, ...): Promise<ServerDescriptor> {
  const tools = await safeList(server.listTools(), `tools/list ${server.name}`);
  // ... rest unchanged
}
```

When `tools/list` fails, the descriptor still ships with `tools: []` + whatever prompts/resources came through. Empty-tools is already a valid resting state (Twilio bundle pre-creds). The `manifest-delta` "tools removed" the controller sees on the next successful build will look identical to a creds-cleared MCP, which is the correct UX.

**`console.error` → pino (decided 2026-06-29).** Folded into this branch per user direction. [src/manifest/build.ts:166](packages/connector/src/manifest/build.ts#L166)'s `console.error` (+ the `// eslint-disable-next-line no-console` two lines above) gets replaced with a module-level `const log = createLogger("manifest-build")` and `log.error({ context, err: error }, "list failed")`. Single grep confirms `safeList` is the only `console.error` in `src/manifest/`.

### 5. `as any` casts at Twilio/Segment SDK boundaries (Medium, disagree)

**Evidence verified.** All six sites have `// eslint-disable-next-line @typescript-eslint/no-explicit-any` immediately above them:
- [mcp/bundled/twilio/messaging/tools/messages_create.ts:73](mcp/bundled/twilio/messaging/tools/messages_create.ts#L73)
- [mcp/bundled/twilio/verify/tools/verify_send.ts:32](mcp/bundled/twilio/verify/tools/verify_send.ts#L32)
- [mcp/bundled/twilio/voice/tools/calls_create.ts:37](mcp/bundled/twilio/voice/tools/calls_create.ts#L37)
- [mcp/bundled/twilio/voice/tools/agent_pay_start.ts:69](mcp/bundled/twilio/voice/tools/agent_pay_start.ts#L69)
- [mcp/bundled/twilio/segment/tools/segment_identify.ts:45](mcp/bundled/twilio/segment/tools/segment_identify.ts#L45)
- [mcp/bundled/twilio/segment/tools/segment_track.ts:44](mcp/bundled/twilio/segment/tools/segment_track.ts#L44)

**Why I'd push back.** Every site uses the same pattern: build an `opts: Record<string, unknown>` of conditional fields (e.g. "only include `from` if it's set"), then hand it to a Twilio SDK method whose typed signature is a discriminated union of "callerSid + from" vs "messagingServiceSid". The Twilio SDK's types reject the dynamically-built object because TypeScript can't prove which branch of the union it satisfies. This is exactly the case `as any` exists for — runtime check via zod at the tool boundary (`inputSchema`), wide cast at the SDK boundary. The 2026-06-19 hygiene round (Done/CODE_HYGINE.md, Step 0d) verified these three Twilio casts type-check and run against the live SDK.

**Two genuine alternatives**, neither obviously better:
- **Build a typed builder per tool.** `MessagesCreateParams = ({from: string} | {messagingServiceSid: string}) & {...}` and switch on the inputs. Net result: 30 lines of branch ladders per tool replacing 1 line of `as any`. Heavier than the bug.
- **Narrow the cast to the SDK's exported param type.** `opts as twilio.MessageListInstanceCreateOptions` — same runtime, slightly tighter intent, doesn't reach the underlying API. Worth the 6-line touch if we want to satisfy the linter without re-architecting.

**Decided 2026-06-29.** No change in this pass. Optional future follow-up: narrow the casts from `as any` to the SDK's exported request type (e.g. `opts as MessageListInstanceCreateOptions`). Style-only — same runtime, tighter intent, six-line touch per tool. Not load-bearing for this branch.

### 6. Tool name validation too permissive (Low-Medium, real)

**Evidence verified.** [src/dispatcher.ts:142](packages/connector/src/dispatcher.ts#L142):

```ts
if (!qualifiedName.includes(".")) {
  this.reply({ id, error: { code: E_INVALID_PARAMS, message: ... } });
  return;
}
const dot = qualifiedName.indexOf(".");
const serverName = qualifiedName.slice(0, dot);
const toolName = qualifiedName.slice(dot + 1);
```

So `".tool"` → `serverName=""` → `servers.get("")` → `undefined` → `tool_not_found "no local MCP server ''"`. And `"server."` → `toolName=""` → `server.callTool("", ...)` → MCP SDK's `tool_not_found` or whatever the upstream does. Both produce a less-useful error than `invalid_params`.

**Why it's real but low-impact.** The current behavior is "ambiguous tool error" instead of "explicit invalid-parameter error". No security implications (the server-lookup branch still rejects). It's a debuggability concern when the controller starts emitting malformed names.

**Proposed fix.** Validate both halves non-empty in the same `if`:

```ts
const dot = qualifiedName.indexOf(".");
if (dot <= 0 || dot === qualifiedName.length - 1) {
  this.reply({
    id,
    error: { code: E_INVALID_PARAMS, message: "tool name must be `${server}.${tool}` with non-empty parts" },
  });
  return;
}
```

### 7a. `lifecycle.ts:364` no catch on shutdown (Medium, real)

**Evidence verified.** [src/boot/lifecycle.ts:364](packages/connector/src/boot/lifecycle.ts#L364):

```ts
void supervisor.stopAll().then(() => process.exit(0));
```

If `stopAll()` throws (a child's `SIGTERM` handler hangs, the kill-fallback rejects, etc.), `process.exit(0)` never fires and the shutdown hangs until the orchestrator's SIGKILL fallback. The process *does* terminate, but the exit code (0 vs 1 vs killed-by-signal) ends up wrong, which affects how Fargate/K8s decide to retry.

**Proposed fix.** Try/catch/finally and use async:

```ts
const shutdown = async (signal: string): Promise<void> => {
  shuttingDown = true;
  log.info({ signal }, `shutting down`);
  reconnectCtl.cancel();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (discoveryTimer) clearInterval(discoveryTimer);
  tunnel?.close(`signal:${signal}`);
  try {
    await supervisor.stopAll();
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, `stopAll failed during shutdown`);
    process.exit(1);
  }
};
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });
```

This is also the pattern Karpathy-style "favor try/catch over then/catch" prescribes in our user-level CLAUDE.md.

### 7b. `webhook.ts:192` `await postRevoke().catch()` (dropped 2026-06-29)

Dropped per user direction. The `await promise.catch(handler)` shape is idiomatic for "await + swallow rejection with side-effect"; not worth rewriting.

### 8. `void this.handleRpcFrame(...)` suppresses top-level errors (Low-Medium, real)

**Evidence verified.** [src/dispatcher.ts:41](packages/connector/src/dispatcher.ts#L41):

```ts
this.deps.tunnel.onframe = (frame) => {
  if (frame.type === "rpc") {
    void this.handleRpcFrame(frame.payload);
    return;
  }
  previous?.(frame);
};
```

`handleRpcFrame` is exhaustive about replying with `tool_failed` / `replyKind` on every branch I read, AND it wraps the inner work in try/catch. The risk is a *programmer-error* throw escaping `handleRpcFrame` itself (e.g. a future refactor that throws before the try block) — there's no top-level catch, so the rejection becomes an unhandledRejection and the request hangs from the controller's POV.

**Proposed fix.** Same shape as 7a, lightweight:

```ts
this.deps.tunnel.onframe = (frame) => {
  if (frame.type === "rpc") {
    this.handleRpcFrame(frame.payload).catch((error) => {
      this.log(`unhandled rpc error: ${(error as Error)?.message ?? String(error)}`);
      // No `reply` here — we don't have the request id at this scope.
    });
    return;
  }
  previous?.(frame);
};
```

We can't reply with an error frame because the id-extraction lives inside `handleRpcFrame`. But at minimum we want the rejection logged through pino instead of dropped into the unhandledRejection bucket.

### 9. Naming debt: `i` / `16` / `ssReq` / `ssRes` (Low, real, style only)

**Evidence verified.**
- [src/mcp-supervisor.ts:68-69](packages/connector/src/mcp-supervisor.ts#L68-L69) — `for (let i = 0; i < 16; i++) { out.push(...); ... }`. The 16 is a "safety belt" cap on ancestor-walk depth.
- [src/sdk/webhook.ts:96-97](packages/connector/src/sdk/webhook.ts#L96-L97) — `let ssReq: ReturnType<typeof httpRequest> | undefined; let ssRes: IncomingMessage | undefined;`.

**Proposed fix.** Single commit:

```ts
// mcp-supervisor.ts
const MAX_ANCESTOR_HOPS = 16;
for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) { ... }

// webhook.ts
let sseReq: ReturnType<typeof httpRequest> | undefined;
let sseRes: IncomingMessage | undefined;
```

Touch only the cited lines. Don't sweep the rest of the codebase for short names — the prior round (Step 6 in Done/CODE_HYGINE.md) did a full pass; whatever survived was deliberate.

### 10. "tools deferred" logs (not a finding)

**Evidence verified.** [mcp/bundled/twilio/server.ts:161,177,191,201](mcp/bundled/twilio/server.ts) — four `info` log lines: "twilio tools deferred — awaiting creds-update", etc. These fire when the Twilio MCP boots WITHOUT creds and waits for the controller's `creds-update` frame before registering any tools. This is the productized creds-gated MCP behavior described in CLAUDE.md ("creds-gated MCPs that register zero tools at boot when their creds aren't yet present").

**Recommendation.** No fix. Evaluator's own write-up agrees ("appears intentional, not incomplete implementation"). Listed here so we don't re-litigate next round.

### 11. Inheritance / TODO stubs (not a finding)

Evaluator scanned and found nothing. We agree. Listed for completeness.

## Execution checklist — three commits on `fix/code-hygine`

Each commit reverts cleanly on its own. Implement in this order.

### Commit 1 — security (items 1, 2, 3)

Files touched: `packages/connector/src/config.ts`, `packages/connector/src/inspector/server.ts`, `packages/connector/src/auth/oauth-provider.ts`. ~80 lines total.

- [ ] **Item 1** — [src/config.ts:90](packages/connector/src/config.ts#L90): add a `.refine()` on `controller_url` that requires `https://` OR `http://localhost` OR `http://127.0.0.1`. Reject everything else with `CONTROLLER_URL must use https:// (or http://localhost for dev); got: <value>`.
- [ ] **Item 1 (warn line)** — in `boot/lifecycle.ts` (or wherever the controller URL is first logged), emit `log.warn({url}, "controller URL is plaintext http — localhost only, do not use in deployed containers")` when the URL parses to `http://localhost*` / `http://127.0.0.1*`. Search for the existing `tunnel dialing` log line and tuck this before it.
- [ ] **Item 2** — [src/inspector/server.ts:298](packages/connector/src/inspector/server.ts#L298): replace `readJsonBody` with the bounded version from §2 below. Add `BodyTooLargeError` class above it. Update all four handler call sites (`handleRevoke`, `handleToolCall`, `handleMcpAction` × 2) to branch on `error instanceof BodyTooLargeError` → 413 vs default → 400.
- [ ] **Item 3** — [src/auth/oauth-provider.ts:5-9](packages/connector/src/auth/oauth-provider.ts#L5-L9): delete the TS `TokenResponse` interface. Add the zod schema from §3 below. Replace `const data = (await res.json()) as TokenResponse` with `const data = TokenResponse.parse(await res.json())`. Remove the now-redundant `typeof data.expires_in !== "number" || data.expires_in < 60` check (zod schema enforces it).
- [ ] Verify: `npm run build && npm test` clean.
- [ ] Verify manually: `CONTROLLER_URL=http://example.com ./scripts/start-connector.sh` fails fast with a clear error.

### Commit 2 — manifest resilience (item 4 + console→pino)

Files touched: `packages/connector/src/manifest/build.ts`, new test under `packages/connector/tests/manifest/`. ~10 production lines + test.

- [ ] **Item 4** — [src/manifest/build.ts:110](packages/connector/src/manifest/build.ts#L110): replace `const tools = await server.listTools();` with `const tools = await safeList(server.listTools(), \`tools/list ${server.name}\`);`.
- [ ] **`console.error` → pino** — [src/manifest/build.ts:166](packages/connector/src/manifest/build.ts#L166): add module-level `import { createLogger } from "../logger.js"; const log = createLogger("manifest-build");`. Replace `console.error(\`[manifest-build] ${context} failed: ${...}\`)` with `log.error({ context, err: error }, "list failed")`. Remove the `// eslint-disable-next-line no-console` comment.
- [ ] **Regression test** — new file `packages/connector/tests/manifest/build-resilience.test.ts`. Test shape: build a `servers` Map with two `McpServerConnection`-like stubs — one whose `listTools()` resolves with `[{name:"ok", description:"", inputSchema:{}}]`, one whose `listTools()` rejects with `new Error("boom")`. Call `buildManifest(...)`. Assert: result has 2 servers; the bad server has `tools: []`; the good server has its tool intact.
- [ ] Append catalog row to [.claude/plans/TEST-SUITE.md](TEST-SUITE.md): date `2026-06-29` (or current), scenario "one MCP's tools/list rejecting kills the whole manifest at boot", source `src/manifest/build.ts:110`, test `tests/manifest/build-resilience.test.ts`, status `failing → passing`.
- [ ] Verify: `npm run build && npm test` clean.

### Commit 3 — style / low-impact correctness (items 6, 7a, 8, 9)

Files touched: `packages/connector/src/dispatcher.ts`, `packages/connector/src/boot/lifecycle.ts`, `packages/connector/src/mcp-supervisor.ts`, `packages/connector/src/sdk/webhook.ts`. ~40 lines total.

- [ ] **Item 6** — [src/dispatcher.ts:142](packages/connector/src/dispatcher.ts#L142): replace the `if (!qualifiedName.includes("."))` guard with the both-halves-non-empty check from §6 below.
- [ ] **Item 7a** — [src/boot/lifecycle.ts:357-365](packages/connector/src/boot/lifecycle.ts#L357-L365): convert `shutdown` to `async`, wrap `await supervisor.stopAll()` in try/catch, `process.exit(1)` on catch. SIGTERM/SIGINT handlers become `() => { void shutdown(...); }`.
- [ ] **Item 8** — [src/dispatcher.ts:41](packages/connector/src/dispatcher.ts#L41): replace `void this.handleRpcFrame(frame.payload)` with `this.handleRpcFrame(frame.payload).catch((error) => this.log(\`unhandled rpc error: ${...}\`))`.
- [ ] **Item 9** — [src/mcp-supervisor.ts:67-72](packages/connector/src/mcp-supervisor.ts#L67-L72): introduce `const MAX_ANCESTOR_HOPS = 16;` above the function, rename loop var `i → hop`. [src/sdk/webhook.ts:96-97](packages/connector/src/sdk/webhook.ts#L96-L97): rename `ssReq → sseReq`, `ssRes → sseRes` (also update the 4-5 references inside the closure — IDE rename-symbol covers them).
- [ ] Verify: `npm run build && npm test` clean.
- [ ] Verify: connector boots, all 5 MCP servers connect, manifest builds, inspector renders.

### CLAUDE.md updates required

After commit 3 lands, BEFORE merging to `main`, update [CLAUDE.md](../../CLAUDE.md):

1. **Architecturally load-bearing properties** section — add a bullet:
   > **`CONTROLLER_URL` must be HTTPS** (or `http://localhost` / `http://127.0.0.1` for local dev — boots with a warn line). The connector refuses to boot on a plaintext non-localhost URL because the WS-handshake bearer would otherwise traverse the network in cleartext. Enforced at config-load time in [`config.ts`](packages/connector/src/config.ts). Don't add an `ALLOW_INSECURE_CONTROLLER` escape hatch — escape-hatch flags drift toward permanent.

2. **Architecturally load-bearing properties** section — add a bullet:
   > **Manifest builds degrade per-MCP-server, not globally.** A single MCP's `tools/list` failure yields `tools: []` for that descriptor; the rest of the manifest still ships. This matches the existing `safeList()` behavior for prompts/resources and the trust-boundary-is-per-server property. Don't reintroduce a global `Promise.all` in [`manifest/build.ts`](packages/connector/src/manifest/build.ts).

### Commit messages

Use the project's HEREDOC pattern. Examples:

```
Commit 1 title: "Fix: harden controller URL / inspector body / OAuth token validation"

Body:
- Reject plaintext CONTROLLER_URL except for localhost (no escape hatch).
- Cap inspector JSON bodies at 64 KiB, return 413 distinct from 400.
- Validate OAuth token_type=bearer (case-insensitive) + access_token non-empty via zod.

Refs: .claude/plans/CODE-HYGINE.md items 1, 2, 3.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

```
Commit 2 title: "Fix: one MCP's tools/list failure no longer sinks the whole manifest"

Body:
- buildManifest now wraps listTools() in safeList(), matching prompts/resources.
- Replace lingering console.error in safeList with pino "manifest-build" logger.
- Add regression test pinning per-server degradation.

Refs: .claude/plans/CODE-HYGINE.md item 4.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

```
Commit 3 title: "Cleanup: tool-name validation, shutdown error handling, naming"

Body:
- Reject "server." and ".tool" with E_INVALID_PARAMS instead of ambiguous tool_not_found.
- Try/catch around supervisor.stopAll() so a hung child doesn't lose the exit code.
- Log unhandled rpc-frame rejections through pino instead of dropping them.
- Rename i→hop / ssReq→sseReq / ssRes→sseRes; extract MAX_ANCESTOR_HOPS constant.

Refs: .claude/plans/CODE-HYGINE.md items 6, 7a, 8, 9.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

## Decisions log (2026-06-29)

All open questions answered by user. Captured here so the next agent picks up the plan without re-asking:

1. **(item 1)** Localhost-http exception only. No `ALLOW_INSECURE_CONTROLLER` flag — escape-hatch flags drift toward permanent.
2. **(item 2)** 64 KiB cap, return **HTTP 413** on exceed (distinct from 400 "malformed body").
3. **(item 3)** Case-insensitive bearer (`v.toLowerCase() === "bearer"`); reject everything else.
4. **(item 5 — `as any` casts)** Keep as-is this pass. Optional future follow-up: narrow to SDK-exported request types (`as MessageListInstanceCreateOptions` etc.) — style-only, not scoped here.
5. **(item 7b)** Dropped.
6. **(items 7a + 8)** Scope strictly to the two cited sites. No broader `void promise` sweep this pass.
7. **(scope)** Fold the `console.error` → pino cleanup ([src/manifest/build.ts:166](packages/connector/src/manifest/build.ts#L166)) into item 4's branch.

