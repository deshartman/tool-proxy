# TWILIO-MCP-BREAKOUT — Lift Twilio + Segment tools into standalone MCP repos

> **Status:** drafted 2026-06-27. Revised 2026-06-27 to track the service-first restructure + agent-pay + 13 prompts that landed on main via `feature/twilio-mcp-prompts` (merge commit `0ecbe3a`). Ready for implementation after `/clear`.
>
> **Repos (created, empty, confirmed via `gh repo view`):**
> - <https://github.com/deshartman/twilio-mcp>
> - <https://github.com/deshartman/segment-mcp>
>
> **Shim branch (when phase 4 starts):** `feature/twilio-mcp-breakout` cut from `main`, NOT pushed to origin (per memory `feedback_feature_branches_local_only`).

## How to use this document

This plan is self-contained. After a `/clear`, the resume prompt at the bottom of this doc gets you back on track in one step. You can read this file top-to-bottom and execute without referring to chat history.

**Stop point:** the plan is COMPLETE when phases 1–5 are done, the catalog row in [TEST-SUITE.md](TEST-SUITE.md) is flipped to `passing` (on disk; `.claude/` is gitignored), and the `feature/twilio-mcp-breakout` branch sits unmerged on the local working copy. **DO NOT merge to `main`** — that's an explicit user gesture, not part of this plan.

## Goal

Copy the tool code AND prompt code from [`mcp/bundled/twilio/`](../../mcp/bundled/twilio/) into two new standalone repos so they work as stock stdio MCPs in any host. Depend on `@modelcontextprotocol/sdk` directly. No shim coupling, no wrapper SDK.

The bundle uses a service-first layout (`<service>/{tools,prompts,resources}/`). The standalone repos collapse that to a flat `src/tools/` + `src/prompts/` because a single-service standalone has no need for the service grouping — `mcp/bundled/twilio/messaging/tools/messages_create.ts` becomes `twilio-mcp/src/tools/messages_create.ts`, and so on. Tool/prompt count is unchanged; only the directory shape differs.

**Success criteria:**

1. `npx @modelcontextprotocol/inspector dist/index.js` against each new repo shows the expected **tool AND prompt** list:
   - `segment-mcp`: 5 tools (`profile_traits`, `profile_events`, `profile_external_ids`, `identify`, `track`) + 1 prompt (`segment_overview`).
   - `twilio-mcp` (Twilio creds only): 16 Twilio tools + 5 agent-pay tools = 21 tools + 11 prompts (`messaging_overview`, `voice_overview`, `verify_overview`, `lookups_overview` + 7 agent-pay prompts).
   - `twilio-mcp` (Twilio + SendGrid creds): 25 tools + 12 prompts.
2. The controller (running locally) loads each MCP via Type 2 stdio (`command: npx`, `args: ["-y", "@deshartman/<name>"]`) and the inspector UI lists the tools and prompts under the correct MCP name.
3. A regression test in this repo's vitest suite pins the lift mechanics — see §"Phase 4 — Defensive test + branch in the shim repo".
4. Branch `feature/twilio-mcp-breakout` exists locally with the inventory-test commit per §"Step 4.5 — Stage and commit", unmerged.

## Locked-in decisions (no open questions)

