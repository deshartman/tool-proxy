# MCP-CLIENT-USE — extend the connector beyond `tools/*`

> **Status.** Workstreams A–E shipped 2026-06-22. Wire-format authority lives in [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) §"v1.2 — MCP server-method extension". Workstream F (sampling/elicitation) intentionally deferred — document only, behind a feature flag, ship when a real consumer exists.
> **Audience.** Connector + controller team. Customer-side wire surface, controller-side display surface, MCP-author authoring surface.
> **Scope.** Plan for wiring the rest of the MCP protocol — **prompts**, **resources** (incl. templates + subscribe), **completions**, **logging/message**, **notifications/progress**, **resources/updated** — through the connector's `/mcp-tunnel` so the Twilio bundle, Enterprise Knowledge, and customer-authored MCPs can light up everything `@modelcontextprotocol/sdk` already supports. Server-initiated **sampling** and **elicitation** are mapped but flagged as stretch.
>
> **Branch.** `feature/mcp-client-use` (cut from `main`, do not push — per memory `feature_branches_local_only.md`).
> **Worktree.** `../mcp-shim-mcp-client-use/` — a sibling git worktree of the main repo. Created with `git worktree add -b feature/mcp-client-use ../mcp-shim-mcp-client-use main`. All work happens in that worktree; the main checkout at `../mcp-shim/` keeps `main` clean for hotfixes and for any parallel plan running simultaneously.
> **Self-describing.** A fresh-context Claude reads this file + [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) + [CLAUDE.md](../../CLAUDE.md) and starts work — see §"How to resume from a fresh context" at the bottom.

## Why

