import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { RpcFrame, TunnelFrame } from "@mcp-shim/shared";
import type { IncomingMessage, ServerResponse } from "node:http";

// Server-side counterpart of TunnelClientTransport. Wraps a single accepted
// HTTP connection and exposes it as an MCP Transport that an MCP Client can
// use to talk to the shim on the other end.
export class TunnelServerTransport implements Transport {
  onmessage?: (msg: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (err: Error) => void;
  // Demo-only: non-RPC inbound frames (events from shim, doc-read/write responses).
  onframe?: (frame: TunnelFrame) => void;

  private buffer = "";
  private closed = false;

  constructor(
    private readonly req: IncomingMessage,
    private readonly res: ServerResponse
  ) {}

  // The server-side transport is already "started" — the connection is open
  // by the time we construct it. start() exists to satisfy the interface.
  async start(): Promise<void> {
    // Wire request -> onmessage
    this.req.setEncoding("utf8");
    this.req.on("data", (chunk: string) => this.handleInbound(chunk));
    this.req.on("end", () => this.handleClose());
    this.req.on("error", (e) => this.onerror?.(e));
    this.res.on("close", () => this.handleClose());
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return;
    const frame: RpcFrame = { type: "rpc", payload: message };
    this.res.write(JSON.stringify(frame) + "\n");
  }

  // Demo-only: send a non-RPC frame down the tunnel (doc-read/write requests).
  sendFrame(frame: TunnelFrame): void {
    if (this.closed) return;
    this.res.write(JSON.stringify(frame) + "\n");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.res.end();
    } catch {
      // already closed
    }
    this.onclose?.();
  }

  // Called by the tunnel acceptor with the leftover bytes after the register
  // frame has been consumed. Subsequent bytes belong to MCP RPC.
  feedInitialBuffer(remainder: string): void {
    if (remainder) this.handleInbound(remainder);
  }

  private handleInbound(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
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
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