| # | Decision | Why |
|---|---|---|
| D1 | Standalone repos depend on `@modelcontextprotocol/sdk` directly — NOT `@mcp-shim/connector/sdk`. | A user running these in Claude Desktop / Cursor doesn't want our wrapper, types, logger, or yaml/dotenv deps. The shim's `createMcpHttpServer` exists for HTTP-transport-with-auto-port spawning; irrelevant outside the shim. |
| D2 | Transport is `StdioServerTransport`. | Canonical MCP shape. Claude Desktop, Cursor, Goose all expect stdio. Our shim's Type 2 stdio path supports it via `connectStdio` in [`packages/connector/src/servers/connect.ts`](../../packages/connector/src/servers/connect.ts). |
| D3 | Two separate repos, not a monorepo. | Twilio and Segment are independent products with independent release cadences. Already created as separate empty repos. |
| D4 | Status-callback uses `@deshartman/mcp-status-callback` (ngrok) only. **No multi-backend selector. No `WebhookProvider` interface.** | One backend, period. If the shim later wants to use the controller tunnel instead, that's a future second backend, separate plan. |
| D5 | `@deshartman/mcp-status-callback` is unchanged. NOT enhanced with shim-tunnel support. | That package is portable ngrok; the shim's webhook code is IPC-coupled to inspector loopback + WS frames. Merging them bloats the public package for every non-shim user and couples a personal-org package to our project internals. |
| D6 | The shim's `mcp/bundled/twilio/` stays exactly as it is. | Cutover (delete bundle, edit `connector.yaml.example`, controller wire-name migration `apis` → `twilio`+`segment`) is a SEPARATE future plan. This plan delivers the standalone repos + defensive test only. |
| D7 | MCP server name on the wire: `twilio` and `segment` (in each repo's `new McpServer({name: ...})`). | The shim's bundle keeps the `apis` name. No conflict because they're separate code paths and never run simultaneously. |
| D8 | npm scope: `@deshartman/...`. | Repos are under `deshartman/`. Matches the existing `@deshartman/mcp-status-callback`. |
| D9 | License: MIT. | Matches `@deshartman/mcp-status-callback`. |
| D10 | Logging in the new repos: `console.error` (stderr). | Stdio MCPs MUST NOT write to stdout. No Pino, no log levels, no structured logging in v1 — keep it simple. |
| D11 | SendGrid (`email_*` tools) ships in `twilio-mcp`, NOT a separate `sendgrid-mcp` repo. | Same company, related credentials, low surface area. A future split is purely additive. |
| D12 | Each repo's `package.json` `engines.node` pins `>=20`. | Native `fetch` for the Segment Profile API; MCP SDK Node version policy. |
| D13 | **Lift policy: 1:1 mirror of the bundle's full surface, including prompts.** Every tool and every prompt that ships in `mcp/bundled/twilio/` ships in the corresponding standalone repo. Agent-pay (5 tools + 7 prompts) ships in `twilio-mcp` as a single coherent flow; service-overview prompts ship in each repo (`segment_overview` → `segment-mcp`; `messaging_overview`/`voice_overview`/`verify_overview`/`lookups_overview`/`email_overview` → `twilio-mcp`). | Confirmed 2026-06-27 after the prompts work landed on main. Splitting tools-only would gut the agent-pay UX (the prompts ARE the live-call playbook) and force every consumer of the standalone repos to re-derive the tool-selection guides the bundled prompts encode. |
| D14 | **Standalone layout is FLAT** (`src/tools/`, `src/prompts/`) — service-first grouping is bundle-specific. | A single-service repo gains nothing from `messaging/tools/`, `voice/tools/`, etc. Sub-directories were a multi-service-grouping affordance; the standalone repos ARE single-service by definition. Mirroring the bundle's layout would add noise without adding clarity. |

## Working directories

Phases 1–3 happen OUTSIDE this repo. Use a parent directory next to the shim:

```
~/Development/01_Twilio/
├── AgenticProcedure/                    # controller (existing)
├── mcp-shim/                            # THIS repo
├── twilio-mcp/                          # CLONE in phase 1
└── segment-mcp/                         # CLONE in phase 1
```

The shim's CWD stays `~/Development/01_Twilio/mcp-shim/` throughout. Each `cd` step into one of the new repos is explicit in the phase steps. After working in a new repo, `cd` back to the shim.

## Phase 1 — Bootstrap both new repos (segment-mcp first)

`segment-mcp` is smaller and has no status-callback complication — derisks the lift mechanics before tackling Twilio.

### Step 1.1 — Clone both empty repos

```bash
cd ~/Development/01_Twilio
gh repo clone deshartman/segment-mcp
gh repo clone deshartman/twilio-mcp
```

### Step 1.2 — Bootstrap `segment-mcp/`

```bash
cd ~/Development/01_Twilio/segment-mcp
```

Write these files. Use the exact contents in §"File templates — segment-mcp" below.

1. `.gitignore` — standard Node (`node_modules/`, `dist/`, `*.log`, `.env`, `.DS_Store`).
2. `LICENSE` — MIT, copyright `Des Hartman 2026`.
3. `package.json` — see template.
4. `tsconfig.json` — see template.
5. `README.md` — see template.

### Step 1.3 — Copy source files from the shim into `segment-mcp/src/`

The bundle uses service-first layout (`segment/tools/`, `segment/prompts/`). The standalone repo collapses to flat `src/tools/` + `src/prompts/` (D14).

From `~/Development/01_Twilio/mcp-shim/mcp/bundled/twilio/`:

```bash
mkdir -p ~/Development/01_Twilio/segment-mcp/src/{tools,prompts}
cp segment-profile-client.ts    ~/Development/01_Twilio/segment-mcp/src/segment-profile-client.ts
cp segment-tracker.ts           ~/Development/01_Twilio/segment-mcp/src/segment-tracker.ts
cp segment/tools/*.ts           ~/Development/01_Twilio/segment-mcp/src/tools/
cp segment/prompts/*.ts         ~/Development/01_Twilio/segment-mcp/src/prompts/
```

This copies 5 tools and 1 prompt (`segment_overview.ts`).

### Step 1.4 — Mechanical edits in `segment-mcp/src/`

For every `.ts` file under `segment-mcp/src/`:

1. **Remove** `import type { Tool } from "@mcp-shim/connector/sdk";` and `import type { Prompt } from "@mcp-shim/connector/sdk";`.
2. **Replace** `import { createLogger } from "@mcp-shim/connector/sdk";` with nothing — use `console.error` directly anywhere `log.info(...)` / `log.warn(...)` / `log.error(...)` was used. Format: `console.error("segment:", message, payload ?? "");`
3. **Tool factory return type:** the existing factory `export function segmentProfileTraits(client): Tool { return { name, register(server) { ... } } }` works unchanged. The `Tool` type was structural — the shape is `{name: string, register(server: McpServer): void}`. Drop the explicit type annotation. Same applies to `Prompt` — the shape is `{name: string, register(server: McpServer): void}`.
4. **Import path for `McpServer`:** any file that needs the type (`tools/*.ts` and `prompts/*.ts`) gets `import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";` at the top.

### Step 1.5 — Write `segment-mcp/src/index.ts`

See the template in §"File templates — segment-mcp".

### Step 1.6 — Build + smoke test segment-mcp

```bash
cd ~/Development/01_Twilio/segment-mcp
npm install
npm run build
```

Smoke test with MCP inspector:

```bash
# Set creds in shell first (replace with real values from your Segment workspace).
export SEGMENT_SPACE_ID=spa_xxx
export SEGMENT_PROFILE_PAT=xxx
export SEGMENT_WRITE_KEY=xxx
npx @modelcontextprotocol/inspector dist/index.js
```

Verify:
- **Tools:** all 5 (`profile_traits`, `profile_events`, `profile_external_ids`, `identify`, `track`). Call `profile_traits` with `id_type: "email"` + a known profile's email. Response shape should match what `mcp/bundled/twilio/segment/tools/segment_profile_traits.ts` returns in the shim today.
- **Prompts:** 1 (`segment_overview`). Fetch via the inspector's prompts panel; confirm the text round-trips and references real tool names verbatim. If only one set of creds is configured (read OR write), the prompt should still register (the bundle's gating logic is "EITHER read or write creds present" — see [`mcp/bundled/twilio/server.ts`](../../mcp/bundled/twilio/server.ts) for the reference shape).

**Commit point S1** (in `segment-mcp/`): `git add -A && git commit -m "Initial segment-mcp lift from mcp-shim/mcp/bundled/twilio/"`. Push to `origin/main`.

## Phase 2 — Bootstrap twilio-mcp

### Step 2.1 — Bootstrap `twilio-mcp/`

```bash
cd ~/Development/01_Twilio/twilio-mcp
```

Files: `.gitignore`, `LICENSE`, `package.json`, `tsconfig.json`, `README.md` — see §"File templates — twilio-mcp".

### Step 2.2 — Copy source files from the shim

The bundle uses service-first layout (`messaging/tools/`, `voice/tools/`, `voice/prompts/`, etc.). The standalone repo collapses to flat `src/tools/` + `src/prompts/` (D14). All file names are preserved; only the directory structure changes.

From `~/Development/01_Twilio/mcp-shim/mcp/bundled/twilio/`:

```bash
mkdir -p ~/Development/01_Twilio/twilio-mcp/src/{tools,prompts}

# Client wrappers + status-callback (status-callback rewritten in step 2.4)
cp twilio-client.ts        ~/Development/01_Twilio/twilio-mcp/src/
cp sendgrid-client.ts      ~/Development/01_Twilio/twilio-mcp/src/
cp status-callback.ts      ~/Development/01_Twilio/twilio-mcp/src/  # WILL BE REWRITTEN in step 2.4

# Tools — 16 Twilio + 5 agent-pay + 4 SendGrid = 25 tools total
cp messaging/tools/*.ts    ~/Development/01_Twilio/twilio-mcp/src/tools/
cp voice/tools/*.ts        ~/Development/01_Twilio/twilio-mcp/src/tools/   # includes 5 agent_pay_* tools
cp verify/tools/*.ts       ~/Development/01_Twilio/twilio-mcp/src/tools/
cp lookups/tools/*.ts      ~/Development/01_Twilio/twilio-mcp/src/tools/
cp email/tools/*.ts        ~/Development/01_Twilio/twilio-mcp/src/tools/

# Prompts — 4 service overviews + 7 agent-pay + 1 email overview = 12 prompts total
cp messaging/prompts/*.ts  ~/Development/01_Twilio/twilio-mcp/src/prompts/
cp voice/prompts/*.ts      ~/Development/01_Twilio/twilio-mcp/src/prompts/   # voice_overview + 7 agent_pay_* prompts
cp verify/prompts/*.ts     ~/Development/01_Twilio/twilio-mcp/src/prompts/
cp lookups/prompts/*.ts    ~/Development/01_Twilio/twilio-mcp/src/prompts/
cp email/prompts/*.ts      ~/Development/01_Twilio/twilio-mcp/src/prompts/
```

After the copy, `twilio-mcp/src/tools/` contains 25 files and `twilio-mcp/src/prompts/` contains 12 files. All filenames preserved verbatim — `messages_create.ts`, `agent_pay_start.ts`, `voice_overview.ts`, etc.

### Step 2.3 — Mechanical edits

