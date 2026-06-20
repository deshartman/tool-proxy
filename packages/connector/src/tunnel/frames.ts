// Productized frame types per docs/MCP-TUNNEL.md "Frame types (productized)".
// Single source of truth for the tunnel wire format on the connector side.

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;       // JSON Schema, opaque pass-through from MCP
  outputSchema?: unknown;
  allowed: boolean;           // always true on this connector — see CLAUDE.md "Trust boundary"
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
  tools: ToolDescriptor[];
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
  env: Record<string, string>;
  source: CredsSource;
  reason?: string;                     // optional human-readable reason
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
  | CredsRequestFrame;

// Frames the connector receives (inbound). Register-ack is a non-spec but
// useful response from the controller — see RegisterAckFrame above.
export type InboundTunnelFrame =
  | TunnelFrame
  | RegisterAckFrame
  | WebhookAllocateAckFrame
  | WebhookFrame
  | CredsResponseFrame
  | CredsUpdateFrame;
