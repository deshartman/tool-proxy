# MCP Tool Titles — sibling-repo backport

> **Status: TODO.** This connector landed `feature/tool-titles` (commit `43bfc6f`) on 2026-06-30. This plan backports the per-tool `title:` additions into the two sibling standalone MCP projects so their tools surface the same human-readable labels.

## How to execute this plan (read first)

This plan is self-contained — a fresh agent should be able to `/clear`, read it, and execute end-to-end without re-asking the user. Decisions are pinned in the "Decisions log" at the bottom; do NOT re-litigate them.

**Scope.** Two standalone Node + stdio MCP projects that live outside this repo:

- **`/Users/dhartman/Development/01_Twilio/twilio-mcp-servers/twilio-mcp`** — 25 tools (messaging × 4, voice × 11, verify × 3, lookups × 1, email × 4, agent-pay × 5, voice-twiml × 4 — wait, count is 25 tools total).
- **`/Users/dhartman/Development/01_Twilio/twilio-mcp-servers/segment-mcp`** — 5 tools.

Total: **30 tool files** to edit. Same names and shapes as the in-repo `mcp/bundled/twilio/` tools — these projects are the standalone, npm-publishable forks that were re-folded back into this repo as `mcp/bundled/twilio/` on `feature/twilio-mcp-breakout`. The two trees have stayed shape-compatible.

**Critically different from the in-repo work.** These projects are **stdio-only standalone MCPs** — they speak raw MCP, not the connector wire format. There is **NO** `ToolDescriptor` / `DiscoveredTool` / `toDescriptor` projection to update. The MCP SDK's top-level `title` field flows from the `registerTool` metadata straight onto the wire via the SDK's own `tools/list` handler. The plan reduces to: add `title:` to each `registerTool` metadata block, rebuild `dist/`, smoke-test, commit.

**Prerequisites.**
- Confirm clean working trees in BOTH projects:
  ```bash
  cd /Users/dhartman/Development/01_Twilio/twilio-mcp-servers/twilio-mcp && git status
  cd /Users/dhartman/Development/01_Twilio/twilio-mcp-servers/segment-mcp && git status
  ```
- Pre-flight build in each:
  ```bash
  npm install && npm run build   # exits clean
  ```
  Each project's `prepare` script aliases to `npm run build`, so `npm install` triggers the build for free.