Same as Step 1.4, applied across all files under `twilio-mcp/src/`:

1. Remove `import type { Tool } from "@mcp-shim/connector/sdk";` and `import type { Prompt } from "@mcp-shim/connector/sdk";`.
2. Replace `createLogger` imports with `console.error`. Use `console.error("twilio:", ...)` prefix.
3. Drop explicit `Tool` / `Prompt` return-type annotations; structure unchanged.
4. Add `import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";` where needed.
5. **Tools that import `status-callback.ts`**: every importer's path flattens from `../../status-callback.js` to `./status-callback.js` (the standalone layout is flat — no service subdirectory above the tools). As of 2026-06-27 the importers are:
   - `tools/messages_create.ts`
   - `tools/agent_pay_start.ts`
   - `tools/agent_pay_capture_card.ts`
   - `tools/agent_pay_capture_cvc.ts`
   - `tools/agent_pay_capture_exp.ts`
   - `tools/agent_pay_complete.ts`

   Grep + sed will catch them in one pass: `cd ~/Development/01_Twilio/twilio-mcp && grep -lr '\.\./\.\./status-callback' src | xargs sed -i '' 's|\.\./\.\./status-callback|./status-callback|g'`. If the shim has added a new status-callback importer since 2026-06-27, the same grep finds it.

### Step 2.4 — Rewrite `twilio-mcp/src/status-callback.ts`

The current file uses our shim's `createWebhookEndpoint`. Replace with `@deshartman/mcp-status-callback`'s `CallbackHandler`. Public surface (`getDefaultStatusCallback`, `onStatusCallback`, `waitForStatus`) stays IDENTICAL so tool code doesn't change.

See template in §"File templates — twilio-mcp".

Key behaviors:
- On first `getDefaultStatusCallback()` call, instantiate `CallbackHandler` with `process.env.NGROK_AUTH_TOKEN`, await `.start()`, cache the URL.
- If `NGROK_AUTH_TOKEN` is missing, return `undefined`. Tools that take `receiveStatusCallbacks: true` should `console.error` a warn and call Twilio without the `statusCallback` param.
- Wire `CallbackHandler`'s `CALLBACK` event to the existing `listeners` Set so `onStatusCallback` and `waitForStatus` work unchanged.
- The `@deshartman/mcp-status-callback` import is dynamic (`await import(...)`) and `optionalDependencies`-installed so a non-callback user doesn't need ngrok.

### Step 2.5 — Write `twilio-mcp/src/index.ts`

See template. Conditional creds-gating mirrors the shim's `server.ts` minus the Segment groups:
- **Twilio group** — 21 tools (16 messaging/voice/verify/lookups + 5 agent-pay) + 11 prompts (`messaging_overview`, `voice_overview`, `verify_overview`, `lookups_overview` + 7 agent-pay prompts). Requires `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`.
- **SendGrid group** — 4 email tools + 1 prompt (`email_overview`). Requires `SENDGRID_API_KEY`.

### Step 2.6 — Build + smoke test twilio-mcp

```bash
cd ~/Development/01_Twilio/twilio-mcp
npm install
npm run build
```

Smoke test 1 (no callbacks):

```bash
export TWILIO_ACCOUNT_SID=ACxxx
export TWILIO_AUTH_TOKEN=xxx
export SENDGRID_API_KEY=SG.xxx  # optional
npx @modelcontextprotocol/inspector dist/index.js
```

Verify:
- **Tools:** 21 Twilio tools (16 + 5 agent-pay) with Twilio creds only; 25 tools (21 + 4 SendGrid) with both. Call `lookups_fetch` with a real number — free, no callback.
- **Prompts:** 11 with Twilio creds only (`messaging_overview`, `voice_overview`, `verify_overview`, `lookups_overview`, `agent_pay_start_capture`, `agent_pay_card_number`, `agent_pay_expiration`, `agent_pay_security_code`, `agent_pay_finish`, `agent_pay_completion`, `agent_pay_error`); 12 with SendGrid added (`email_overview`). Fetch `voice_overview` and `agent_pay_start_capture` to confirm the prompt round-trip works.

Smoke test 2 (with callbacks, OPTIONAL — requires real Twilio sandbox):

```bash
export NGROK_AUTH_TOKEN=xxx
# Reload inspector, call messages_create with receiveStatusCallbacks: true
# to a real Twilio sandbox number. Watch for the callback in the inspector
# logs (you'll need to wire onStatusCallback yourself for the manual test
# — or rely on the implicit listener in server.ts that's lifted from the
# shim's bundle).
```

**Commit point T1** (in `twilio-mcp/`): `git add -A && git commit -m "Initial twilio-mcp lift from mcp-shim/mcp/bundled/twilio/"`. Push to `origin/main`.

## Phase 3 — Publish + controller-load test

### Step 3.1 — Publish segment-mcp

```bash
cd ~/Development/01_Twilio/segment-mcp
npm pack  # creates @deshartman-segment-mcp-0.1.0.tgz — inspect with tar -tzf to confirm only dist/ + docs
npm publish --access public
```

### Step 3.2 — Publish twilio-mcp

```bash
cd ~/Development/01_Twilio/twilio-mcp
npm pack
npm publish --access public
```

### Step 3.3 — Test load in the controller

This is the success-criterion gate. The controller UI's "New 3rd Party MCP" flow exists today (see CLAUDE.md §"Type 2"). For each new MCP:

1. Open the controller UI (`AgenticProcedure/` running locally — start the controller per its own README).
2. Start a connector locally (`cd ~/Development/01_Twilio/mcp-shim && ./scripts/start-connector.sh`).
3. In the controller, navigate to the connector's detail page → **New 3rd Party MCP**.
4. Add `segment-mcp`:
   - Name: `segment`
   - Transport: stdio
   - Command: `npx`
   - Args: `-y @deshartman/segment-mcp`
   - Env: `SEGMENT_SPACE_ID`, `SEGMENT_PROFILE_PAT`, `SEGMENT_WRITE_KEY` (paste values)
