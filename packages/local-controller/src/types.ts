// Mirror of the connector's frame types. Defined locally so the controller
// has no compile-time dependency on @mcp-shim/connector.
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  allowed: boolean;
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
export type TunnelFrame =
  | { type: "register";       manifest: ToolManifest }
  | { type: "manifest-delta"; delta: ManifestDelta }
  | { type: "rpc";            payload: unknown }
  | { type: "heartbeat";      ts: number }
  | { type: "goodbye";        reason?: string };

// UI-level event published over SSE.
export type UiEvent =
  | { kind: "registry"; connectors: ConnectorView[] }
  | { kind: "log"; ts: number; level: "info" | "detail"; message: string };

export interface ConnectorView {
  connectorId: string;
  environment: string;
  version: string;
  status: "online" | "stale" | "disconnected";
  lastHeartbeatTs?: number;
  manifest: ToolManifest;
}
