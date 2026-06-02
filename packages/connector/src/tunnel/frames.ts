// Productized frame types per docs/MCP-TUNNEL.md "Frame types (productized)".
// Single source of truth for the tunnel wire format on the connector side.

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;       // JSON Schema, opaque pass-through from MCP
  outputSchema?: unknown;
  allowed: boolean;           // resolved against allow_list
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

export interface RegisterFrame       { type: "register";       manifest: ToolManifest }
export interface ManifestDeltaFrame  { type: "manifest-delta"; delta: ManifestDelta }
export interface RpcFrame            { type: "rpc";            payload: unknown }
export interface HeartbeatFrame      { type: "heartbeat";      ts: number }
export interface GoodbyeFrame        { type: "goodbye";        reason?: string }

export type TunnelFrame =
  | RegisterFrame
  | ManifestDeltaFrame
  | RpcFrame
  | HeartbeatFrame
  | GoodbyeFrame;