**Branch setup.** One branch per project (they're separate git repos):

```bash
cd /Users/dhartman/Development/01_Twilio/twilio-mcp-servers/twilio-mcp
git checkout -b feature/tool-titles

cd /Users/dhartman/Development/01_Twilio/twilio-mcp-servers/segment-mcp
git checkout -b feature/tool-titles
```

Feature branches stay local in BOTH repos. Don't push.

## Reference — what landed on this connector

Commit `43bfc6f` on `feature/tool-titles` of `mcp-shim`. Two distinct layers:

1. **Wire-format change** (`packages/connector/src/tunnel/frames.ts` + `packages/connector/src/servers/index.ts`) — adds `title?: string` to `ToolDescriptor`, reads `tool.title ?? tool.annotations?.title` from the upstream MCP `tools/list` response, forwards through `stripUndefined` so the manifest only carries the field when set. **NOT applicable to the sibling projects** — they don't have this projection layer.
2. **Per-tool source change** — 34 in-repo tool files grew a `title:` line in their `registerTool` metadata, alongside `description` / `inputSchema` / `outputSchema`. **This is the part to backport.**

The MCP spec (mid-2025 schema) puts `title` at the top level of the Tool object (the `annotations.title` from the older spec is a deprecated fallback). `server.registerTool(name, {title, description, …}, handler)` writes it to the right place — the SDK has supported this since `@modelcontextprotocol/sdk` 1.x.

## Step 1 — Edit twilio-mcp (25 tools)

Per file: add `title: "<label>",` as the FIRST entry inside the metadata object passed to `registerTool` (i.e. directly after the opening `{`, before `description:`). Match the in-repo wording exactly so the customer-facing labels are consistent across the standalone bundle and the in-connector bundle.

**Tool → title map** (copy verbatim):

| File (under `src/tools/`)          | Title                          |
|------------------------------------|--------------------------------|
| `messages_create.ts`               | `Send SMS / WhatsApp / RCS`    |
| `messages_fetch.ts`                | `Fetch Message Status`         |
| `messaging_services_fetch.ts`      | `Fetch Messaging Service`      |
| `content_templates_fetch.ts`       | `Fetch Content Template`       |
| `calls_create.ts`                  | `Place Outbound Call`          |
| `calls_fetch.ts`                   | `Fetch Call Status`            |
| `voice_say.ts`                     | `Build <Say> TwiML`            |
| `voice_play.ts`                    | `Build <Play> TwiML`           |
| `voice_dial.ts`                    | `Build <Dial> TwiML`           |
| `voice_pay.ts`                     | `Build <Pay> TwiML`            |
| `voice_transcription_start.ts`     | `Start Call Transcription`     |
| `voice_transcription_stop.ts`      | `Stop Call Transcription`      |
| `agent_pay_start.ts`               | `Start Agent-Assisted Payment` |
| `agent_pay_capture_card.ts`        | `Capture Card Number`          |
| `agent_pay_capture_exp.ts`         | `Capture Expiration Date`      |
| `agent_pay_capture_cvc.ts`         | `Capture Security Code (CVC)`  |
| `agent_pay_complete.ts`            | `Complete Agent Payment`       |
| `verify_send.ts`                   | `Send Verification Code (OTP)` |
| `verify_check.ts`                  | `Check Verification Code (OTP)`|
| `verify_services_fetch.ts`         | `Fetch Verify Service`         |
| `lookups_fetch.ts`                 | `Look Up Phone Number`         |
| `email_send.ts`                    | `Send Email`                   |
| `email_fetch.ts`                   | `Fetch Email Activity`         |
| `email_search.ts`                  | `Search Email Activity`        |
| `email_templates_fetch.ts`         | `Fetch Email Templates`        |

**Edit pattern** — every file looks like this before:

```ts
server.registerTool(
  "messages_create",
  {
    description:
      "Send a message via SMS, WhatsApp, or RCS. ...",
    inputSchema: { ... },
    outputSchema: OutputSchema,
  },
  async ({ ... }) => { ... },
);
```

After:

```ts
server.registerTool(
  "messages_create",
  {
    title: "Send SMS / WhatsApp / RCS",
    description:
      "Send a message via SMS, WhatsApp, or RCS. ...",
    inputSchema: { ... },
    outputSchema: OutputSchema,
  },
  async ({ ... }) => { ... },
);
```

Always insert `title:` as the FIRST property inside the metadata object — keeps the diff a single-line addition.

### Step 1a — Verify

```bash
cd /Users/dhartman/Development/01_Twilio/twilio-mcp-servers/twilio-mcp
# Expect 25 matches, one per tool file:
grep -rn "title:" src/tools | wc -l
# Confirm none missed:
for f in src/tools/*.ts; do grep -q "title:" "$f" || echo "MISSING: $f"; done
# Build clean:
npm run build
```

The build is the test — no test runner is configured for these projects (see twilio-mcp `CLAUDE.md` §"Commands"). If `tsc` is happy and `dist/index.js` rebuilds, you're done.

### Step 1b — Optional manual smoke

```bash
node dist/index.js     # interactive — Ctrl-D to exit. Errors at boot mean broken metadata.
```

Or wire into Claude Desktop / Cursor per the project's `README.md` and confirm the host's tool picker shows the human titles.

### Step 1c — Commit

```bash
git add -A
git commit -m "$(cat <<'EOF'
Feature: surface human-readable titles on every tool

Every tool grows a `title:` line in its registerTool metadata
(alongside name / description / inputSchema / outputSchema). The
MCP SDK forwards the field through tools/list, so MCP hosts can
render a friendly display label while keeping `name` as the
stable dispatch key.

Mirrors the AgenticProcedure/mcp-shim commit 43bfc6f, which
applied the same change to the in-connector bundled twilio MCP.
Labels are identical so the standalone and in-connector
deployments stay consistent end-user-side.

EOF
)"
```

## Step 2 — Edit segment-mcp (5 tools)

Same pattern, smaller surface.

**Tool → title map** (copy verbatim):

| File (under `src/tools/`)            | Title                       |
|--------------------------------------|-----------------------------|
| `segment_identify.ts`                | `Identify Segment Profile`  |
| `segment_track.ts`                   | `Track Segment Event`       |
| `segment_profile_traits.ts`          | `Fetch Profile Traits`      |
| `segment_profile_events.ts`          | `Fetch Profile Events`      |
| `segment_profile_external_ids.ts`    | `List Profile External IDs` |

### Step 2a — Verify

```bash
cd /Users/dhartman/Development/01_Twilio/twilio-mcp-servers/segment-mcp
grep -rn "title:" src/tools | wc -l   # expect 5
for f in src/tools/*.ts; do grep -q "title:" "$f" || echo "MISSING: $f"; done
npm run build
```

### Step 2b — Commit

```bash
git add -A
git commit -m "$(cat <<'EOF'
Feature: surface human-readable titles on every tool

Every tool grows a `title:` line in its registerTool metadata.
The MCP SDK forwards the field through tools/list so hosts
render a friendly display label while keeping `name` as the
stable dispatch key.

Mirrors the AgenticProcedure/mcp-shim commit 43bfc6f.

EOF
)"
```

## Step 3 — Decision: leave or publish

Both projects publish to npm under `@deshartman/*`. After committing locally:

- **Leave** the branch local if you're holding back the npm bump — feature branches stay local per the project rule, and the in-connector bundle (`mcp/bundled/twilio/`) is what the AgenticProcedure connector ships today, so npm publishing is not load-bearing for that pipeline.
- **Publish** by merging to `main` with `--no-ff` (per the project rule), bumping the patch version in `package.json`, and `npm publish`. Only do this if there's a separate consumer of the npm package (a host using `npx @deshartman/twilio-mcp` directly).

Don't decide unilaterally — ASK the user which path. They've previously kept these on local branches; default to "commit and stop".

## Verification checklist

After both projects build clean:

- [ ] `twilio-mcp`: 25 tools have `title:` lines (`grep -rc 'title:' src/tools | grep -v ':0$' | wc -l` returns 25)
- [ ] `segment-mcp`: 5 tools have `title:` lines
- [ ] Both `npm run build` exit 0
- [ ] Both `dist/index.js` rebuilt (timestamp newer than `src/`)
- [ ] Manual smoke (optional): tool picker in Claude Desktop / Cursor renders the new titles
- [ ] Two commits made (one per repo) on `feature/tool-titles` in each
- [ ] No `node_modules/` or `dist/` files staged in either commit (these projects gitignore both — confirm with `git status`)

## Decisions log

1. **Wire-format change is in-repo only.** The standalone projects don't have a `ToolDescriptor` projection; the MCP SDK's `tools/list` handler emits `title` straight to the wire. No `frames.ts` / `servers/index.ts` analogue exists in either sibling. Don't go hunting for one.

2. **Title strings match the in-connector bundle verbatim.** The two trees stayed shape-compatible after `feature/twilio-mcp-breakout` re-folded the standalone twilio bundle into this connector. Diverging the human labels between standalone-twilio-mcp and in-connector-twilio would be a confusing customer-side inconsistency. Same labels, same precise wording.

3. **`title:` goes FIRST in the metadata object.** Keeps the diff to one inserted line per file. Don't reformat the rest of the metadata object — match the rule from this connector's CLAUDE.md "Surgical Changes": touch only what you must.

4. **No test runner — `npm run build` is the verification.** Both projects explicitly declare no test setup (see twilio-mcp `CLAUDE.md` §"Commands": *"No test runner, linter, or formatter is configured. Don't invent scripts that don't exist."*). Don't add vitest just for this change. If you want runtime verification, do the manual MCP-host smoke in Step 1b.

5. **One commit per repo, not one across both.** They're independent git repos with independent versioning and publish flow. Two branches, two commits.

6. **Don't touch prompts or resources.** This change is scoped to tools only. The MCP spec adds `title` to prompts and resources too, and both sibling projects have prompts (and one resource in the segment-mcp); leave those alone unless explicitly asked. Scope creep risk is real — the customer's question was "tool names".

7. **Don't publish to npm without an explicit ask.** Step 3 is gated on a confirmation. Default to local-branch-only, same as this connector's working pattern.

## Risk / rollback

The change is purely additive — older MCP hosts that don't render `title` will continue to show `name` (which has been the behavior up to now). Roll back by `git reset --hard <commit>^` in each project. There's no schema migration, no published-artifact contract to maintain (npm-publish is gated).

**One thing to watch.** If any of these tools have downstream consumers that introspect the `tools/list` response by string-comparing the full metadata object shape, adding a field could trip strict equality checks. Unlikely — typical consumers project specific fields — but worth a manual smoke against Claude Desktop / Cursor before declaring done.