Today the connector is a **tool dispatcher** end-to-end. The dispatcher in [packages/connector/src/dispatcher.ts:62-65](../../packages/connector/src/dispatcher.ts#L62-L65) is a method allowlist — `tools/list` and `tools/call` only; everything else returns `-32601 method not found`. The SDK Client instances at [packages/connector/src/servers/{http,stdio,sse,websocket}.ts](../../packages/connector/src/servers/) are constructed with `capabilities: {}` (empty), and the `McpServerConnection` shape at [packages/connector/src/servers/index.ts:25-31](../../packages/connector/src/servers/index.ts#L25-L31) only exposes `listTools()` / `callTool()`.

That's a deliberate scoping choice — the connector shipped tools first because the controller-side procedure runtime drives tool calls. But the protocol leaves a lot of leverage on the table:

- **Prompts.** A Twilio MCP could ship a `compose_compliant_sms_campaign` prompt that the controller's procedure-author UI picks up: pre-canned, parameterised, version-controlled by us — not re-invented per customer in their procedure YAML.
- **Resources.** The Twilio bundle sits on top of an enormous pool of *read-only* state — message logs, call recordings, content templates, verify services. Surfacing them as MCP resources (`twilio://messages/recent`, `twilio://content-templates`) lets the controller pull canonical context into a procedure prompt without each procedure author writing a `messages_fetch` tool call by hand.
- **Resources for Enterprise Knowledge.** The whole bundle is *built* for "named, queryable, citeable artefacts." Today it shoehorns that through `knowledge_query` (a tool that returns chunks). Modelling a registered source as `ek://sources/{source_id}` (a resource with `subscribe` so the controller learns when a refresh changed it) is closer to what MCP was designed for.
- **Logging/progress.** Long-running tools (`knowledge_query` against a large corpus, `voice_transcription_start` polling for results, an `email_search` over 90 days of mail) need progress + logging back to the controller's procedure runtime — that's `notifications/progress` and `logging/message` on the wire. Today they finish silent.
- **Completions.** When a procedure author types `{{ hydrate:apis.messages_create.from }}` in the controller UI, completions/`completion/complete` is what the spec uses to suggest valid `from` values from the live MCP. Lights up author UX without bespoke connector code per tool.

Every one of these is already supported by the upstream `@modelcontextprotocol/sdk` we depend on; the connector just doesn't speak it. This plan widens the dispatcher, adds the matching SDK author surface, extends the manifest, and lays out the controller-side display story per capability.

## Non-goals

- **No LLM in the connector core.** Adding `sampling/createMessage` would mean the connector mints model calls on behalf of MCPs. That is exactly the line CLAUDE.md "No LLM, no agent loop, no document handling — *in the connector core*" draws. We map the wire shape so the controller can implement sampling on its side (where the LLM already lives) and the connector forwards opaquely; nothing more.
- **No new trust boundary.** Same per-MCP-server gate. The connector advertises whatever the local server registered; the controller decides what to expose to procedure authors. We do NOT add per-prompt or per-resource allowlists — that was the lesson from `allow_list.tools` (CLAUDE.md "Trust boundary is per MCP server, not per tool").
- **No client-capability synthesis.** The connector is a passthrough for MCP traffic. If the controller declares `sampling: {}`, the connector forwards. The connector itself is not an MCP client to the controller.
- **No breaking change to v1.1.** Everything in this plan is additive over the [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) v1.1 contract. Older controllers ignore the new payload fields per the §"Frame envelope" unknown-frames rule.

## Current state — one-table audit

Captured from the codebase audit (2026-06-22) for orientation; full file:line references in the audit trail.

| MCP capability | Wire/dispatcher | SDK author surface | Twilio bundle | Sample / CRM | Enterprise Knowledge |
|---|---|---|---|---|---|
| `tools/list` + `tools/call` | ✓ ([dispatcher.ts:52-60](../../packages/connector/src/dispatcher.ts#L52-L60)) | `Tool` + `createMcpHttpServer({tools})` | 20 tools | sample 4 / crm 7 | tools-only |
| `prompts/list` + `prompts/get` | ✗ — dispatcher rejects | none | none | none | none |
| `resources/list` + `resources/read` + templates | ✗ | none | none | none | none |
| `resources/subscribe` + `notifications/resources/updated` | ✗ | none | none | none | none |
| `completion/complete` | ✗ | none | none | none | none |
| `logging/message` (notification, server→client) | ✗ — no inbound notification path | none | tools log via `createLogger` (connector-local Pino, never crosses the tunnel) | same | same |
| `notifications/progress` (server→client) | ✗ | none | none | none | none |
| `notifications/{tools,prompts,resources}/list_changed` | partial — tools-list_changed simulated via `manifest-delta` (creds-update path) | n/a | n/a | n/a | n/a |
| `sampling/createMessage` (server→client) | ✗ | n/a | n/a | n/a | n/a |
| `elicitation/create` (server→client) | ✗ | n/a | n/a | n/a | n/a |
| `roots/list` (client-supplied) | ✗ | n/a | n/a | n/a | n/a |

Two structural observations from the audit that shape the plan:

1. **The dispatcher is the bottleneck.** The SDK Client and McpServer both speak the full protocol; the connector just doesn't route through. Widening the dispatcher unlocks half the table.
2. **The manifest carries `tools[]` only.** [tunnel/frames.ts:27-32](../../packages/connector/src/tunnel/frames.ts#L27-L32) — `ServerDescriptor` has `name`, `transport`, `author`, `tools[]`. Prompts and resources have no first-class slot, and there's no `manifest-delta` shape for them. The `manifest-delta` path in [tunnel/frames.ts:34-38](../../packages/connector/src/tunnel/frames.ts#L34-L38) is tools-only, which means even if a server registered prompts the controller wouldn't learn about it. Manifest extension is workstream #1 once the dispatcher is open.

## Approach — five workstreams, ordered by load-bearingness

Each workstream is independently shippable. I'd land them in this order: A → B → C → D → E. F is stretch.

**A. Open the dispatcher.** Widen the JSON-RPC method allowlist in [packages/connector/src/dispatcher.ts](../../packages/connector/src/dispatcher.ts) from `{tools/list, tools/call}` to the full server-method set: `prompts/list`, `prompts/get`, `resources/list`, `resources/templates/list`, `resources/read`, `resources/subscribe`, `resources/unsubscribe`, `completion/complete`, `logging/setLevel`. Each new method dispatches through `McpServerConnection` to the SDK Client's matching method. Per-MCP gating stays the same — the connector advertises whatever the local server registered, never per-method.

**B. Extend the manifest.** Grow `ServerDescriptor` in [packages/connector/src/tunnel/frames.ts](../../packages/connector/src/tunnel/frames.ts) with `prompts?: PromptDescriptor[]`, `resources?: ResourceDescriptor[]`, `resourceTemplates?: ResourceTemplateDescriptor[]`, `capabilities?: { prompts?, resources?, completions?, logging? }`. Grow `ManifestDelta` symmetrically. The connector's [manifest/build.ts](../../packages/connector/src/manifest/build.ts) calls `client.listPrompts()` / `listResources()` / `listResourceTemplates()` alongside the existing `listTools()`. Older controllers ignore the new fields.

**C. Author surface in the SDK.** Extend `createMcpHttpServer({tools, prompts?, resources?, resourceTemplates?})` in [packages/connector/src/sdk/http-server.ts](../../packages/connector/src/sdk/http-server.ts). Add `Prompt` and `Resource` interfaces in `src/sdk/`. Each maps 1:1 onto the SDK's `McpServer.registerPrompt()` / `registerResource()` so authors don't learn a second abstraction. Capability flags on the underlying `McpServer` flip on automatically per non-empty list.

**D. Server→client notifications path.** Today the dispatcher only handles inbound requests (controller→connector). Add an outbound notification path: when the local SDK Client receives `notifications/progress`, `notifications/message`, `notifications/resources/updated`, or `notifications/{tools,prompts,resources}/list_changed` from a server, the connector forwards as a new `mcp-notification` frame. The controller receives them via the existing tunnel; correlation by `progressToken` for progress, by `uri` for resource updates. `manifest-delta` already handles tool list_changed for the creds-update path; the new frame generalises that to prompts + resources.

**E. Inspector + controller display.** Inspector grows a Prompts panel and a Resources panel alongside the existing Tools panel — shape-only, mirroring [public/app.js](../../packages/connector/public/app.js) `renderDetail()`. Controller-side display is out of scope for this repo; documented in `docs/MCP-PROTOCOL.md` so the controller team can mirror.

**F. Stretch — sampling + elicitation passthrough.** Map the wire shape so a future controller can implement these. Connector forwards opaquely; no LLM in the connector core. Behind a feature flag — only document, don't ship until a real consumer exists.

## Per-MCP application — what each existing MCP gets

### Twilio bundle ([mcp/bundled/twilio/](../../mcp/bundled/twilio/))

**Prompts (high value).** Twilio's own opinionated, version-controlled, parameterised prompt library — replaces "every customer reinvents this in their procedure YAML."

| Prompt | Arguments | What it returns |
|---|---|---|
| `compose_compliant_sms_campaign` | `audience_summary`, `cta`, `country?` | A compliance-aware draft (10DLC / Toll-Free / Short Code framing in en-US) plus a checklist of `messaging_services_fetch` lookups the procedure should run |
| `voice_ivr_skeleton` | `purpose`, `language?` | TwiML-shaped voice flow plus a list of `voice_say` / `voice_play` / `voice_dial` calls the procedure should chain |
| `verify_otp_flow` | `channel`, `locale?` | The standard send → check → outcome shape parameterised by channel + locale |
| `triage_failed_message` | `messageSid` | A diagnostic prompt that hydrates `messages_fetch` output and frames the next step (carrier filter? bad number? content rejection?) |

**Resources (medium value, read-only canonical state).**
- `twilio://content-templates` — list resource, paginated. Closes the "what templates do I have" gap that today forces a `content_templates_fetch` tool call.
- `twilio://messaging-services` — same shape for messaging services.
- `twilio://verify-services` — same for verify services.
- `twilio://recordings/{call_sid}` — resource template; reads the recording metadata + URL. Useful for the controller to pull canonical context into a prompt without writing a fetch-tool call.
- `twilio://account/usage-summary` — a small JSON snapshot of MTD usage. Cheap to compute; high signal in procedure prompts.

**Logging/progress.** `voice_transcription_start` and `email_search` (90-day window) both benefit from progress events so the controller's procedure runtime can show "still running" vs "stuck."

**Out of scope for the bundle.** Sampling — Twilio doesn't need to mint its own model calls. Elicitation — operator interaction lives controller-side, not in the connector.

### Enterprise Knowledge ([bundles/enterprise-knowledge/](../../bundles/enterprise-knowledge/))

**Resources (very high value — this is the load-bearing change).** EK is *built* for "named, queryable, citeable artefacts." Today every registered source is queryable only via the `knowledge_query` tool. Modelling sources as resources matches the protocol's intent and unlocks **subscribe**:

- `ek://sources/{source_id}` — resource template; reads metadata (kind, status, last refresh, chunk count, last error). One per registered source. Replaces the side-channel `sources_fetch` tool for read-only contexts.
- `ek://sources/{source_id}/chunks/{chunk_id}` — resource template; reads a single chunk by id. Lets the controller cite-and-retrieve in a prompt without burning a vector query.
- `ek://sources` — list resource; the catalogue. `notifications/resources/list_changed` fires when an operator registers or removes a source.
- **`subscribe: true`.** When `sources_refresh` re-embeds a source, the bundle emits `notifications/resources/updated { uri: "ek://sources/{source_id}" }`. The controller's procedure runtime that subscribed to that source sees the freshness event and can re-pull. This is the missing primitive for "kept hot vs freshly stale" today.

**Prompts (medium value).**
- `cite_from_source` — given `source_id` + `query`, returns a prompt template that runs `knowledge_query` + formats the chunks into a citation block. Authors don't reinvent the citation format per procedure.
- `register_and_query` — the standard "register a URL → query it" flow as a single prompt.

**Logging/progress.** `sources_refresh` is the obvious one — chunk-by-chunk progress over the embedding pass would dramatically improve the controller's UX for large sources. Wire shape: `notifications/progress { progressToken, progress, total }`.

**Stretch (Phase 4b+).** Once the Drive reader lands, `ek://sources/{source_id}/files/{file_id}` resource templates would let the controller surface specific Drive files in a prompt without re-implementing reader logic on the controller side.

### Sample + CRM ([mcp/local/sample/](../../mcp/local/sample/), [mcp/local/crm/](../../mcp/local/crm/))

**Sample (low priority — keep as the SDK demo).**
- One demo prompt (`weather_briefing` — combines `weather` + `now`) and one demo resource (`sample://uuids/recent`) so the SDK's prompt + resource API has a working reference for customer authors. That's the only reason to touch sample — its job is to be the canonical "here's how you use the SDK" example.

**CRM (medium value — refund-eligibility procedure benefits).**
- Resource: `crm://customers/{customer_id}` — replaces the `get_customer` tool for read-only contexts. Tool stays for the side-effecting case (controller decides per use).
- Resource: `crm://customers/{customer_id}/orders/recent` — the read-only equivalent of `get_recent`.
- Prompt: `refund_eligibility_check` — the canonical decision prompt the Refund Eligibility procedure on the controller uses; lets the procedure author point at one named prompt instead of inlining policy text.
- Tools stay as-is — `issue_refund` / `notify_agent` / `update_appointment` are side-effecting and belong on the tool surface.

**Pattern that emerges.** Read-only state → resources. Decision/composition templates → prompts. Side-effects → tools. This is the spec-intended split; today's MCPs don't get to express it because the connector only forwards tools.

## Wire-format details

### Manifest extension (Workstream B)

Additive shape on `ServerDescriptor` in [packages/connector/src/tunnel/frames.ts](../../packages/connector/src/tunnel/frames.ts):

```ts
interface ServerDescriptor {
  name: string;
  transport: "http" | "stdio";
  author: string;
  tools: ToolDescriptor[];
  // NEW (all optional — older controllers ignore):
  prompts?: PromptDescriptor[];
  resources?: ResourceDescriptor[];
  resourceTemplates?: ResourceTemplateDescriptor[];
  capabilities?: {
    prompts?:    { listChanged?: boolean };
    resources?:  { listChanged?: boolean; subscribe?: boolean };
    completions?: {};
    logging?:    {};
  };
}

interface PromptDescriptor {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface ResourceDescriptor {
  uri: string;          // e.g. "ek://sources/abc123"
  name: string;
  description?: string;
  mimeType?: string;
}

interface ResourceTemplateDescriptor {
  uriTemplate: string;  // RFC 6570, e.g. "ek://sources/{source_id}/chunks/{chunk_id}"
  name: string;
  description?: string;
  mimeType?: string;
}
```

`ManifestDelta` grows symmetrically — `added.prompts[]` / `removed.prompts[]` / `changed.prompts[]` and the same for resources + resourceTemplates. Today's tools-only delta shape stays valid (older deltas have empty new arrays).

### Method routing (Workstream A)

The dispatcher's allowlist grows. Each method maps 1:1 onto `McpServerConnection`:

| MCP method | `McpServerConnection` method (new) | SDK Client backing |
|---|---|---|
| `prompts/list` | `listPrompts(): Promise<PromptDescriptor[]>` | `client.listPrompts()` |
| `prompts/get` | `getPrompt(name, args): Promise<GetPromptResult>` | `client.getPrompt(...)` |
| `resources/list` | `listResources(): Promise<ResourceDescriptor[]>` | `client.listResources()` |
| `resources/templates/list` | `listResourceTemplates()` | `client.listResourceTemplates()` |
| `resources/read` | `readResource(uri)` | `client.readResource({uri})` |
| `resources/subscribe` | `subscribeResource(uri)` | `client.subscribeResource(...)` |
| `resources/unsubscribe` | `unsubscribeResource(uri)` | `client.unsubscribeResource(...)` |
| `completion/complete` | `complete(ref, argument)` | `client.complete(...)` |
| `logging/setLevel` | `setLoggingLevel(level)` | `client.setLoggingLevel(...)` |

Per-method timeout reuses `policy.tool_timeout_ms` for now. If the controller team needs separate budgets later we can split — but starting with one knob.

Naming on the wire stays `${serverName}.${name}` for prompts (matches the existing tool-name pattern). Resource URIs already carry the namespace inside the URI scheme — no rewriting needed.

### New frame: `mcp-notification` (Workstream D)

Connector → controller. Forwards server-initiated notifications. Opaque payload — the connector validates the JSON-RPC `notifications/*` shape but doesn't interpret.

```ts
interface McpNotificationFrame {
  type: "mcp-notification";
  server: string;             // matches ServerDescriptor.name
  payload: unknown;           // JSON-RPC notification, full envelope
}
```

Examples the controller will see:
- `{ method: "notifications/progress", params: { progressToken, progress, total } }`
- `{ method: "notifications/message", params: { level, logger, data } }` (this is `logging/message`)
- `{ method: "notifications/resources/updated", params: { uri } }`
- `{ method: "notifications/resources/list_changed" }` (and prompts/tools variants)

The connector wires `client.fallbackNotificationHandler` (or method-specific handlers) on every `Client` it constructs. When fired, build the frame and `tunnel.send()`. Same async-free send path as the existing `webhook` frame to keep heartbeats safe (CLAUDE.md "No per-frame await on send path").

### `progressToken` round-trip

Tools and resource reads can opt into progress by passing `_meta.progressToken` in the request. The controller mints the token; the connector forwards to the local server unchanged; the server emits `notifications/progress` with that same token; the connector wraps and forwards as `mcp-notification`. The controller correlates token → original request. No new connector logic — it's all passthrough as long as the new method routing is open.

### Backwards-compat

Per [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) §"Frame envelope," unknown frames are logged and ignored on both sides. So:

- **Older controller, new connector.** Connector advertises `prompts[]` / `resources[]` in the manifest; older controller ignores those fields. Connector emits `mcp-notification` frames; older controller logs + drops. Tools-only flow keeps working.
- **Newer controller, older connector.** Controller calls `prompts/list` over the tunnel; older connector's dispatcher returns `-32601 method not found`. Controller treats that exactly like a server that didn't declare prompts capability — graceful degradation, no protocol break.

### Deferred capability advertisement

The connector's outbound SDK Client at [src/servers/{http,stdio,sse,websocket}.ts](../../packages/connector/src/servers/) currently passes `capabilities: {}` to the SDK. We need to declare the client capabilities the connector itself supports (i.e. what we can receive *from* a server). Minimum:

```ts
new Client({ name, version }, {
  capabilities: {
    // Forward server-initiated notifications
    // (no client capability is strictly required to receive these,
    //  but declaring helps with future protocol negotiation)
  }
});
```

Sampling and elicitation capabilities stay UNDECLARED on the connector side — the controller is the eventual implementer. This keeps the connector core LLM-free per CLAUDE.md.

## SDK author surface (Workstream C)

The shape an MCP author works with — same five-line server pattern, with new optional fields. From [packages/connector/src/sdk/](../../packages/connector/src/sdk/):

```ts
// New types in src/sdk/
export interface Prompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  // Same shape as Tool: register against the underlying McpServer.
  // Author keeps full control over the SDK's registerPrompt() signature.
  register(server: McpServer): void;
}

export interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  register(server: McpServer): void;
}

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
  register(server: McpServer): void;
}
```

Factory shape grows in [packages/connector/src/sdk/http-server.ts](../../packages/connector/src/sdk/http-server.ts):

```ts
export interface CreateMcpHttpServerOptions {
  name: string;
  tools: Tool[];
  prompts?: Prompt[];                       // NEW
  resources?: Resource[];                   // NEW
  resourceTemplates?: ResourceTemplate[];   // NEW
  version?: string;
  port?: number;
  envKeys?: string[];
}
```

The factory:
1. Calls `tool.register(server)` for each tool (today).
2. Calls `prompt.register(server)` / `resource.register(server)` / `template.register(server)` for the new arrays.
3. Sets `capabilities` on `new McpServer(...)` based on which arrays are non-empty: `{ tools: {}, prompts: {}, resources: { subscribe: <true if any author opts in> } }`. Capability flags travel through to the SDK so its handlers wire up.
4. Exposes the same `/envkeys` endpoint as today; per-prompt and per-resource envKeys collapse into the existing aggregation.

The empty-list zero-tools branch at [http-server.ts:56-58](../../packages/connector/src/sdk/http-server.ts#L56-L58) generalises — same shape: when an MCP registers zero prompts/resources, install explicit empty-list handlers so the SDK doesn't 404 on `prompts/list` / `resources/list` before the author has registered anything. Creds-gated bundles can register conditional prompts the same way they register conditional tools today.

**Manifest discovery** in [packages/connector/src/manifest/build.ts](../../packages/connector/src/manifest/build.ts) calls `server.listPrompts()` / `listResources()` / `listResourceTemplates()` alongside the existing `listTools()` and stuffs the results into the new `ServerDescriptor` fields. Stable ordering comes from the SDK's response order — same as tools today.

**Notification path.** When `client.fallbackNotificationHandler` (or method-specific handlers) fires for a notification we want to forward, the connector calls `tunnel.send({ type: "mcp-notification", server: name, payload: <notification> })`. Wired once in `connect.ts` so all four transports get it.

## Rollout

Each workstream gates the next. Within a workstream, tests-first per CLAUDE.md "Goal-Driven Execution."

### Workstream A — open the dispatcher

- Add the new method handlers in [packages/connector/src/dispatcher.ts](../../packages/connector/src/dispatcher.ts).
- Add the matching methods to `McpServerConnection` in [src/servers/index.ts](../../packages/connector/src/servers/index.ts) and wire them in `makeConnection`.
- Tests under `packages/connector/tests/dispatcher/`: one round-trip per method, against a vitest-spawned in-memory MCP server with prompts + resources registered.
- **Done when:** `prompts/list` and `resources/list` round-trip end-to-end through the tunnel against an MCP that registers both.

### Workstream B — extend the manifest

- Grow the type definitions in [src/tunnel/frames.ts](../../packages/connector/src/tunnel/frames.ts).
- Update [src/manifest/build.ts](../../packages/connector/src/manifest/build.ts) and the boot-time validation at [src/manifest/validate.ts](../../packages/connector/src/manifest/validate.ts).
- Update [src/index.ts](../../packages/connector/src/index.ts) `sameMcpServers` reconnect-comparison logic to ignore prompt/resource list changes (the new fields don't gate reconnect; they ride manifest-delta).
- Tests: a fixture MCP that registers tools + prompts + resources; assert manifest carries all three; assert manifest-delta on a creds-update path emits all three categories.
- **Done when:** the inspector + a manifest dump shows prompts and resources alongside tools for an MCP that registers them.

### Workstream C — SDK author surface

- Add `Prompt` / `Resource` / `ResourceTemplate` types in [src/sdk/](../../packages/connector/src/sdk/), exported from `@mcp-shim/connector/sdk`.
- Extend `createMcpHttpServer` per above.
- Update README + the "Author a Type 1 MCP" section in [packages/connector/README.md](../../packages/connector/README.md) — the five-line example becomes a five-line example that registers a prompt or resource if the author wants to.
- Smoke-write a new prompt in `mcp/local/sample/` (`weather_briefing`) and a new resource (`sample://uuids/recent`) so customer authors have a copy-paste reference.
- **Done when:** the sample MCP registers a prompt and a resource, the inspector renders them, and a controller-side `prompts/list` round-trip returns the prompt.

### Workstream D — server→client notifications

- Add the new `McpNotificationFrame` type in [src/tunnel/frames.ts](../../packages/connector/src/tunnel/frames.ts).
- Wire `client.fallbackNotificationHandler` in `makeConnection` at [src/servers/index.ts](../../packages/connector/src/servers/index.ts); on fire, call `tunnel.send`.
- Tests: a fixture MCP fires `notifications/progress` and `notifications/resources/updated`; assert frames land on the controller side of a vitest fake tunnel.
- **Done when:** subscribing to a resource and triggering a server-side update produces an `mcp-notification` frame with `notifications/resources/updated`.

### Workstream E — inspector + docs

- Inspector: Prompts panel + Resources panel in [public/app.js](../../packages/connector/public/app.js) and [public/index.html](../../packages/connector/public/index.html). Same per-MCP grouping as the existing Tools panel; click-through detail pane that mirrors today's tool detail.
- Docs: extend [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) with the new manifest fields, the `mcp-notification` frame, the new dispatcher methods. Bump the version banner to **v1.2** (additive).
- Update CLAUDE.md "Wire protocol — frames" to cover the new frame and method set.
- **Done when:** an operator opening the inspector sees the prompts/resources for the Twilio bundle (once Twilio adds them in workstream-application step below) and the controller team has a single doc to implement against.

### Workstream F — stretch (sampling + elicitation)

- Document only. Add wire shapes to MCP-PROTOCOL.md as **§v1.3 — server-initiated requests** with status `proposed`. Connector code change: a single passthrough handler that forwards `sampling/createMessage` and `elicitation/create` requests *from* an MCP server *to* the controller as a new `mcp-server-request` frame, and routes the controller's reply back. The controller-side LLM stays the LLM; the connector stays a forwarder.
- Behind a feature flag. Don't ship the connector code path until a real consumer (likely the EK bundle wanting structured user prompts mid-`sources_refresh`) exists.

## Per-MCP application order (after the connector workstreams land)

1. **Sample MCP first** — minimal risk; one demo prompt + one demo resource. Proves the SDK author surface works against a tiny example before customers see it.
2. **Enterprise Knowledge** — biggest payoff. Resources first (`ek://sources/{source_id}`, `ek://sources` list, `subscribe: true`), then `notifications/progress` on `sources_refresh`. Prompts can wait for a second pass.
3. **Twilio bundle** — prompts library first (the four high-value ones above), then `twilio://content-templates` + `twilio://messaging-services` resources. Recordings + verify-services + usage-summary are stretch.
4. **CRM** — resource versions of `get_customer` / `get_recent` + the `refund_eligibility_check` prompt. Demonstrates the "read-only → resource, decision → prompt, side-effect → tool" pattern customers should imitate.

## Open questions for the controller team

These are the contract decisions the connector can't make alone:

1. **Prompt + resource display surface.** Where do prompts and resources live in the controller UI? Procedure-author autocomplete? A "Knowledge" tab? Both? Drives the manifest delta-vs-snapshot trade-off (deltas if displayed in real-time, snapshots if displayed on-demand).
2. **Subscription lifecycle.** When the controller subscribes to a resource on behalf of a procedure, who keeps the subscription alive across procedure-run boundaries? Connector-level subscription pool with refcount, or per-procedure-run subscribe/unsubscribe? Affects `resources/subscribe` semantics.
3. **Hydration syntax.** Does `{{ hydrate:apis.messages_create.from }}` get a sibling `{{ resource:twilio://content-templates }}` and `{{ prompt:apis.compose_compliant_sms_campaign }}` syntax? Or is it all `{{ ref:... }}` with a discriminator? Out of scope for connector code, but affects MCP-PROTOCOL.md examples.
4. **Sampling + elicitation timing.** Stretch — but if the controller team has a near-term need for structured user prompts mid-procedure (e.g. EK asking the operator "this URL didn't match any product, did you mean Drive?"), elicitation jumps from F-stretch into the main rollout.

## Cross-references

- [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) — wire-format authority; this plan extends it.
- [packages/connector/src/dispatcher.ts](../../packages/connector/src/dispatcher.ts) — the JSON-RPC method allowlist that gates everything in workstream A.
- [packages/connector/src/sdk/http-server.ts](../../packages/connector/src/sdk/http-server.ts) — author surface that grows in workstream C.
- [.claude/plans/MCP-LOADING.md](./MCP-LOADING.md) — paired plan; established the manifest-delta + creds-update restart path that the new prompts/resources list_changed signals will reuse.
- [.claude/plans/STATUS-CALLBACK-MCP.md](./STATUS-CALLBACK-MCP.md) — paired plan; established the "no inbound port + tunnel-frame ingress" pattern that the new `mcp-notification` frame mirrors.

## Status

`Status: completed 2026-06-22` — workstreams A–E shipped on `feature/mcp-client-use`. Workstream F (sampling/elicitation) deferred per plan's "no consumer yet" gate.

### What landed

- **A — dispatcher.** `prompts/list`, `prompts/get`, `resources/list`, `resources/templates/list`, `resources/read`, `resources/subscribe`, `resources/unsubscribe`, `completion/complete`, `logging/setLevel` route through new `McpServerConnection` methods. Routing patterns (URI scheme fallback for resources, `params.serverName` opt-in for aggregate methods) are codified in [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) §"Server-method passthrough".
- **B — manifest.** `ServerDescriptor` grew optional `prompts[]` / `resources[]` / `resourceTemplates[]` / `capabilities`. `ManifestDelta` grew the symmetric add/remove/change triples. Build path at [packages/connector/src/manifest/build.ts](../../packages/connector/src/manifest/build.ts) calls `listPrompts()` / `listResources()` / `listResourceTemplates()` only when the upstream advertised the matching capability — keeps "didn't declare" vs "declared but empty" distinguishable.
- **C — SDK surface.** New `Prompt` and `Resource` types in [packages/connector/src/sdk/](../../packages/connector/src/sdk/). `createMcpHttpServer({ tools, prompts?, resources? })` registers all three categories on the underlying `McpServer` and advertises capabilities accordingly. Worked example: [`mcp/local/sample/prompts/weather-briefing.ts`](../../mcp/local/sample/prompts/weather-briefing.ts) + [`mcp/local/sample/resources/uuids-recent.ts`](../../mcp/local/sample/resources/uuids-recent.ts).
- **D — notifications.** New [`packages/connector/src/tunnel/notification-forwarder.ts`](../../packages/connector/src/tunnel/notification-forwarder.ts) wraps server-emitted notifications as `mcp-notification` frames. Constructed once per connector process (outlives WS reconnects); per-tunnel rebind via `bind({send})` swaps only the wire callback. Notifications during tunnel-down are dropped (advisory by spec; queueing risks unbounded memory). Wired through [`McpSupervisor.onConnect`](../../packages/connector/src/mcp-supervisor.ts).
- **E — inspector + docs.** Inspector renders Prompts/Resources alongside Tools in [public/app.js](../../packages/connector/public/app.js); manifest-delta summary line counts prompt/resource changes; `mcp-notification` frames render with `server` + `method`. Docs: [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) bumped to v1.2; [CLAUDE.md](../../CLAUDE.md) Wire-protocol section updated; [packages/connector/README.md](../../packages/connector/README.md) "Author a Type 1 MCP" gained a Prompts and resources section.

### Verification

- **Test suite.** 50 test files / 207 tests, all green. New regression coverage:
  - [`tests/dispatcher/server-method-passthrough.test.ts`](../../packages/connector/tests/dispatcher/server-method-passthrough.test.ts) — 11 cases boot a real MCP server (tools + prompt + resource), connect a real SDK Client, attach the dispatcher, and round-trip every new method through the wire.
  - [`tests/manifest/build-prompts-resources.test.ts`](../../packages/connector/tests/manifest/build-prompts-resources.test.ts) — verifies the manifest carries prompts/resources only when the upstream declared the capability (regression: tools-only servers stay tools-only).
  - [`tests/tunnel/notification-forwarder.test.ts`](../../packages/connector/tests/tunnel/notification-forwarder.test.ts) — pre-bind drop, post-unbind drop, throwing send isolation.
- **Live SDK smoke.** [`scripts/smoke-sample-prompts-resources.mjs`](../../scripts/smoke-sample-prompts-resources.mjs) spawns the sample MCP via `tsx`, connects a real `@modelcontextprotocol/sdk` `Client`, and prints `tools/list`, `prompts/list`, `resources/list`, `prompts/get`, `resources/read`. Output captured 2026-06-22 — all four list/read calls succeeded against the v1.2 SDK surface.
- **Full-connector boot smoke.** `./scripts/start-connector.sh` boots the connector through to MCP-server registration; sample/crm/apis spawn cleanly with the new prompts/resources surface visible in the boot log (`prompts:["weather_briefing"] resources:["recent_uuids"]`). Boot fails on `enterprise_knowledge` because the bundle's `.venv/` isn't installed in this worktree — pre-existing dev-setup requirement, unrelated to this plan. Comment that line out of `connector.yaml` (or install the EK bundle's venv from the sibling `mcp-shim-bundled` repo) for a full boot.

### Workstream checklist — what's done / what's pending

Shipped on `feature/mcp-client-use` (commits `7a69acd → d3deb95`, see `git log main..feature/mcp-client-use`):

- [x] **W-A — Open the dispatcher.** All nine MCP server methods route through new `McpServerConnection` shape. (`7a69acd`)
- [x] **W-B — Extend the manifest.** `ServerDescriptor` + `ManifestDelta` carry prompts/resources/resourceTemplates/capabilities. (`a41d832`)
- [x] **W-C — SDK author surface.** `Prompt` / `Resource` types + factory growth + sample MCP worked example. (`6973d1f`)
- [x] **W-D — Server→client notifications.** `mcp-notification` frame + `NotificationForwarder`. (`85ec3d3`)
- [x] **W-E — Inspector + docs.** Inspector panels, `docs/MCP-PROTOCOL.md` v1.2, CLAUDE.md, README. (`d3deb95`)

Deferred — explicitly OUT of scope for this branch:

- [ ] **W-F — sampling + elicitation passthrough.** Documented as "stretch" in §"Five workstreams" above. Don't ship until a real consumer (likely EK wanting structured operator prompts mid-`sources_refresh`) exists. When the time comes, add wire shapes to `docs/MCP-PROTOCOL.md` as a v1.3 stanza, then add a single passthrough handler in [packages/connector/src/dispatcher.ts](../../packages/connector/src/dispatcher.ts) that forwards `sampling/createMessage` / `elicitation/create` *from* an MCP up to the controller as a new `mcp-server-request` frame and routes the controller's reply back. Behind a feature flag.

Optional follow-ups (separate plans, NOT required for merge):

- [ ] **Per-MCP application — Twilio bundle prompts.** §"Twilio bundle (mcp/bundled/twilio/)" lists the four high-value prompts (`compose_compliant_sms_campaign`, `voice_ivr_skeleton`, `verify_otp_flow`, `triage_failed_message`) and a handful of resources (`twilio://content-templates`, `twilio://messaging-services`, etc.). The connector-side machinery is in place; this is an authoring task on the bundle.
- [ ] **Per-MCP application — Enterprise Knowledge resources + progress.** §"Enterprise Knowledge" lists `ek://sources/{source_id}` (with `subscribe: true`) plus `notifications/progress` on `sources_refresh`. Bundle-side change — the connector will already forward both correctly once EK declares them.
- [ ] **Per-MCP application — CRM resources + `refund_eligibility_check` prompt.** §"Sample + CRM" — straightforward authoring on `mcp/local/crm/`.
- [ ] **Drop-in runner extension.** [packages/connector/src/sdk/dropin-runner.ts](../../packages/connector/src/sdk/dropin-runner.ts) currently auto-discovers tools only. Extending `pickTool` with `pickPrompt` / `pickResource` siblings (~30 lines) would let drop-in MCPs ship prompts/resources without a `server.ts`. Documented in the parallel-plan §"Functional interactions" — picks up cleanly after MCP-LOADING-LOCAL lands.
- [ ] **Test suite catalog row.** Add a row to `.claude/plans/TEST-SUITE.md` for the three new test files (already present on `main`; this branch's `.claude/` is gitignored so the catalog wasn't touched here — append after merge to `main`).

### Merge-back checklist

When merging `feature/mcp-client-use` → `main`:

1. Pull this plan file into `../mcp-shim/.claude/plans/MCP-CLIENT-USE.md` (it's gitignored on the worktree, so it doesn't ride the merge).
2. Verify the branch is clean: `git status -s` on the worktree should show only `?? mcp/bundled/twilio/package-lock.json` (untracked; ignore — it's a side-effect of `npm install --omit=dev` in the bundle and predates this plan).
3. `git log main..feature/mcp-client-use` should show exactly five commits — the W-A through W-E series.
4. **If MCP-LOADING-LOCAL has already landed**, see the §"Parallel-plan coordination" §"Recommended merge order" above for the three known conflict points (`frames.ts` union, `docs/MCP-PROTOCOL.md` v1.2 banner, `public/app.js` panels). All resolutions are mechanical.
5. After merge, append a row to `.claude/plans/TEST-SUITE.md` (lives on `main`, not this worktree):
   - 2026-06-22 — `tests/dispatcher/server-method-passthrough.test.ts` — pins prompts/resources/etc. round-trip through the dispatcher (status: `passing`).
   - 2026-06-22 — `tests/manifest/build-prompts-resources.test.ts` — pins manifest carries v1.2 fields only when upstream declared the capability (status: `passing`).
   - 2026-06-22 — `tests/tunnel/notification-forwarder.test.ts` — pins drop-during-outage + post-rebind resume (status: `passing`).
6. Move this plan into `.claude/plans/Done/` per the existing convention (alongside `MCP-LOADING.md`, `STABLE_TUNNEL_RECONNECT.md`, etc.).
7. Per memory `keep_feature_branches_after_merge.md`: leave the `feature/mcp-client-use` ref in place — don't `git branch -d` it. Per memory `feature_branches_local_only.md`: don't push it.

## Parallel-plan coordination — MCP-LOADING-LOCAL

This plan runs in parallel with [MCP-LOADING-LOCAL.md](./MCP-LOADING-LOCAL.md) (worktree `feature/mcp-loading-local`, sibling directory `../mcp-shim-mcp-loading-local/`). The two plans are **largely orthogonal**; they can be developed simultaneously and merged back into `main` independently. This section spells out where they touch so the second-to-merge resolves cleanly.

### Files touched by both plans

| File | LOCAL touches | CLIENT-USE touches | Conflict risk |
|---|---|---|---|
| [packages/connector/src/dispatcher.ts](../../packages/connector/src/dispatcher.ts) | — | rewrites method allowlist | none |
| [packages/connector/src/tunnel/frames.ts](../../packages/connector/src/tunnel/frames.ts) | adds `LocalMcpsRescan*` frames | adds `McpNotificationFrame`, grows `ServerDescriptor` + `ManifestDelta` | medium — both append to the same union types; mechanical resolution |
| [packages/connector/src/sdk/http-server.ts](../../packages/connector/src/sdk/http-server.ts) | — | grows `CreateMcpHttpServerOptions` | none |
| [packages/connector/src/sdk/tool.ts](../../packages/connector/src/sdk/tool.ts) | adds optional `ToolModule` interface (W-L3) | — | none unless L3 ships |
| [packages/connector/src/sdk/dropin-runner.ts](../../packages/connector/src/sdk/dropin-runner.ts) | extends `pickTool` (W-L3) | — | none unless we route prompts/resources through the drop-in shape (~30 lines) |
| [packages/connector/src/sdk/index.ts](../../packages/connector/src/sdk/index.ts) | maybe re-exports `ToolModule` | re-exports `Prompt` / `Resource` | low — same export-list file, append-only |
| [packages/connector/src/servers/index.ts](../../packages/connector/src/servers/index.ts) | — | grows `McpServerConnection` | none |
| [packages/connector/src/servers/{http,stdio,sse,websocket}.ts](../../packages/connector/src/servers/) | — | declares client capabilities + wires `fallbackNotificationHandler` | none |
| [packages/connector/src/manifest/build.ts](../../packages/connector/src/manifest/build.ts) | — | calls listPrompts/listResources alongside listTools | none |
| [packages/connector/src/index.ts](../../packages/connector/src/index.ts) | wires `localMcpsCoordinator` into boot | grows `sameMcpServers` to ignore prompts/resources changes | low — different sections of the same file |
| [packages/connector/src/tunnel/client.ts](../../packages/connector/src/tunnel/client.ts) | adds `local-mcps-rescan` handler | — | none |
| **NEW** `src/tunnel/local-mcps-coordinator.ts` | LOCAL creates | — | none |
| [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) | adds v1.2 §"Local MCPs rescan" | adds v1.2 §"Server-method extension" + §"`mcp-notification` frame" + §"Manifest extension" | medium — both bump v1.2 banner; second-to-merge stitches into one v1.2 header |
| [packages/connector/connector.yaml.example](../../packages/connector/connector.yaml.example) | removes sample/crm entries | — | none |
| `mcp/local/sample/` and `mcp/local/crm/` | deletes server.ts + package.json | (workstream-application step adds demo prompt + resource) | medium — see §"Functional interactions" below |
| [packages/connector/public/app.js](../../packages/connector/public/app.js) and `public/index.html` | adds "Refresh local MCPs" button on MCP Status panel | adds Prompts + Resources panels next to Tools | medium — same file, different chunks |
| [CLAUDE.md](../../CLAUDE.md) | updates authoring shape paragraph | adds rows to "Wire protocol — frames" + paragraph on prompts/resources | low — different sections |

### Functional interactions (same code, semantic dependencies)

These compose cleanly even when the textual diff doesn't conflict:

1. **Sample MCP loses `server.ts` (LOCAL W-L1a) — CLIENT-USE wants to register a demo prompt + resource there.** If LOCAL ships first, CLIENT-USE adds the demo prompt + resource as drop-in–style declarations (the dropin-runner picks them up alongside the existing tools). If CLIENT-USE ships first, sample's `server.ts` registers them; LOCAL's W-L1a deletes the server.ts and the prompt/resource migrate to the drop-in shape anyway. Same work either order; cleaner if LOCAL goes first.
2. **Drop-in runner's `pickTool` (LOCAL W-L3, optional) doesn't know about prompts/resources.** If we want drop-in–style prompts/resources, the second plan to land extends the runner with `pickPrompt` / `pickResource` siblings — about 30 lines.
3. **Manifest validate.ts (CLIENT-USE B) checks `outputSchema` for prompts/resources too.** LOCAL flagged "static schema introspection" as future work — that future enhancement composes cleanly with CLIENT-USE's prompt/resource types.
4. **Both plans bump MCP-PROTOCOL.md to v1.2.** Whichever lands second writes the merged v1.2 stanza with both extensions under one version header.
5. **Inspector source badge (LOCAL W-L1) goes from 2 values → 3 (`yaml` / `controller-config` / `local`).** CLIENT-USE doesn't touch the badge — no interaction.

### Recommended merge order

1. **Land MCP-LOADING-LOCAL first** — smaller surface, mostly delete-and-rewire, cleans up sample MCP for CLIENT-USE's demo prompt/resource.
2. **Rebase `feature/mcp-client-use` onto `main`.** Resolve three places:
   - `frames.ts` union — trivial concatenation of both plans' frame additions to `TunnelFrame` / `InboundTunnelFrame`.
   - `docs/MCP-PROTOCOL.md` — stitch v1.2 sections under one header.
   - `public/app.js` + `public/index.html` — append CLIENT-USE's Prompts/Resources panels next to LOCAL's Refresh button.
3. **If CLIENT-USE adds demo prompt/resource to sample/crm** — route them through the drop-in shape (LOCAL has already removed `server.ts`); extend `pickTool` sibling helpers in `dropin-runner.ts` (~30 lines).

Either order works — the conflict size is the same, the junction is just at a different file. **Nothing in either plan blocks the other from starting now.**

If CLIENT-USE merges first instead: the conflicts are symmetric. LOCAL's W-L1a deletes the sample's `server.ts` after CLIENT-USE's prompt/resource registration sits in it; the migration becomes "move those registrations into the drop-in shape." Same ~30-line extension to the runner.

## How to resume from a fresh context

A `/clear`'d Claude can resume this plan by reading exactly four files:

1. **This plan** ([.claude/plans/MCP-CLIENT-USE.md](./MCP-CLIENT-USE.md)) — design, workstreams, decisions.
2. **[docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md)** — wire-format authority. This plan extends it (v1.2 additive). Read §"Frame envelope" + §"v1.1 — 3rd-party MCP roster" before touching frame schemas.
3. **[CLAUDE.md](../../CLAUDE.md)** — the load-bearing architectural properties. The "Architecturally load-bearing properties" + "Wire protocol — frames" + "Workspaces" sections are the non-negotiables.
4. **[.claude/plans/MCP-LOADING-LOCAL.md](./MCP-LOADING-LOCAL.md)** — the parallel plan. See §"Parallel-plan coordination — MCP-LOADING-LOCAL" above before merging.

### First moves

```bash
# Confirm we're in the right worktree
pwd  # should print: /Users/dhartman/Development/01_Twilio/AgenticProcedure/mcp-shim-mcp-client-use
git rev-parse --abbrev-ref HEAD  # should print: feature/mcp-client-use

# Sanity: tests pass on the baseline before any changes
cd packages/connector && npm test
```

If the worktree is missing, recreate it from `main`:

```bash
cd /Users/dhartman/Development/01_Twilio/AgenticProcedure/mcp-shim
git worktree add -b feature/mcp-client-use ../mcp-shim-mcp-client-use main
cp .claude/plans/MCP-CLIENT-USE.md ../mcp-shim-mcp-client-use/.claude/plans/  # .claude/ is gitignored
```

### Workstream order to ship

A → B → C → D → E. F is stretch (sampling/elicitation passthrough — document only, don't ship until a real consumer exists).

Each workstream is independently shippable. Within a workstream: tests-first per CLAUDE.md "Goal-Driven Execution." Use the existing peer-tests layout under `packages/connector/tests/` (NEVER colocated — `tsconfig.json`'s `rootDir: "src"` would otherwise compile tests into `dist/`).

### Before the final merge to main

Per memory `docs_update_before_merge.md`:
- Update [CLAUDE.md](../../CLAUDE.md) "Wire protocol — frames" section with the new method dispatcher + `mcp-notification` frame.
- Update [packages/connector/README.md](../../packages/connector/README.md) "Author a Type 1 MCP" section with the prompt + resource authoring shape.
- Update [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) version banner to v1.2; document the new method set, manifest extension, and `mcp-notification` frame.
- Update [.claude/plans/TEST-SUITE.md](./TEST-SUITE.md) with rows for the new round-trip tests per workstream.
- Mark this plan's `Status: completed YYYY-MM-DD` once all five workstreams (A–E) ship.

After merge, leave the `feature/mcp-client-use` branch ref in place (memory `keep_feature_branches_after_merge.md`) and remove the worktree:

```bash
git worktree remove ../mcp-shim-mcp-client-use
# branch ref stays for history
```