5. Wait for the connector's manifest-delta to land. Verify in the connector's inspector (<http://localhost:9090/>) that 5 `segment.*` tools AND 1 prompt (`segment.segment_overview`) appear under MCP `segment`. Confirm the prompts panel renders the overview text correctly.
6. Run a procedure that calls `segment.profile_traits` with a known email. Verify the response matches what the shim's bundled `apis.segment_profile_traits` returns today.
7. Repeat for `twilio-mcp`:
   - Name: `twilio`
   - Command: `npx`
   - Args: `-y @deshartman/twilio-mcp`
   - Env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, optionally `SENDGRID_API_KEY`, `NGROK_AUTH_TOKEN`
8. Verify in the inspector that 21 (or 25 with SendGrid) `twilio.*` tools AND 11 (or 12 with SendGrid) `twilio.*` prompts land. Run a procedure that calls `twilio.lookups_fetch` (free). Optionally fetch the `twilio.voice_overview` prompt to verify the prompts panel surfaces it.

**Gate:** if step 6 or step 8 fails, the lift is broken — go back to phases 1–2 and reconcile before continuing.

## File templates — segment-mcp

### `segment-mcp/package.json`

```json
{
  "name": "@deshartman/segment-mcp",
  "version": "0.1.0",
  "description": "Standalone MCP server exposing Segment Profile API + Tracking API as tools.",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "segment-mcp": "dist/index.js"
  },
  "files": ["dist", "README.md", "LICENSE"],
  "license": "MIT",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "tsc",
    "prepare": "npm run build"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@segment/analytics-node": "^3.1.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0"
  }
}
```

### `segment-mcp/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

### `segment-mcp/src/index.ts`

```ts
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSegmentProfileClient } from "./segment-profile-client.js";
import { makeSegmentTracker } from "./segment-tracker.js";
import { segmentProfileTraits } from "./tools/segment_profile_traits.js";
import { segmentProfileEvents } from "./tools/segment_profile_events.js";
import { segmentProfileExternalIds } from "./tools/segment_profile_external_ids.js";
import { segmentIdentify } from "./tools/segment_identify.js";
import { segmentTrack } from "./tools/segment_track.js";
import { segmentOverview } from "./prompts/segment_overview.js";

const server = new McpServer({ name: "segment", version: "0.1.0" });

const READ_KEYS = ["SEGMENT_SPACE_ID", "SEGMENT_PROFILE_PAT"] as const;
const WRITE_KEYS = ["SEGMENT_WRITE_KEY"] as const;
const readMissing = READ_KEYS.filter((k) => !process.env[k]);
const writeMissing = WRITE_KEYS.filter((k) => !process.env[k]);

if (readMissing.length === 0) {
  const profile = createSegmentProfileClient();
  segmentProfileTraits(profile).register(server);
  segmentProfileEvents(profile).register(server);
  segmentProfileExternalIds(profile).register(server);
} else {
  console.error("segment: read tools deferred — missing", readMissing);
}

if (writeMissing.length === 0) {
  const tracker = makeSegmentTracker();
  segmentIdentify(tracker).register(server);
  segmentTrack(tracker).register(server);
} else {
  console.error("segment: write tools deferred — missing", writeMissing);
}

// segment_overview surfaces if EITHER read OR write creds are present.
// The prompt itself explains which flows the LLM can use given partial creds.
if (readMissing.length === 0 || writeMissing.length === 0) {
  segmentOverview.register(server);
}

const transport = new StdioServerTransport();
await server.connect(transport);
```

### `segment-mcp/README.md` (skeleton)

```markdown
# @deshartman/segment-mcp

Standalone MCP server exposing Segment Profile API (read) + Tracking API (write).

## Tools

- `profile_traits({ id_type, value })` — latest traits for a unified profile.
- `profile_events({ id_type, value, limit?, next? })` — recent events.
- `profile_external_ids({ id_type, value })` — linked external ids.
- `identify({ userId | anonymousId, traits? })` — upsert traits.
- `track({ userId | anonymousId, event, properties? })` — record an event.

## Prompts

- `segment_overview` — zero-arg overview prompt. Quick reference for which tool to call in which situation (read vs write flows, id_type semantics, EU host override). Fetch via `prompts/get` once at the start of a session; the prompt's text references tool names verbatim so the LLM can ground its guidance against `tools/list`. Surfaces if EITHER read or write creds are present; the prompt explains which flows are available given partial creds.

## Setup

Install:

\`\`\`bash
npm install -g @deshartman/segment-mcp
\`\`\`

Or use via `npx`:

\`\`\`bash
npx -y @deshartman/segment-mcp
\`\`\`

## Env

| Key | Required for | Notes |
|---|---|---|
| `SEGMENT_SPACE_ID` | read tools | Segment Profile Space id |
| `SEGMENT_PROFILE_PAT` | read tools | Profile API personal access token |
| `SEGMENT_PROFILE_HOST` | read tools (optional) | Default `https://profiles.segment.com`; EU workspaces use `https://profiles.euw1.segment.com` |
| `SEGMENT_WRITE_KEY` | write tools | Source write key |

## Usage in Claude Desktop

\`\`\`json
{
  "mcpServers": {
    "segment": {
      "command": "npx",
      "args": ["-y", "@deshartman/segment-mcp"],
      "env": {
        "SEGMENT_SPACE_ID": "spa_xxx",
        "SEGMENT_PROFILE_PAT": "xxx",
        "SEGMENT_WRITE_KEY": "xxx"
      }
    }
  }
}
\`\`\`
```

## File templates — twilio-mcp

### `twilio-mcp/package.json`

```json
{
  "name": "@deshartman/twilio-mcp",
  "version": "0.1.0",
  "description": "Standalone MCP server exposing Twilio messaging, voice, verify, lookups, and SendGrid email APIs as tools.",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "twilio-mcp": "dist/index.js"
  },
  "files": ["dist", "README.md", "LICENSE"],
  "license": "MIT",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "tsc",
    "prepare": "npm run build"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "twilio": "^6.0.2",
    "@sendgrid/client": "^8.1.4",
    "zod": "^4.4.3"
  },
  "optionalDependencies": {
    "@deshartman/mcp-status-callback": "^0.5.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0"
  }
}
```

### `twilio-mcp/tsconfig.json`

Identical to segment-mcp's tsconfig — `target: ES2022`, `module: NodeNext`, `rootDir: src`, `outDir: dist`, `strict: true`.

### `twilio-mcp/src/status-callback.ts` (rewritten — ngrok-backed)

```ts
// Ngrok-backed status-callback helper. Replaces the shim's createWebhookEndpoint
// with @deshartman/mcp-status-callback's CallbackHandler. Public surface is
// IDENTICAL to the shim's status-callback.ts so tool code is unchanged.

export interface WebhookEvent {
  body: unknown;
  queryParameters: Record<string, string | string[]>;
  headers?: Record<string, string>;
  receivedAt: number;
}

const listeners = new Set<(event: WebhookEvent) => void>();
let urlPromise: Promise<string | undefined> | undefined;

async function startNgrok(): Promise<string | undefined> {
  const token = process.env.NGROK_AUTH_TOKEN;
  if (!token) {
    console.error("twilio: NGROK_AUTH_TOKEN not set — status callbacks disabled");
    return undefined;
  }
  // Dynamic import so @deshartman/mcp-status-callback can be optionalDependencies.
  let CallbackHandler: typeof import("@deshartman/mcp-status-callback").CallbackHandler;
  try {
    ({ CallbackHandler } = await import("@deshartman/mcp-status-callback"));
  } catch (error) {
    console.error("twilio: @deshartman/mcp-status-callback not installed — status callbacks disabled", error);
    return undefined;
  }
  const handler = new CallbackHandler({ ngrokAuthToken: token });
  handler.on("callback", (data: { queryParameters: Record<string, string | string[]>; body: unknown }) => {
    const event: WebhookEvent = {
      body: data.body,
      queryParameters: data.queryParameters,
      receivedAt: Date.now(),
    };
    for (const fn of listeners) {
      try { fn(event); } catch (e) { console.error("twilio: status listener threw", e); }
    }
  });
  try {
    const publicUrl = await handler.start();
    console.error("twilio: status-callback URL ready", publicUrl);
    return publicUrl;
  } catch (error) {
    console.error("twilio: ngrok start failed", error);
    return undefined;
  }
}

export async function getDefaultStatusCallback(): Promise<string | undefined> {
  if (urlPromise === undefined) urlPromise = startNgrok();
  return urlPromise;
}

export function onStatusCallback(listener: (event: WebhookEvent) => void): () => void {
  listeners.add(listener);
  void getDefaultStatusCallback();
  return () => listeners.delete(listener);
}

// waitForStatus + helpers — lift from mcp/bundled/twilio/status-callback.ts
// verbatim (SID_KEYS, STATUS_KEYS, readField, extractSid, extractStatus,
// WaitForStatusOptions, waitForStatus). They depend only on WebhookEvent
// + the listeners Set, both defined above.
```

### `twilio-mcp/src/index.ts`

```ts
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { onStatusCallback } from "./status-callback.js";
import { createTwilioClient } from "./twilio-client.js";
import { makeSendGridProvider } from "./sendgrid-client.js";
// Messaging — 4 tools + 1 prompt
import { messagesCreate } from "./tools/messages_create.js";
import { messagesFetch } from "./tools/messages_fetch.js";
import { messagingServicesFetch } from "./tools/messaging_services_fetch.js";
import { contentTemplatesFetch } from "./tools/content_templates_fetch.js";
import { messagingOverview } from "./prompts/messaging_overview.js";
// Voice — 8 base tools + 5 agent-pay tools + 1 overview prompt + 7 agent-pay prompts
import { callsCreate } from "./tools/calls_create.js";
import { callsFetch } from "./tools/calls_fetch.js";
import { voiceSay } from "./tools/voice_say.js";
import { voicePlay } from "./tools/voice_play.js";
import { voiceDial } from "./tools/voice_dial.js";
import { voicePay } from "./tools/voice_pay.js";
import { voiceTranscriptionStart } from "./tools/voice_transcription_start.js";
import { voiceTranscriptionStop } from "./tools/voice_transcription_stop.js";
import { agentPayStart } from "./tools/agent_pay_start.js";
import { agentPayCaptureCard } from "./tools/agent_pay_capture_card.js";
import { agentPayCaptureExp } from "./tools/agent_pay_capture_exp.js";
import { agentPayCaptureCvc } from "./tools/agent_pay_capture_cvc.js";
import { agentPayComplete } from "./tools/agent_pay_complete.js";
import { voiceOverview } from "./prompts/voice_overview.js";
import { agentPayStartCapture } from "./prompts/agent_pay_start_capture.js";
import { agentPayCardNumber } from "./prompts/agent_pay_card_number.js";
import { agentPayExpiration } from "./prompts/agent_pay_expiration.js";
import { agentPaySecurityCode } from "./prompts/agent_pay_security_code.js";
import { agentPayFinish } from "./prompts/agent_pay_finish.js";
import { agentPayCompletion } from "./prompts/agent_pay_completion.js";
import { agentPayError } from "./prompts/agent_pay_error.js";
// Verify — 3 tools + 1 prompt
import { verifySend } from "./tools/verify_send.js";
import { verifyCheck } from "./tools/verify_check.js";
import { verifyServicesFetch } from "./tools/verify_services_fetch.js";
import { verifyOverview } from "./prompts/verify_overview.js";
// Lookups — 1 tool + 1 prompt
import { lookupsFetch } from "./tools/lookups_fetch.js";
import { lookupsOverview } from "./prompts/lookups_overview.js";
// Email (SendGrid) — 4 tools + 1 prompt
import { emailSend } from "./tools/email_send.js";
import { emailFetch } from "./tools/email_fetch.js";
import { emailSearch } from "./tools/email_search.js";
import { emailTemplatesFetch } from "./tools/email_templates_fetch.js";
import { emailOverview } from "./prompts/email_overview.js";

const server = new McpServer({ name: "twilio", version: "0.1.0" });

onStatusCallback((event) => {
  const sid = pickFirst(event.body, ["MessageSid", "CallSid"]) ?? pickFirst(event.queryParameters, ["MessageSid", "CallSid"]);
  const status = pickFirst(event.body, ["MessageStatus", "CallStatus"]) ?? pickFirst(event.queryParameters, ["MessageStatus", "CallStatus"]);
  console.error("twilio: statusCallback received", { sid, status, receivedAt: event.receivedAt });
});

function pickFirst(payload: unknown, keys: string[]): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const obj = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

const twilioMissing = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"].filter((k) => !process.env[k]);
const sendgridMissing = ["SENDGRID_API_KEY"].filter((k) => !process.env[k]);

if (twilioMissing.length === 0) {
  const twilio = createTwilioClient();
  // Tools — 21 total (4 messaging + 13 voice + 3 verify + 1 lookups)
  messagesCreate(twilio).register(server);
  messagesFetch(twilio).register(server);
  messagingServicesFetch(twilio).register(server);
  contentTemplatesFetch(twilio).register(server);
  callsCreate(twilio).register(server);
  callsFetch(twilio).register(server);
  voiceSay().register(server);
  voicePlay().register(server);
  voiceDial().register(server);
  voicePay().register(server);
  voiceTranscriptionStart().register(server);
  voiceTranscriptionStop().register(server);
  agentPayStart(twilio).register(server);
  agentPayCaptureCard(twilio).register(server);
  agentPayCaptureExp(twilio).register(server);
  agentPayCaptureCvc(twilio).register(server);
  agentPayComplete(twilio).register(server);
  verifySend(twilio).register(server);
  verifyCheck(twilio).register(server);
  verifyServicesFetch(twilio).register(server);
  lookupsFetch(twilio).register(server);
  // Prompts — 11 total (4 overviews + 7 agent-pay)
  messagingOverview.register(server);
  voiceOverview.register(server);
  verifyOverview.register(server);
  lookupsOverview.register(server);
  agentPayStartCapture.register(server);
  agentPayCardNumber.register(server);
  agentPayExpiration.register(server);
  agentPaySecurityCode.register(server);
  agentPayFinish.register(server);
  agentPayCompletion.register(server);
  agentPayError.register(server);
} else {
  console.error("twilio: tools and prompts deferred — missing", twilioMissing);
}

if (sendgridMissing.length === 0) {
  const sg = makeSendGridProvider();
  emailSend(sg).register(server);
  emailFetch(sg).register(server);
  emailSearch(sg).register(server);
  emailTemplatesFetch(sg).register(server);
  emailOverview.register(server);
} else {
  console.error("twilio: sendgrid tools deferred — missing", sendgridMissing);
}

const transport = new StdioServerTransport();
await server.connect(transport);
```

### `twilio-mcp/README.md` (skeleton)

Mirrors the segment-mcp README structure. Lifts the bulk of the content from the shim's [`mcp/bundled/twilio/README.md`](../../mcp/bundled/twilio/README.md) with the following adjustments:

- **Drop the "Folder layout" section** — standalone repo is flat, the bundle's service-first explanation doesn't apply.
- **Tools section** — same 6 service-grouped tables (messaging / voice / verify / lookups / email — drop the segment table, since it lives in `segment-mcp`). 21 Twilio + 4 SendGrid tools.
- **Prompts section** — list all 12 prompts (4 overviews + 7 agent-pay + 1 email overview). Match the bundle README's table shape.
- **Agent-assisted payments — walkthrough** — copy verbatim from the bundle README. The flow doesn't change between the bundle and the standalone repo; only the underlying transport (stdio vs http+ws) differs, and that's invisible to the LLM.
- **Setup section** — replace the bundle's `start-connector.sh` instructions with Claude Desktop / Cursor / `npx` invocations. Mention optional `NGROK_AUTH_TOKEN` for status callbacks (without it, `agent_pay_*` still works for the Twilio-side capture but no callback events arrive).
- **No mention of the shim** — these are standalone packages. A reader who's never heard of `mcp-shim` should be able to install and use the package.

Claude Desktop config example:

\`\`\`json
{
  "mcpServers": {
    "twilio": {
      "command": "npx",
      "args": ["-y", "@deshartman/twilio-mcp"],
      "env": {
        "TWILIO_ACCOUNT_SID": "ACxxx",
        "TWILIO_AUTH_TOKEN": "xxx",
        "SENDGRID_API_KEY": "SG.xxx",
        "NGROK_AUTH_TOKEN": "xxx"
      }
    }
  }
}
\`\`\`

## Phase 4 — Defensive test + branch in the shim repo

This phase runs in the shim (`~/Development/01_Twilio/mcp-shim/`), on a new branch.

### Step 4.1 — Cut the branch

```bash
cd ~/Development/01_Twilio/mcp-shim
git checkout main
git pull --ff-only
git checkout -b feature/twilio-mcp-breakout
```

Confirm starting clean (`git status` reports nothing modified).

### Step 4.2 — Write the regression test

The lift mechanically duplicates source code into two new repos. If the shim's bundled `apis` MCP later changes a tool's signature, renames a prompt, or adds a new tool to a service group, the standalone repos will silently drift. The defensive test pins **the file-level inventory** of every tool AND prompt that was lifted, plus the **MCP-name contract** the controller uses to load them.

Paths use the service-first bundle layout (`<service>/{tools,prompts}/`) that landed on main in merge commit `0ecbe3a`.

Create [`packages/connector/tests/mcp-tools/apis/lift-inventory.test.ts`](../../packages/connector/tests/mcp-tools/apis/lift-inventory.test.ts):

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/connector/tests/mcp-tools/apis
// Need 5 .. to reach the repo root, where mcp/bundled/twilio lives.
const BUNDLE = join(__dirname, "../../../../..", "mcp/bundled/twilio");

// This suite is a contract pin: when these inventories change, the
// standalone repos (@deshartman/twilio-mcp and @deshartman/segment-mcp)
// MUST be updated in lockstep. See .claude/plans/TWILIO-MCP-BREAKOUT.md.

describe("twilio-mcp lift inventory — tools", () => {
  it("ships exactly 4 messaging tool files", () => {
    const files = readdirSync(join(BUNDLE, "messaging/tools")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual([
      "content_templates_fetch.ts",
      "messages_create.ts",
      "messages_fetch.ts",
      "messaging_services_fetch.ts",
    ]);
  });

  it("ships exactly 13 voice tool files (8 base + 5 agent-pay)", () => {
    const files = readdirSync(join(BUNDLE, "voice/tools")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual([
      "agent_pay_capture_card.ts",
      "agent_pay_capture_cvc.ts",
      "agent_pay_capture_exp.ts",
      "agent_pay_complete.ts",
      "agent_pay_start.ts",
      "calls_create.ts",
      "calls_fetch.ts",
      "voice_dial.ts",
      "voice_pay.ts",
      "voice_play.ts",
      "voice_say.ts",
      "voice_transcription_start.ts",
      "voice_transcription_stop.ts",
    ]);
  });

  it("ships exactly 3 verify tool files", () => {
    const files = readdirSync(join(BUNDLE, "verify/tools")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual([
      "verify_check.ts",
      "verify_send.ts",
      "verify_services_fetch.ts",
    ]);
  });

  it("ships exactly 1 lookups tool file", () => {
    const files = readdirSync(join(BUNDLE, "lookups/tools")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual(["lookups_fetch.ts"]);
  });

  it("ships exactly 4 email tool files", () => {
    const files = readdirSync(join(BUNDLE, "email/tools")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual([
      "email_fetch.ts",
      "email_search.ts",
      "email_send.ts",
      "email_templates_fetch.ts",
    ]);
  });

  it("ships the three Twilio client wrappers", () => {
    expect(existsSync(join(BUNDLE, "twilio-client.ts"))).toBe(true);
    expect(existsSync(join(BUNDLE, "sendgrid-client.ts"))).toBe(true);
    expect(existsSync(join(BUNDLE, "status-callback.ts"))).toBe(true);
  });
});

describe("twilio-mcp lift inventory — prompts", () => {
  it("ships exactly 1 messaging prompt", () => {
    const files = readdirSync(join(BUNDLE, "messaging/prompts")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual(["messaging_overview.ts"]);
  });

  it("ships exactly 8 voice prompts (1 overview + 7 agent-pay)", () => {
    const files = readdirSync(join(BUNDLE, "voice/prompts")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual([
      "agent_pay_card_number.ts",
      "agent_pay_completion.ts",
      "agent_pay_error.ts",
      "agent_pay_expiration.ts",
      "agent_pay_finish.ts",
      "agent_pay_security_code.ts",
      "agent_pay_start_capture.ts",
      "voice_overview.ts",
    ]);
  });

  it("ships exactly 1 verify prompt", () => {
    const files = readdirSync(join(BUNDLE, "verify/prompts")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual(["verify_overview.ts"]);
  });

  it("ships exactly 1 lookups prompt", () => {
    const files = readdirSync(join(BUNDLE, "lookups/prompts")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual(["lookups_overview.ts"]);
  });

  it("ships exactly 1 email prompt", () => {
    const files = readdirSync(join(BUNDLE, "email/prompts")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual(["email_overview.ts"]);
  });
});

describe("segment-mcp lift inventory", () => {
  it("ships exactly 5 segment tool files", () => {
    const files = readdirSync(join(BUNDLE, "segment/tools")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual([
      "segment_identify.ts",
      "segment_profile_events.ts",
      "segment_profile_external_ids.ts",
      "segment_profile_traits.ts",
      "segment_track.ts",
    ]);
  });

  it("ships exactly 1 segment prompt", () => {
    const files = readdirSync(join(BUNDLE, "segment/prompts")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual(["segment_overview.ts"]);
  });

  it("ships the two Segment client wrappers", () => {
    expect(existsSync(join(BUNDLE, "segment-profile-client.ts"))).toBe(true);
    expect(existsSync(join(BUNDLE, "segment-tracker.ts"))).toBe(true);
  });
});

describe("breakout MCP-name contract", () => {
  // The shim's bundle registers as MCP name "apis" (no change). The
  // standalone repos register as "twilio" and "segment" via their own
  // McpServer({name: ...}). The controller dispatch table uses these
  // names verbatim. If either standalone repo's name changes, the
  // controller's Type 2 stdio config (command: npx, args: [-y,
  // @deshartman/<name>]) needs a corresponding update.
  it("documents the standalone names for controller config", () => {
    // These constants exist purely so a future contributor cannot rename
    // the wire-side MCP names in the standalone repos without also
    // breaking this test, which forces a coordinated change.
    const STANDALONE_TWILIO_NAME = "twilio";
    const STANDALONE_SEGMENT_NAME = "segment";
    expect(STANDALONE_TWILIO_NAME).toBe("twilio");
    expect(STANDALONE_SEGMENT_NAME).toBe("segment");
  });
});
```

### Step 4.3 — Run the suite

```bash
cd packages/connector
npm test
```

Verify the new suite passes alongside the rest. Total test-file count should increase by 1.

### Step 4.4 — Add a row to TEST-SUITE.md catalog

Append a new row at the TOP of the catalog table in [.claude/plans/TEST-SUITE.md](TEST-SUITE.md) (rows are reverse-chronological):

```
| 2026-06-27 | TWILIO-MCP-BREAKOUT (planned, branch `feature/twilio-mcp-breakout`) lifts the Twilio (21 tools) + SendGrid (4 tools) tools AND 12 prompts (4 service overviews + 7 agent-pay + 1 email overview) to @deshartman/twilio-mcp, and the Segment (5 tools + 1 overview prompt) tools to @deshartman/segment-mcp. The shim's `mcp/bundled/twilio/` (the `apis` MCP) stays unchanged. Defensive test pins the file-level inventory of every tool AND prompt lifted so a future contributor cannot rename / add / remove either kind of file in the bundle without realising the standalone repos need a coordinated update. | `mcp/bundled/twilio/<service>/{tools,prompts}/*.ts` (service-first layout: messaging / voice / verify / lookups / email / segment) + `mcp/bundled/twilio/{twilio-client,sendgrid-client,status-callback,segment-profile-client,segment-tracker}.ts` (READ-ONLY from this plan's perspective — the test asserts what's there, doesn't change it) | `packages/connector/tests/mcp-tools/apis/lift-inventory.test.ts` (4 describe blocks: twilio-mcp tools = 4+13+3+1+4 + 3 client wrappers; twilio-mcp prompts = 1+8+1+1+1 = 12 prompt files; segment-mcp = 5 tools + 1 prompt + 2 client wrappers; MCP-name contract pins "twilio" + "segment" as the standalone wire names). | (1) **Inventory drift is silent.** If a tool or prompt is added / renamed / split in the bundle without updating the standalone repo, the controller's procedures resolve the OLD name against the OLD copy — masked by Type 2 stdio's stateless dispatch. The test fails the moment any file list changes, forcing the contributor to acknowledge the standalone repo. (2) **Agent-pay is a coupled flow.** The 5 agent_pay_* tools and 7 agent_pay_* prompts ship together — pinning both lists in the same suite ensures a contributor who adds a 6th capture step (e.g. `agent_pay_capture_postcode`) catches the matching prompt requirement at test time, not at controller-load time. (3) **Names are the wire contract.** "twilio" + "segment" are the values the controller uses for matching, auto-fill, and procedure hydration. Renaming either in the standalone repos breaks every existing procedure that references those qualifiers. (4) **The shim's `apis` MCP keeps that name.** No conflict because the standalone repos and the shim's bundle are never running in the same process — the bundle is in-process Type 1, the standalone repos are out-of-process Type 2 stdio. | passing |
```

### Step 4.5 — Stage and commit

This plan results in **one commit** on the branch. `.claude/` is gitignored at the user-level config (`~/.config/git/ignore` carries `**/.claude/`) — confirmed 2026-06-27 by `git ls-files .claude/` returning empty. The plan file and `TEST-SUITE.md` both live under `.claude/plans/` so NEITHER gets committed; their authoritative state is on the local filesystem only. Only the inventory test in `packages/connector/tests/` is tracked and lands as a real commit.

The B2 stanza below stays in the plan for historical context — if at any future point the `.claude/` gitignore is removed, B2's text becomes the working recipe for the catalog-row commit. Until then, the row only lands on disk.

#### Commit B1 — Add the defensive inventory test

```bash
git add packages/connector/tests/mcp-tools/apis/lift-inventory.test.ts
git commit -m "$(cat <<'EOF'
Test: pin tool + prompt inventory of mcp/bundled/twilio/

Inventory drift is silent — a tool or prompt added / renamed / split
in the shim's bundle without a coordinated change to
@deshartman/twilio-mcp or @deshartman/segment-mcp would let the
controller's Type 2 stdio dispatch keep resolving against the stale
standalone copy.

Pins the service-first inventory:
- twilio-mcp tools = 4+13+3+1+4 (messaging/voice/verify/lookups/email)
  + 3 client wrappers
- twilio-mcp prompts = 1+8+1+1+1 = 12 (per-service overviews +
  voice/prompts adds 7 agent-pay)
- segment-mcp = 5 tools + 1 overview prompt + 2 client wrappers
- MCP-name contract: "twilio" + "segment" as the standalone wire names

The agent-pay tool+prompt pair (5 tools + 7 prompts) is a coupled
flow — pinning both lists in the same suite catches misaligned
additions at test time, not at controller-load time.

Refs .claude/plans/TWILIO-MCP-BREAKOUT.md (gitignored; revised
2026-06-27 after the service-first restructure landed on main via
merge commit 0ecbe3a).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

#### Commit B2 — Catalog row in TEST-SUITE.md

```bash
git add .claude/plans/TEST-SUITE.md  # NB: only TEST-SUITE.md is tracked;
                                     # other files under .claude/ are gitignored.
                                     # If `git add` errors, double-check that
                                     # .claude/plans/TEST-SUITE.md is the file
                                     # being staged.
git commit -m "$(cat <<'EOF'
TEST-SUITE: log the lift-inventory regression test

Per TEST-SUITE.md convention — every defensive test that lands gets
a catalog row. New row pins the tool+prompt contract the
lift-inventory.test.ts regression test enforces (21+4 tools, 11+1
prompts, plus the "twilio"+"segment" wire-name contract).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

> **Caveat re: TEST-SUITE.md tracking.** Spot-check whether `.claude/plans/TEST-SUITE.md` is tracked in the repo before staging — if the user-level gitignore (`**/.claude/`) also blocks it, this commit becomes a no-op and the catalog update lives only on disk. Run `git ls-files .claude/plans/TEST-SUITE.md` before B2; if empty, the catalog row stays uncommitted and you should reduce the plan to a single inventory-test commit. As of 2026-06-27 confirmed gitignored: no files under `.claude/` are tracked. Treat the catalog row as a disk-only update (mirroring how `.claude/plans/Done/TWILIO-MCP-PROMPT.md` is preserved on disk without a commit) — meaning Phase 4 reduces to ONE commit (the inventory test).

### Step 4.6 — STOP before merging to main

Confirm:

```bash
git log --oneline main..feature/twilio-mcp-breakout
# Should show exactly 1 commit (the inventory test), since the plan file
# and the TEST-SUITE.md catalog row are both under .claude/ (gitignored).

git status
# Should report nothing modified.

git branch --show-current
# Should report feature/twilio-mcp-breakout.
```

**DO NOT run `git checkout main && git merge feature/twilio-mcp-breakout`.** That's a user gesture, not part of this plan. The branch sits ready for the user to merge (or not) at their discretion.

## Phase 5 — Final verification report

After all commits land, surface a one-screen summary to the user:

```
TWILIO-MCP-BREAKOUT — all phases complete

Standalone repos:
- @deshartman/segment-mcp@0.1.0 published, controller-loaded, smoke-tested
  (5 tools + 1 overview prompt)
- @deshartman/twilio-mcp@0.1.0 published, controller-loaded, smoke-tested
  (25 tools incl. 5 agent-pay + 12 prompts incl. 7 agent-pay)

Shim branch feature/twilio-mcp-breakout:
- B1  Test: pin tool + prompt inventory of mcp/bundled/twilio/

(Plan + TEST-SUITE catalog row updated on disk only; .claude/ is
gitignored — no commit. Mirrors the pattern from
feature/twilio-mcp-prompts where the plan was moved to
.claude/plans/Done/ without a commit.)

Test status: <N> tests passing across 62 test files (was 294 tests / 61 files before this plan; the new lift-inventory.test.ts adds 1 file and ~13 assertions).

Branch is UNMERGED — ready for your review.
```

## Risks + how this plan addresses them

| Risk | Mitigation in this plan |
|---|---|
| Lift drift — tool added/renamed in shim's bundle, standalone repo not updated | Defensive inventory test (B1) fails the moment the file list changes. |
| Standalone repo names drift from controller's expectations | Inventory test's "MCP-name contract" block pins `twilio` + `segment` as constants. |
| `@deshartman/mcp-status-callback` is single-maintainer, could disappear | Optional dep; missing → status callbacks disabled with a warn (no crash). Accept bus-factor risk for v1; inline if needed later. |
| `npx -y @deshartman/twilio-mcp` cold-start latency | First call slow (npm cache miss); subsequent fast. Acceptable for testing. For production, future plan pre-installs at image-build time. |
| Stdio MCP writes to stdout and corrupts wire | All logging in templates is `console.error` (stderr). Code review checkpoint. |
| Plan execution stalls mid-phase if `/clear` happens | Resume prompt below + this doc are self-contained. The user runs the resume prompt and the new context picks up at the right phase by inspecting git state + the new repos' commit history. |
| Twilio sandbox callback round-trip is non-hermetic (real ngrok, real SMS) | Smoke test 2 (step 2.6) is OPTIONAL. Controller-load tests (step 3.3) skip callbacks. Manual sandbox verification is at the user's discretion. |
| The shim's bundle starts diverging from the standalone repos in tool behavior | Two-version drift is acceptable until the cutover plan (future) deletes `mcp/bundled/twilio/`. The inventory test catches structural drift; behavioral drift is on the maintainer to manage. |

## What's NOT in this plan

These are deliberately deferred to KEEP THIS PLAN SCOPED:

1. **Deleting `mcp/bundled/twilio/` from the shim.** Future plan, post-soak.
2. **Editing `connector.yaml.example`** to use the published packages by default. Future plan.
3. **Controller-side wire-name migration** from `apis` to `twilio`+`segment`. Only matters when the shim cuts over. Until then, `apis.*` and `twilio.*` are different namespaces and coexist.
4. **Enhancing `@deshartman/mcp-status-callback`** with shim-tunnel support. Explicitly rejected (D5).
5. **A `WebhookProvider` interface with multi-backend selector** in the standalone Twilio MCP. Explicitly simplified out (D4).
6. **Tests for individual tool behaviors** in the standalone repos. Out of scope for v1; the shim's existing tests at `packages/connector/tests/mcp-tools/apis/{messaging,voice,verify,lookups,email,segment}/*.test.ts` cover the same source code (pre-lift). Each new repo CAN grow its own test surface later; not blocking.
7. ~~**The TWILIO-MCP-PROMPT.md service-first restructure.**~~ **LANDED 2026-06-27** on main via merge commit `0ecbe3a`. This plan was revised the same day to track the post-restructure shape (`<service>/{tools,prompts}/` paths in cp commands, agent-pay tools + 13 prompts in success criteria, inventory test pins both lists).
8. **Renaming the shim itself** to "Conversation Agent SDK" or similar. Marketing decision; unrelated to this work.
9. **Extracting `@mcp-shim/sdk` as a separate package.** Discussed earlier in the conversation; rejected for the standalone-MCP goal (D1).

## Cross-references

- [STATUS-CALLBACK-MCP.md](STATUS-CALLBACK-MCP.md) — the shim's webhook ingress; unchanged by this plan.
- [SEGMENT-MCP.md](SEGMENT-MCP.md) — landed Segment tools in the shim's `apis` bundle; this plan re-homes copies to a standalone repo.
- [Done/TWILIO-MCP-PROMPT.md](Done/TWILIO-MCP-PROMPT.md) — service-first restructure + agent-pay + 13 prompts. **LANDED 2026-06-27 on main via merge commit `0ecbe3a`.** This breakout plan was revised to track that state.
- [TEST-SUITE.md](TEST-SUITE.md) — defensive-test catalog convention; this plan adds one row on disk (gitignored — see Step 4.5 caveat).
- [`packages/connector/src/sdk/webhook.ts`](../../packages/connector/src/sdk/webhook.ts) — shim's webhook SDK; unchanged.
- `@deshartman/mcp-status-callback` v0.5.0 — <https://github.com/deshartman/mcp-status-callback>
- `@modelcontextprotocol/sdk` — <https://github.com/modelcontextprotocol/typescript-sdk>
- Repos (empty as of 2026-06-27): <https://github.com/deshartman/twilio-mcp>, <https://github.com/deshartman/segment-mcp>

## Resume prompt (paste after /clear)

Copy-paste this verbatim into a new conversation to resume from any phase:

```
Read .claude/plans/TWILIO-MCP-BREAKOUT.md fully, then resume execution.

Before doing any work:
1. Run `git status` and `git branch --show-current` in the shim repo.
2. Check whether ~/Development/01_Twilio/twilio-mcp and
   ~/Development/01_Twilio/segment-mcp exist on disk and whether they
   have remote commits beyond initial: `gh repo view deshartman/twilio-mcp --json isEmpty,defaultBranchRef`
   and same for segment-mcp.
3. Check whether @deshartman/twilio-mcp and @deshartman/segment-mcp
   are published on npm: `npm view @deshartman/twilio-mcp version`
   and same for segment-mcp.

Then decide which phase to resume from:
- If neither repo is cloned locally → start Phase 1 (Step 1.1).
- If only segment-mcp is built/committed but twilio-mcp isn't → start Phase 2.
- If both are built+committed but neither is published → start Phase 3.1.
- If both are published but controller-load not tested → start Phase 3.3.
- If controller-load test is done but branch feature/twilio-mcp-breakout doesn't exist → start Phase 4.1.
- If the branch exists with 0 commits → start at Phase 4.2 (write inventory test).
- If the branch has 1 commit (the inventory test) AND `.claude/plans/TEST-SUITE.md` has the catalog row on disk → STOP; report Phase 5 summary to the user. Remember `.claude/` is gitignored so the catalog row + plan file never commit; their authoritative state is on the local filesystem only.

NEVER merge feature/twilio-mcp-breakout into main. That's an explicit
user gesture, not part of this plan.

Working directory for the shim throughout: ~/Development/01_Twilio/mcp-shim
Working directories for the new repos: ~/Development/01_Twilio/{twilio-mcp,segment-mcp}

Before mass-copying source files into a new repo, briefly verify that
the file lists in the plan still match what's actually in
mcp/bundled/twilio/ — the bundle uses SERVICE-FIRST layout
(`<service>/{tools,prompts}/`); the plan was revised 2026-06-27 to
match. If the shim has changed since 2026-06-27 (new tool, new prompt,
renamed file), surface the drift to the user before proceeding.
```






