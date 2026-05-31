import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { RpcFrame, TunnelFrame } from "@mcp-shim/shared";
import type { RawData, WebSocket } from "ws";

function wsDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

// Server-side counterpart of TunnelClientTransport. Wraps an upgraded
// WebSocket connection and exposes it as an MCP Transport that an MCP Client
// can use to talk to the shim on the other end.
export class TunnelServerTransport implements Transport {
  onmessage?: (msg: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (err: Error) => void;
  onframe?: (frame: TunnelFrame) => void;

  private closed = false;

  constructor(private readonly ws: WebSocket) {}

  // Connection is already open by the time we wrap it. start() exists to
  // satisfy the Transport interface.
  async start(): Promise<void> {
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      this.handleMessage(wsDataToString(data));
    });
    this.ws.on("close", () => this.handleClose());
    this.ws.on("error", (e) => this.onerror?.(e));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return;
    const frame: RpcFrame = { type: "rpc", payload: message };
    this.ws.send(JSON.stringify(frame));
  }

  sendFrame(frame: TunnelFrame): void {
    if (this.closed) return;
    this.ws.send(JSON.stringify(frame));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // already closed
    }
    this.onclose?.();
  }

  private handleMessage(line: string): void {
    try {
      const frame = JSON.parse(line) as TunnelFrame;
      if (frame.type === "rpc") {
        const parsed = JSONRPCMessageSchema.parse(frame.payload);
        this.onmessage?.(parsed);
      } else {
        this.onframe?.(frame);
      }
    } catch (e) {
      this.onerror?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
