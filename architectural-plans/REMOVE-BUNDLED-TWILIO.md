# Remove the bundled Twilio MCP

> **Status: TODO.** Drafted 2026-06-30. The bundle has been parked (yaml-commented-out) since 2026-06-27 and the user has confirmed production-tested replacement via the standalone `@deshartman/twilio-mcp` + `@deshartman/segment-mcp` packages loaded through the controller's "New 3rd Party MCP" flow. Time to delete.

## How to execute (read first)

Self-contained. `/clear` → read this → execute end-to-end. Decisions pinned at the bottom.

**Prereqs.**
- Clean working tree on `main`.
- The standalone path is live and verified (user-confirmed 2026-06-30).
- The MCP-TOOL-TITLE.md sibling-repo backport plan is unchanged by this deletion — its 30 standalone-MCP edits become MORE valuable, not less.

**Branch setup.**
```bash
git checkout main
git checkout -b cleanup/remove-bundled-twilio
```
Single branch, three commits. Local-only.

**After merge, rebase `feature/tool-titles` onto new main.** The 30 file edits in commit `43bfc6f` that target `mcp/bundled/twilio/**/*.ts` will conflict with deleted files; resolve by accepting deletion (`git rm`). The wire-format change in `frames.ts` + `servers/index.ts` and the 4 sample-tool titles survive cleanly. Net effect: `feature/tool-titles` becomes a smaller branch covering only what's still meaningful.

## What to delete

**On-disk:**
- `mcp/bundled/twilio/` — entire 31M tree (source + per-folder `node_modules`)
- `packages/connector/tests/mcp-tools/` — 33 test files, 136K
- The commented-out `apis` block in `packages/connector/connector.yaml` (lines ~60-62)
- The matching commented-out block in `packages/connector/connector.yaml.example`

