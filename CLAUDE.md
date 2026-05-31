# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

This is a **proof-of-concept** validating the architecture in [docs/procedure-agent-architecture.md](docs/procedure-agent-architecture.md), specifically the "shim-side procedure graph execution" variant from that doc's Future Considerations section: each procedure agent runs **in-process inside its MCP shim**, not in the cloud.

**Three runtime processes** form the demo:

```
shim-a (process)              shim-b (process)              main-server (process)
  └─ MCP server                 └─ MCP server                 ├─ HTTP server :8080
     ├─ ask_procedure              ├─ ask_procedure              ├─ MCP client per shim
     ├─ can_answer                 ├─ can_answer                 ├─ event bus → SSE
     └─ tunnel client ──────┐      └─ tunnel client ──────┐      ├─ keyword-free router
        (outbound POST)     │         (outbound POST)     │      └─ static client UI
                            └────────────────────────────►│ /tunnel
                                                                  ▲
                                                                  │ /events (SSE), /query
                                                          packages/client/index.html
```

**Boundary protocol is MCP.** Each shim exposes itself as an MCP `Server` over a custom `Transport` whose wire format is JSON-encoded frames carried as text WebSocket messages on a single outbound `wss://` connection (modelling Anthropic's MCP Tunnels). The main server is the MCP `Client`. The MCP SDK does the JSON-RPC; the tunnel is just transport. Frame types are defined in [packages/shared/src/index.ts](packages/shared/src/index.ts) and include `register`, `rpc` (opaque MCP JSON-RPC), `event`, and `token`.

**Architecturally load-bearing properties** the code is written to preserve:

- The **cloud holds no LLM credentials**. Routing is done by parallel `can_answer` MCP calls; each shim self-judges 0–100 confidence using the customer's own `OPENAI_API_KEY`. The main server picks the highest score above a threshold (`MIN_SCORE = 20` in [packages/main-server/src/router.ts](packages/main-server/src/router.ts)).
- **Documents never leave the customer environment.** The agent loop lives in [packages/shim/src/agent.ts](packages/shim/src/agent.ts) and runs inside the shim. The cloud sees only the question (in) and final answer text (out).
- **Inbound ports are zero on the shim side.** The shim dials out; the main server pushes RPC requests back down the same connection the shim opened.

**Demo-only side channels** that violate the production posture but make the architecture visible to a demo audience: `event` frames (shim self-reports its internal log lines), `token` frames (live answer streaming via SSE), `doc-change-*` frames (UI Change-document button toggles step 1 of a procedure between two YAML-defined variants). All of these are clearly marked "Demo-only" in code comments. **Do not introduce new patterns that route document content or LLM traces through the main server.**

## Routing flow

When a `POST /query` arrives at the main server:

1. [router.ts](packages/main-server/src/router.ts) calls `can_answer` on every connected shim **in parallel** via its MCP client.
2. Each shim's `can_answer` handler runs `judgeQuery` in [agent.ts](packages/shim/src/agent.ts) — a tight LLM call that returns an integer 0-100.
3. Highest score wins; below `MIN_SCORE` returns 503 "no shim matched."
4. The chosen shim's `ask_procedure` is invoked; tokens stream back via the demo-only `token` frames into the SSE stream the browser is listening on.

The **router is deterministic on the cloud side** (no LLM call there). All LLM work happens inside shims.

## Workspaces

npm workspaces, three packages, all under `packages/*`:

- **`@mcp-shim/shared`** — types only (frames, UI payloads). No runtime deps.
- **`@mcp-shim/shim`** — the per-customer process. Reads YAML config + `.env`, makes an MCP Server, runs the agent.
- **`@mcp-shim/main-server`** — the cloud-side process. Accepts shim tunnels, serves the demo UI, runs the parallel router.
- **`@mcp-shim/client`** — single static `index.html` + `app.js`. Served by main-server at `/`. Not a TS package.

`packages/shim/src/adapters/index.ts` defines the `SourceAdapter` interface and an `ADAPTERS` map. Only `filesystem` is implemented; the rest of the YAML schema (`confluence`, `sharepoint`, `http`, etc) is shape-only. New adapters plug in here without changing the shim or main-server.

## Common commands

```bash
# Install (npm workspaces) + build (composite TS project refs)
npm install
npm run build

# Run all three processes (main + 2 shims) — requires .env files (see below)
./scripts/run-demo.sh

# Run individual processes
npm run main          # main-server only
npm run shim          # shim only — needs SHIM_CONFIG, OPENAI_API_KEY, MAIN_SERVER_URL in env

# Open the demo UI
open http://localhost:8080/
```

There are **no tests** in the repo. The verification path is interactive: open the UI, submit queries, watch the panels. The `/registry` endpoint shows currently-connected shims as JSON; the `/events` SSE endpoint is the source-of-truth for what the UI sees.

## Environment files

The shim and main server each load their own `.env` (gitignored). Templates live alongside as `.env.example`:

| Process       | File                                       | Required vars |
|---------------|--------------------------------------------|---------------|
| main-server   | `packages/main-server/.env`                | `PORT` (optional, defaults to 8080) — **no LLM key, by design** |
| shim-a        | `packages/shim/config/shim-a.env`          | `OPENAI_API_KEY`, `OPENAI_MODEL`, `SHIM_CONFIG=config/shim-a.yaml`, `MAIN_SERVER_URL` |
| shim-b        | `packages/shim/config/shim-b.env`          | same vars, with `shim-b.yaml` |

`SHIM_CONFIG` paths are **relative to `packages/shim/`** because [run-demo.sh](scripts/run-demo.sh) `cd`s there before exec.

## OpenAI client details that bit before

When calling `openai.chat.completions.create` against `gpt-5.x` models (e.g. `gpt-5.4-mini`):

- Use `max_completion_tokens`, **not** `max_tokens` (HTTP 400 otherwise).
- Do **not** set `temperature` (only the default value is accepted).

The legacy parameter names work for older models but break newer ones; the project standardizes on the new names. See [packages/shim/src/agent.ts](packages/shim/src/agent.ts) `judgeQuery`.

## Tunnel timeout

The tunnel is a WebSocket and isn't subject to HTTP request timeouts. The SSE `/events` stream still rides a long-lived HTTP response, so the main server keeps `requestTimeout`, `headersTimeout`, and `keepAliveTimeout` disabled near the bottom of [packages/main-server/src/index.ts](packages/main-server/src/index.ts). Don't reintroduce defaults.

Fly's HTTP edge will eventually drop idle WebSockets. Demo posture is to restart the Fly machine before each demo run via `flyctl machine restart` — see [scripts/run-demo.sh](scripts/run-demo.sh) `local-ui` mode.

## Procedure-document variants

Each shim's YAML has a `variants:` block with `original` and `alternate` versions of step 1. The `Change document` UI button (visible only in the `?view=shim` tab served by `local-server`) calls `POST /docs/:shim/:source/change` on local-server, which writes the file directly on disk. The shim's `FilesystemAdapter` re-reads the file on every `fetch()` (see [packages/shim/src/adapters/filesystem.ts](packages/shim/src/adapters/filesystem.ts)) so the next query picks up the new content with no re-indexing — and **no tunnel round-trip**. The cloud is not involved.

## Process lifecycle gotcha

The demo script spawns two shim children. `pkill -f 'node dist/index.js'` only catches the node processes — orphan `bash run-demo.sh` parents will respawn shims. Use `pkill -f 'run-demo.sh'` first when cleaning up, or you'll see ghost shims connect on restart and confuse routing/registry state.
