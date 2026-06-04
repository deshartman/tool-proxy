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

// Frames the connector originates.
export type TunnelFrame =
  | RegisterFrame
  | ManifestDeltaFrame
  | RpcFrame
  | HeartbeatFrame
  | GoodbyeFrame;

// Frames the connector receives (inbound). Register-ack is a non-spec but
// useful response from the controller — see RegisterAckFrame above.
export type InboundTunnelFrame = TunnelFrame | RegisterAckFrame;
