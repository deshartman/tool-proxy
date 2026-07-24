// Productized frame types per docs/MCP-TUNNEL.md "Frame types (productized)".
// Single source of truth for the tunnel wire format on the connector side.

export interface ToolDescriptor {
  name: string;
  // Optional human-readable display label (MCP spec's top-level `title`).
  // Falls back to `name` on consumers that don't render it.
  title?: string;
  description: string;
  inputSchema: unknown;       // JSON Schema, opaque pass-through from MCP
  outputSchema?: unknown;
  allowed: boolean;           // always true on this connector — see CLAUDE.md "Trust boundary"
}

// v1.2 — MCP-CLIENT-USE. Prompts and resources from the upstream MCP carried
// alongside the existing tools list. Optional fields default to undefined when
// the upstream server didn't declare the matching capability — older
// controllers ignore them per the §"Frame envelope" unknown-fields rule.

export interface PromptArgumentDescriptor {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptDescriptor {
  name: string;
  description?: string;
  arguments?: PromptArgumentDescriptor[];
}

export interface ResourceDescriptor {
  uri: string;                // e.g. "ek://sources/abc123"
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceTemplateDescriptor {
  uriTemplate: string;        // RFC 6570, e.g. "ek://sources/{source_id}/chunks/{chunk_id}"
  name: string;
  description?: string;
  mimeType?: string;
}

// What the connector tells the controller the upstream MCP can do. Mirrors
// the shape MCP servers declare to clients at initialize-time. The connector
// captures this at connect-time and forwards verbatim — it doesn't synthesise
// or filter. Empty/missing object means "didn't declare" — surface as "off"
// in the controller UI rather than "unknown."
export interface ServerCapabilitiesAdvert {
  prompts?:    { listChanged?: boolean };
  resources?:  { listChanged?: boolean; subscribe?: boolean };
  tools?:      { listChanged?: boolean };
  completions?: Record<string, never>;
  logging?:    Record<string, never>;
}

export interface ServerDescriptor {
  name: string;
  transport: "http" | "stdio";
  // Who authored this MCP — derived by the connector from the spec, not
  // configured. Today: "twilio" for anything under mcp/bundled/ (resolved
  // either via `bundled:` yaml form or a `dir:` that lives under
  // mcp/bundled/), "customer" for everything else. The controller uses
  // this to group MCPs in the UI (e.g. Twilio-shipped vs customer-side
  // MCPs in different sections of the connector detail view). Typed as
  // `string` rather than a union so the controller forward-compats new
  // values added later (e.g. partner-authored MCPs).
  author: string;
  // INSPECTOR-CREDS-VISIBILITY (W-S7/W-S8): aggregate envKeys union for
  // this MCP — same value the connector sends in `creds-request`.
  // Optional + advisory: the inspector uses it to decide when to render
  // an "Awaiting config" badge (non-empty AND credsSource === "none"),
  // and the controller can optionally surface it to the operator UI as
  // a "this MCP expects these env vars" hint. Older controllers ignore
  // it per the §"Frame envelope" unknown-fields rule.
  envKeys?: string[];
  tools: ToolDescriptor[];
  // v1.2 additive — older controllers ignore these and the connector still
  // works as a tools-only dispatcher.
  prompts?: PromptDescriptor[];
  resources?: ResourceDescriptor[];
  resourceTemplates?: ResourceTemplateDescriptor[];
  capabilities?: ServerCapabilitiesAdvert;
}

export interface ToolManifest {
  connectorId: string;
  environment: string;
  version: string;
  servers: ServerDescriptor[];
}

export interface ManifestDelta {
  added:   { server: string; tool: ToolDescriptor }[];
  removed: { server: string; tool: string }[];
  changed: { server: string; tool: ToolDescriptor }[];
  // v1.2 additive — symmetric with the tools-only fields above. Empty arrays
  // (and absent fields) are equivalent on the wire; older controllers see no
  // change. Only emitted when prompts/resources actually change.
  addedPrompts?:            { server: string; prompt: PromptDescriptor }[];
  removedPrompts?:          { server: string; prompt: string }[];
  changedPrompts?:          { server: string; prompt: PromptDescriptor }[];
  addedResources?:          { server: string; resource: ResourceDescriptor }[];
  removedResources?:        { server: string; resource: string }[];
  changedResources?:        { server: string; resource: ResourceDescriptor }[];
  addedResourceTemplates?:  { server: string; resourceTemplate: ResourceTemplateDescriptor }[];
  removedResourceTemplates?: { server: string; resourceTemplate: string }[];
  changedResourceTemplates?: { server: string; resourceTemplate: ResourceTemplateDescriptor }[];
}

export interface RegisterFrame {
  type: "register";
  manifest: ToolManifest;
  // Identity claim. The controller's terminator picks one of three branches
  // based on what's set:
  //   - `registrationToken` present  → reconnect path (lookup by token)
  //   - `name` set, no token         → first-connect mint path
  //   - neither                      → reject (`missing_name_or_token`)
  // The connector reads `name` from connector.yaml and the optional
  // `registrationToken` from `.connector-state.json` (written by the
  // controller on the first register-ack).
  name?: string;
  registrationToken?: string;
}

// Some controllers send register-ack back on the first register frame. This
// is non-spec but harmless; the connector parses and ignores most of it,
// extracting only `registrationToken` (sent on first-connect mint, persisted
// to .connector-state.json so subsequent boots can reconnect by token).
export interface RegisterAckFrame {
  type: "register-ack";
  connectorId?: string;
  accepted?: boolean;
  error?: { code: string; message: string };
  acceptedToolCount?: number;
  registrationToken?: string;
}
export interface ManifestDeltaFrame  { type: "manifest-delta"; delta: ManifestDelta }
export interface RpcFrame            { type: "rpc";            payload: unknown }
export interface HeartbeatFrame      { type: "heartbeat";      ts: number }
export interface GoodbyeFrame        { type: "goodbye";        reason?: string }

// Webhook ingress (see .claude/plans/STATUS-CALLBACK-MCP.md). The controller
// is the synchronous HTTPS responder; the connector consumes events here as
// `webhook` frames over the existing tunnel WS. No inbound port on the
// connector — that invariant is load-bearing (CLAUDE.md "Architecturally
// load-bearing properties").

// Connector → controller. "Mint a public URL for this MCP." Idempotent per
// (connectorId, mcp): a re-issue after restart returns the same URL `rowId`
// (so customer-pasted Twilio configs keep resolving) but a freshly-minted
// plaintext token. Echo `mcp` on the ack matches the existing `register-ack`
// shape — no requestId needed because the connector serializes alloc per-MCP.
export interface WebhookAllocateFrame {
  type: "webhook-allocate";
  mcp: string;                        // ServerDescriptor.name from the manifest
  ttlSeconds?: number;                // optional; default = lifetime of the WS session
}

// Controller → connector. Response to webhook-allocate.
export interface WebhookAllocateAckFrame {
  type: "webhook-allocate-ack";
  mcp: string;
  url?: string;                       // present on success
  error?: { code: string; message: string };
}

// Controller → connector. A webhook arrived upstream; the controller answered
// HTTP 200 synchronously and is forwarding the contents here. `body` is
// already JSON-normalized by the controller (form-urlencoded → JSON), so the
// MCP doesn't see Content-Type or raw bodies. `headers` is an allowlisted
// subset (X-Twilio-* forwarded verbatim, everything else stripped — see
// STATUS-CALLBACK-CTRL.md "Header forwarding allowlist").
export interface WebhookFrame {
  type: "webhook";
  mcp: string;                        // routing key — controller looked this up by token
  queryParameters: Record<string, string | string[]>;
  body: unknown;
  headers?: Record<string, string>;
  receivedAt: number;                 // ms epoch — when the controller logged the POST
}

// Connector → controller. Clean up on shutdown / yaml reload that removed the MCP.
export interface WebhookRevokeFrame {
  type: "webhook-revoke";
  mcp: string;
}

// Per-MCP credential exchange (see docs/MCP-PROTOCOL.md). Three frames let
// the controller act as the credential vault for per-MCP env vars without
// adding a second config UI on the connector side.

// Source the controller used to fill the response. Surfaced through to the
// inspector status panel so the operator can tell where each value came from.
export type CredsSource =
  | "twilio-tunnel-row"   // auto-filled from the tunnel_security_configs row
  | "operator-entered"    // entered in the controller UI
  | "none";               // no row exists yet

// Connector → controller. Ask for env values for a given MCP. Identity is
// implicit: the controller derives connectorId from the WS-authenticated
// session — never trust a connector-supplied id.
export interface CredsRequestFrame {
  type: "creds-request";
  requestId: string;                   // UUID v4, generated by the connector
  mcp: string;                         // matches manifest.servers[].name
  mcpId?: string;                      // v1.1 — set when this MCP came from controller-config (mcp-config-snapshot/delta)
  author: string;                      // "twilio" | "customer", from manifest
  envKeys: string[];                   // union of envKeys across the MCP's tools
}

// Controller → connector. Reply to a creds-request. Either env+source on
// success (env may be {} when source is "none" — the operator hasn't
// entered creds yet, which the connector treats as "fall back to dir/.env"),
// or error for unexpected controller-side failures.
export interface CredsResponseFrame {
  type: "creds-response";
  requestId: string;                   // echoes the request's id
  env?: Record<string, string>;
  source?: CredsSource;
  error?: string;
}

// Controller → connector. Push: operator updated creds in the controller UI,
// or a tunnel-security-row credential rotated. Connector merges and restarts
// the affected child via the supervisor.
export interface CredsUpdateFrame {
  type: "creds-update";
  mcp: string;
  mcpId?: string;                      // v1.1 — set when this MCP came from controller-config
  env: Record<string, string>;
  source: CredsSource;
  reason?: string;                     // optional human-readable reason
}

// ── v1.1 — Controller-driven 3rd-party MCP roster ─────────────────────────
//
// The controller's "New 3rd Party MCP" UI mints an entry per MCP and pushes
// the roster down to the connector via mcp-config-snapshot (full roster on
// register-ack and on resync) + mcp-config-delta (steady-state CRUD). The
// connector reconciles in-memory; yaml is NOT rewritten. See docs/MCP-PROTOCOL.md
// §"v1.1 — 3rd-party MCP roster (controller-driven)" for the full contract.

// mcpId is a controller-minted opaque string. It's the routing handle that
// lets the controller correlate roster frames + creds frames + ack rows back
// to a row in its store without name-matching. Typed inline as `string` per
// the codebase's lint rule (no single-field type aliases).

// Auth shape only — the env-key NAMES the connector should attach values to.
// Values arrive via creds-response (v1 path).
export type McpAuthSpec =
  | { kind: "none" }
  | { kind: "bearer"; envKey: string }
  | { kind: "header"; headerName: string; envKey: string }
  | {
      kind: "oauth2-client-credentials";
      tokenUrlEnvKey: string;
      clientIdEnvKey: string;
      clientSecretEnvKey: string;
      scopes?: string[];
    };

// Single 3rd-party MCP entry. Controller-supplied; lives in connector RAM.
export interface McpConfigEntry {
  mcpId: string;
  name: string;                        // routing key + display label; unique per connector
  description?: string;
  transport: "http" | "streamable-http" | "sse" | "websocket" | "stdio";
  url?: string;                        // http-family
  command?: string[];                  // stdio
  auth: McpAuthSpec;                   // shape; values via creds-response
  envKeys?: string[];                  // names of env vars the upstream needs
}

// Controller → connector. Full roster of 3rd-party MCPs for this connector.
// Sent on every register-ack (always — even when empty), and as the reply to
// mcp-config-resync. generation is monotonic per connector across snapshots
// and deltas.
export interface McpConfigSnapshotFrame {
  type: "mcp-config-snapshot";
  generation: number;
  servers: McpConfigEntry[];
}

// Controller → connector. Steady-state CRUD on the roster. Connector tracks
// lastAppliedGeneration; if delta.generation > lastApplied + 1, the connector
// emits mcp-config-resync { reason: "gap" }. Duplicates (delta.generation
// <= lastApplied) are dropped + logged.
export interface McpConfigDeltaFrame {
  type: "mcp-config-delta";
  generation: number;
  added?: McpConfigEntry[];
  updated?: McpConfigEntry[];          // full new spec replaces prior by mcpId
  removed?: string[];                  // mcpIds (NOT names)
}

// Connector → controller. Per-MCP outcome after applying a snapshot or delta.
// status: "skipped" is reserved for entries the connector cannot run today
// (e.g. unsupported transport in this connector version) — the controller
// surfaces this in the row's status badge.
export interface McpConfigAckFrame {
  type: "mcp-config-ack";
  generation: number;
  perMcp: Array<{
    mcpId: string;
    name: string;
    status: "started" | "failed" | "skipped" | "removed";
    error?: string;
  }>;
}

// Connector → controller. Sent on generation gap, boot soft-wait timeout, or
// inspector "Resync MCPs" action (future). Controller MUST reply with a fresh
// mcp-config-snapshot.
export interface McpConfigResyncFrame {
  type: "mcp-config-resync";
  reason: "gap" | "boot" | "manual";
}

// ── v1.2 — Local MCP rescan (controller-triggered) ────────────────────────
//
// W-L2 of MCP-LOADING-LOCAL.md. The controller's "Refresh local MCPs" button
// emits this frame; the connector re-runs its drop-in scanner against
// MCP_DROPIN_DIR and reconciles new / removed folders against the running
// supervisor entries. No payload — the connector decides what's there; the
// controller just triggers. The inspector exposes the same operation via a
// loopback POST at /mcp/rescan-local for the local-dev path.
//
// Backwards compat: a v1.1 controller never sends this frame so the
// connector's behaviour is unchanged. A v1.1 connector ignores the frame
// per the unknown-frame rule.

// Controller → connector. Trigger a re-scan of MCP_DROPIN_DIR.
export interface LocalMcpsRescanFrame {
  type: "local-mcps-rescan";
}

// Connector → controller. Reply to local-mcps-rescan summarising the diff
// against running supervisor entries. The controller's UI uses this to render
// "Done — N added, M removed". Manifest changes ride the existing
// manifest-delta path; this ack is small-and-static (no tool-level detail).
export interface LocalMcpsRescanAckFrame {
  type: "local-mcps-rescan-ack";
  added: { name: string; toolsCount: number }[];
  removed: string[];
  unchanged: string[];
  errors: { name: string; error: string }[];
}

// v1.2 — MCP-CLIENT-USE. Server-initiated notification forwarded from a
// local MCP up to the controller. Opaque payload (full JSON-RPC notification
// envelope) — the connector validates the wrapping shape but doesn't
// interpret. Examples: `notifications/progress`, `notifications/message`
// (logging/message on the wire), `notifications/resources/updated`,
// `notifications/{tools,prompts,resources}/list_changed`. The controller
// correlates progress by `params.progressToken`, resource updates by
// `params.uri`. The connector is a pure forwarder.
export interface McpNotificationFrame {
  type: "mcp-notification";
  server: string;             // matches ServerDescriptor.name
  payload: unknown;           // JSON-RPC notification envelope (method + params)
}

// ── v1.3 — Customer drop-in approval gate ──────────────────────────────────
//
// Customer-authored drop-in MCPs (folders under MCP_DROPIN_DIR with
// author === "customer" && source === "local") are NOT advertised in the
// manifest until the controller's operator approves them. The connector
// spawns the child unconditionally (preserves crash isolation), withholds
// the server descriptor from the manifest, and emits `mcp-discovered` so
// the controller can render it in a "Pending approval" lane.
//
// Approval state lives on the controller. After every register-ack the
// controller replays `mcp-enable` for every previously-approved MCP — the
// connector keeps the approved set in RAM only (no .connector-state.json
// persistence). Yaml-listed Type 1 / Type 3 / 3rd-party MCPs are NOT gated.
//
// See docs/MCP-PROTOCOL.md §"v1.3 — Customer drop-in approval gate" and
// .claude/plans/MCP-CUSTOM-APPROVAL.md for the full contract.

// Connector → controller. A customer drop-in MCP whose tools are NOT yet
// in the manifest. Two emission points: at boot for every drop-in (the
// controller decides whether to auto-replay enable), and on rescan-added
// drop-ins. `tools` carries names + descriptions only — schemas are
// withheld until approval lands.
export interface McpDiscoveredFrame {
  type: "mcp-discovered";
  mcp: string;                          // folder name; stable identity across reconnects
  author: "customer";                   // gate predicate, always literal
  source: "local";                      // gate predicate, always literal
  envKeys: string[];                    // de-duped union from the child's /envkeys endpoint
  tools: Array<{
    name: string;
    description?: string;
  }>;
  discoveredAt: string;                 // ISO8601, connector wall-clock
}

// Controller → connector. Operator-side approval (initial click) OR
// replay-on-register-ack for every previously-approved MCP. Idempotent —
// re-enabling an already-enabled MCP is a no-op except for the ack.
// `env` merges via supervisor.applyControllerEnv (same path creds-update
// uses); creds-update remains the steady-state ongoing-rotation path.
export interface McpEnableFrame {
  type: "mcp-enable";
  mcp: string;
  env?: Record<string, string>;         // optional inline-paste; subset of envKeys is fine
  source?: "operator-entered";          // for telemetry; reserved for future values
}

// Controller → connector. Operator revokes approval. Connector drops the
// tools from the manifest (manifest-delta { removed }); the child KEEPS
// running. No `stop` field — kill-the-child is reserved for a future
// `mcp-stop` if a real scenario emerges (RAM, misbehaviour). Don't
// overload `mcp-disable`.
export interface McpDisableFrame {
  type: "mcp-disable";
  mcp: string;
}

// Connector → controller. Reply to `mcp-enable` and `mcp-disable`.
// Frame-ordering rule: `manifest-delta` MUST precede this ack — the ack
// is the "I'm done" signal, the manifest-delta is the actual surface
// change. `status: "enabled"` carries `toolsCount`; `status: "error"`
// carries `error` (`unknown_mcp`, `apply_env_failed: <reason>`,
// `not_gated: ...`).
export interface McpEnableAckFrame {
  type: "mcp-enable-ack";
  mcp: string;
  status: "enabled" | "disabled" | "error";
  error?: string;
  toolsCount?: number;
}

// Frames the connector originates.
export type TunnelFrame =
  | RegisterFrame
  | ManifestDeltaFrame
  | RpcFrame
  | HeartbeatFrame
  | GoodbyeFrame
  | WebhookAllocateFrame
  | WebhookRevokeFrame
  | CredsRequestFrame
  | McpConfigAckFrame
  | McpConfigResyncFrame
  | LocalMcpsRescanAckFrame
  | McpNotificationFrame
  | McpDiscoveredFrame
  | McpEnableAckFrame;

// Frames the connector receives (inbound). Register-ack is a non-spec but
// useful response from the controller — see RegisterAckFrame above.
export type InboundTunnelFrame =
  | TunnelFrame
  | RegisterAckFrame
  | WebhookAllocateAckFrame
  | WebhookFrame
  | CredsResponseFrame
  | CredsUpdateFrame
  | McpConfigSnapshotFrame
  | McpConfigDeltaFrame
  | LocalMcpsRescanFrame
  | McpEnableFrame
  | McpDisableFrame;