**Code touch-ups:**
- [packages/connector/src/config.ts:140-149](packages/connector/src/config.ts#L140-L149) — `authorOf()` keeps the Type 3 `bundled:` branch (still needed for `enterprise-knowledge`), drop the `dir: → mcp/bundled/` classifier branch. Update the doc-comment above the function.
- [packages/connector/src/sdk/http-server.ts:70](packages/connector/src/sdk/http-server.ts#L70) — comment names `mcp/bundled/twilio/` as the live example of a creds-gated MCP. Replace with a generic phrasing like "a creds-gated MCP awaiting env over the wire". The empty-tools handler logic stays — still load-bearing for other creds-gated paths.
- `packages/connector/Dockerfile` — the `mcp/bundled/*/` npm-install loop stays (still applies if a future bundle ships Node deps); update line ~46 comment that specifically names twilio.

**Docs:**
- `CLAUDE.md` — flip the bundle from live to deleted. Sections affected:
  1. **"Topology — one connector, many MCPs"** (line ~13): rewrite to "mcp/bundled/ today carries only enterprise-knowledge (Type 3); Twilio and Segment are loaded as Type 2 via the controller UI from the standalone @deshartman/twilio-mcp + @deshartman/segment-mcp npm packages."
  2. **Tool inventory paragraph** (line ~16): drop the Twilio + Segment tool lists. Keep sample + crm + aviation-weather + enterprise-knowledge.
  3. **Re-folded-from-sibling paragraph** (line ~18): delete entirely. Replace with one sentence saying the standalone packages are the deployment shape today.
  4. **"Type 1 hand-written shape"** (line ~26): rewrite the trailing sentence — the legacy shape no longer has any live example in-repo. Either delete the legacy-shape paragraph or rephrase to "kept for customers who need a hand-written `server.ts` for a third-party-SDK MCP".
  5. **`mcp/bundled/twilio` bullet** (line ~130): delete entirely.
  6. **Per-folder package.json hoist rule** (line ~112): the "live example" reference to `mcp/bundled/twilio/` becomes stale — replace with a hypothetical phrasing.
  7. **`ServerDescriptor.author`** (line ~99): the rule still derives `"twilio"` from `bundled:` (covers Type 3 today, future Type 1 Twilio bundles if any). Drop the `dir:` portion of the rule to match the `config.ts` simplification.
  8. **Dockerfile build-stage paragraph** (line ~285): drop the "Today only mcp/bundled/twilio/ matches" sentence; no folder today carries Node deps, so the loop runs to no-op.
- `docs/MCP-PROTOCOL.md`:
  - Lines ~250-252 ("Status: live for mcp/bundled/twilio/ only..."): the per-MCP creds-response posture is now controller-wide for the active 3rd-party MCPs. Rewrite to reflect that.
  - Line ~1139 (the auth-flow table row "Bundled Type 1 hand-written"): delete the row.
- `docs/AUTHOR-LOCAL-MCP.md:228` ("The Twilio bundle ... is the live example"): replace with a hypothetical "if you ship a Type 1 with a third-party SDK..." example or drop the sentence.

## What stays (do NOT delete)

- `mcp/bundled/enterprise-knowledge/` — Type 3 stub, still active.
- `mcp/bundled/` folder itself — still carries `enterprise-knowledge`.
- `BUNDLED_MCPS` registry in `config.ts` — still resolves Type 3 entries.
- `authorOf()`'s Type 3 branch (`if (spec.transport === "stdio" && spec.bundled) return "twilio";`) — still classifies enterprise-knowledge correctly.
- The wire-format `title?: string` from commit `43bfc6f` — connector infrastructure, not twilio-specific.
- The 4 sample drop-in titles (`now`, `slow_echo`, `uuid`, `weather`).
- [.claude/plans/MCP-TOOL-TITLE.md](MCP-TOOL-TITLE.md) — the sibling-repo backport plan.

## Three-commit shape

**Commit 1: Delete the bundle source + tests.**
```bash
git rm -r mcp/bundled/twilio packages/connector/tests/mcp-tools
# Edit connector.yaml + connector.yaml.example to drop the commented-out apis blocks.
git add packages/connector/connector.yaml packages/connector/connector.yaml.example
```
Message: `Remove bundled Twilio MCP — superseded by standalone @deshartman packages via controller UI`

**Commit 2: Code touch-ups.**
- `config.ts` `authorOf()` simplification (Type 3 branch stays, `dir:` branch goes).
- `http-server.ts` line 70 comment generic-ification.
- `Dockerfile` line ~46 comment update.

Message: `Drop bundled-twilio classifier branches now that the bundle is gone`

**Commit 3: Docs.**
- `CLAUDE.md` — sections 1–8 above.
- `docs/MCP-PROTOCOL.md` — lines 250-252 + 1139.
- `docs/AUTHOR-LOCAL-MCP.md:228`.

Message: `Docs: bundled-twilio removed; standalone @deshartman packages are the deployment shape`

## Verify after each commit

```bash
cd packages/connector
npx tsc --noEmit    # typecheck clean
npm test            # vitest passes (with mcp-tools tests gone)
```

Expect test count to drop from 319 → ~280 (the 33 mcp-tools files contributed ~30 tests; lift-inventory contributes more). Don't panic at the lower number.

Boot smoke (optional): `./scripts/start-connector.sh` should still launch — yaml only references enterprise-knowledge today. Inspector at `localhost:9090` should show no twilio MCP and (when wired in the controller UI) the standalone `@deshartman/twilio-mcp` as a Type 2 controller-config entry.

## Branch wrap-up

1. Final `npm test` clean.
2. Squash-or-not — per the user's preference, this is small enough for three discrete commits; don't squash.
3. Merge with `--no-ff` into main:
   ```bash
   git checkout main && git merge --no-ff cleanup/remove-bundled-twilio
   ```
4. Don't push.
5. After main moves, rebase `feature/tool-titles`:
   ```bash
   git checkout feature/tool-titles
   git rebase main
   ```
   For each `mcp/bundled/twilio/**/*.ts` conflict: `git rm <file>` and `git rebase --continue`. The wire-format edits + sample-tool titles + this plan all carry through cleanly.

## Decisions log

1. **Delete the test tree too.** The 30 per-tool tests are regression coverage of MCPs that no longer ship from this repo. Keeping them as historical reference is tempting but creates a class of test that imports from a non-existent source tree — they'll either fail or get skipped, both worse than deletion. Standalone MCPs are responsible for their own coverage.

2. **Keep `enterprise-knowledge` and the Type 3 mechanism untouched.** Type 3 is a separate path from the now-removed Type 1 bundle. The folder, the `BUNDLED_MCPS` registry, the Dockerfile install loop, and the `authorOf()` Type 3 branch all stay.

3. **`mcp/bundled/` folder itself stays.** Enterprise-knowledge still lives there. Future Twilio-shipped bundles (if any reappear) can also land there — folder convention is still meaningful.

4. **`authorOf()` keeps returning `"twilio"` from Type 3 bundle entries.** Enterprise-knowledge is Twilio-authored. Don't widen the controller-side semantics by renaming.

5. **No yaml flag, no rollback path.** The user has confirmed production-tested replacement; the commented-out yaml entry is what made the prior parking phase rollback-able, and that's getting deleted too. If a true emergency revert is needed: `git revert` the three commits.

6. **Three commits, not one.** Source deletion + code touch-ups + docs are conceptually distinct. Three commits keep `git blame` honest if any one piece needs reverting later.

7. **Update CLAUDE.md + docs in commit 3, not as a follow-up.** Per the project rule "Docs update before merge" — the docs commit is the last commit before the merge, not a follow-up after.

8. **Rebase, don't merge, when reconciling `feature/tool-titles`.** A merge would preserve the dead-tool-title commit in history; a rebase collapses it to its useful subset (the wire format + sample titles). Cleaner history.

## Risk / rollback

- **Risk:** A tool name from the deleted Twilio bundle (e.g. `messages_create`) is referenced in a controller-side procedure that uses the in-connector qualifier (e.g. `{{ tool:apis.messages_create }}`). After deletion, the standalone npm packages expose those tools under a DIFFERENT qualifier (the controller-UI-assigned server name, not `apis`). Procedures that hardcoded `apis.*` break.
- **Check before merging:** verify with the user that no live procedures reference the `apis.*` qualifier. If they do, those procedures need a one-time rename pass against the new qualifier (operator-assigned in the controller UI).
- **Rollback:** `git revert` the three commits. The bundle source is fully recoverable from git history.
