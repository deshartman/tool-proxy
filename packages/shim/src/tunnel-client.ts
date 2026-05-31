import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { EventFrame, RegisterFrame, RpcFrame, TokenFrame, TunnelFrame } from "@mcp-shim/shared";
import WebSocket, { type RawData } from "ws";

// ws gives us a union (Buffer | ArrayBuffer | Buffer[]); collapse it down
// to a string so the rest of the code only deals with text frames.
function wsDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

// Outbound-only tunnel transport.
//
// Models the MCP Tunnels pattern: the shim dials the main server with a
// WebSocket connection. One persistent connection, outbound from the shim,
// no inbound ports. Each WS message carries one JSON-encoded TunnelFrame.
//
// The MAIN_SERVER_URL is given as http(s):// for parity with the previous
// chunked-POST transport; we rewrite it to ws(s):// here so callers don't
// need to think about the underlying scheme.
export class TunnelClientTransport implements Transport {
  onmessage?: (msg: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (err: Error) => void;
  onframe?: (frame: TunnelFrame) => void;

  private ws?: WebSocket;
  private started = false;
  private closed = false;

  constructor(
    private readonly mainServerUrl: string,
    private readonly registerFrame: RegisterFrame,
    private readonly authToken?: string
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const wsUrl = this.mainServerUrl
      .replace(/^http:/i, "ws:")
      .replace(/^https:/i, "wss:");

    const headers: Record<string, string> = {};
    if (this.authToken) headers["authorization"] = `Bearer ${this.authToken}`;

    await new Promise<void>((resolveStart, rejectStart) => {
      const ws = new WebSocket(wsUrl, { headers });
      this.ws = ws;

      ws.once("open", () => {
        this.writeFrame(this.registerFrame);
        resolveStart();
      });

      ws.once("unexpected-response", (_req, res) => {
        rejectStart(new Error(`Tunnel rejected with status ${res.statusCode}`));
      });

      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        this.handleMessage(wsDataToString(data));
      });
      ws.on("error", (e) => {
        if (this.ws?.readyState === WebSocket.CONNECTING) rejectStart(e);
        else this.handleError(e);
      });
      ws.on("close", () => this.handleClose());
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const frame: RpcFrame = { type: "rpc", payload: message };
    this.writeFrame(frame);
  }

  emitEvent(source: string, level: "info" | "detail", message: string): void {
    const frame: EventFrame = { type: "event", source, level, message, ts: Date.now() };
    this.writeFrame(frame);
  }

  emitToken(source: string, queryId: string, seq: number, delta: string, done = false): void {
    const frame: TokenFrame = { type: "token", source, queryId, seq, delta, done };
    this.writeFrame(frame);
  }

  sendFrame(frame: TunnelFrame): void {
    this.writeFrame(frame);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ws?.close();
    this.onclose?.();
    this.ws = undefined;
  }

  private writeFrame(frame: TunnelFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
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
      this.handleError(e instanceof Error ? e : new Error(String(e)));
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
