import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { EventFrame, RegisterFrame, RpcFrame, TokenFrame, TunnelFrame } from "@mcp-shim/shared";
import { request as httpRequest, IncomingMessage } from "node:http";
import { URL } from "node:url";
import { PassThrough } from "node:stream";

// Outbound-only tunnel transport.
//
// Models the MCP Tunnels pattern: the shim dials the main server with a
// streaming POST. The request body carries shim->server frames; the response
// body carries server->shim frames. One persistent HTTP/1.1 connection,
// outbound from the shim, no inbound ports.
//
// This implements MCP's Transport interface so the SDK Server treats it like
// any other transport.
export class TunnelClientTransport implements Transport {
  onmessage?: (msg: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (err: Error) => void;
  // Demo-only callback for non-RPC inbound frames (doc-read/write requests).
  onframe?: (frame: TunnelFrame) => void;

  private outbound = new PassThrough();
  private inboundBuffer = "";
  private started = false;
  private closed = false;

  constructor(
    private readonly mainServerUrl: string,
    private readonly registerFrame: RegisterFrame
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const url = new URL(this.mainServerUrl);

    await new Promise<void>((resolveStart, rejectStart) => {
      const req = httpRequest(
        {
          method: "POST",
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname + url.search,
          headers: {
            "content-type": "application/x-ndjson",
            "transfer-encoding": "chunked",
          },
        },
        (res: IncomingMessage) => {
          if (res.statusCode !== 200) {
            rejectStart(new Error(`Tunnel rejected with status ${res.statusCode}`));
            return;
          }
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => this.handleInboundChunk(chunk));
          res.on("end", () => this.handleClose());
          res.on("error", (e) => this.handleError(e));
          resolveStart();
        }
      );

      req.on("error", (e) => {
        if (!this.started) rejectStart(e);
        else this.handleError(e);
      });

      // Pipe outbound frames into the request body. PassThrough lets us
      // write frames as they arrive from the MCP server.
      this.outbound.pipe(req);

      // Send the register frame first so the main server can identify this shim.
      this.writeFrame(this.registerFrame);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const frame: RpcFrame = { type: "rpc", payload: message };
    this.writeFrame(frame);
  }

  // Demo-only side channel: lets the shim push internal events to the UI.
  emitEvent(source: string, level: "info" | "detail", message: string): void {
    const frame: EventFrame = { type: "event", source, level, message, ts: Date.now() };
    this.writeFrame(frame);
  }

  emitToken(source: string, queryId: string, seq: number, delta: string, done = false): void {
    const frame: TokenFrame = { type: "token", source, queryId, seq, delta, done };
    this.writeFrame(frame);
  }

  // Demo-only: send a non-RPC frame back through the tunnel (doc-read/write responses).
  sendFrame(frame: TunnelFrame): void {
    this.writeFrame(frame);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.outbound.end();
    this.onclose?.();
  }

  private writeFrame(frame: TunnelFrame): void {
    this.outbound.write(JSON.stringify(frame) + "\n");
  }

  private handleInboundChunk(chunk: string): void {
    this.inboundBuffer += chunk;
    let idx: number;
    while ((idx = this.inboundBuffer.indexOf("\n")) !== -1) {
      const line = this.inboundBuffer.slice(0, idx).trim();
      this.inboundBuffer = this.inboundBuffer.slice(idx + 1);
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
        this.handleError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  private handleError(err: Error): void {
    this.onerror?.(err);
  }
}
