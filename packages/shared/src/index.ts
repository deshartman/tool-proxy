// Re-export the shared "Change document" implementation so consumers can
// `import { applyVariantInFile } from "@mcp-shim/shared"`.
export * from "./variants.js";

// Shared types for the shim <-> main-server tunnel.
//
// Frames are JSON objects, one per line (newline-delimited). Two kinds:
//   - "register": shim announces itself + its procedures (shim -> main, once)
//   - "rpc":      MCP JSON-RPC payload, both directions
//
// Models the MCP Tunnels pattern: shim dials out, main server pushes RPC
// requests down the same connection that the shim opened.

export interface ShimProcedure {
  id: string;
  description: string;
}

export interface RegisterFrame {
  type: "register";
  shimId: string;
  procedures: ShimProcedure[];
}

export interface RpcFrame {
  type: "rpc";
  // Raw JSON-RPC message as MCP defines it. Opaque to the tunnel.
  payload: unknown;
}

// Demo-only: shims self-report internal events back through the same tunnel
// so the UI can visualize what's happening locally. In production this frame
// type would NOT exist — the cloud cannot see shim internals.
export interface EventFrame {
  type: "event";
  source: string; // shim id, or "main" if injected by the main server itself
  level: "info" | "detail";
  message: string;
  ts: number;
}

// Demo-only: stream agent answer tokens through the tunnel for live UI display.
// `seq` is a monotonic per-query sequence number so the UI can dedupe if the
// same token arrives twice (e.g. SSE reconnect, double subscription).
export interface TokenFrame {
  type: "token";
  source: string;
  queryId: string;
  seq: number;
  delta: string;
  done?: boolean;
}

export type TunnelFrame =
  | RegisterFrame
  | RpcFrame
  | EventFrame
  | TokenFrame;

// Browser SSE payload (cloud-emitted + shim-forwarded events merged into one stream)
export interface UiEvent {
  source: string; // "main", "shim-a", etc
  panel: "cloud" | "shim";
  level: "info" | "detail";
  message: string;
  ts: number;
}

// Demo-only: token streaming for the answer panel. Carried over the same
// SSE channel as UiEvent but routed to the answer pane instead of a log.
// queryId lets the UI ignore stale streams from previous queries.
export interface UiTokenEvent {
  kind: "token";
  queryId: string;
  source: string; // shim id that produced the token
  seq: number;
  delta: string;
  done?: boolean;
}

export type UiPayload = UiEvent | UiTokenEvent;
