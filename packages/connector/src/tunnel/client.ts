import WebSocket, { type RawData } from "ws";
import type { InboundTunnelFrame, TunnelFrame } from "./frames.js";

export type WsState = "connecting" | "open" | "closed";
export type FrameDirection = "out" | "in";
export interface FrameTap {
  ts: number;
  direction: FrameDirection;
  frame: InboundTunnelFrame | TunnelFrame;
}

// Outbound-only WSS client.
//
// Dials the controller, sends one frame per text WS message. The MCP SDK
// (used inbound by the dispatcher) does its own JSON-RPC framing inside
// `rpc` payloads; this layer is just typed-frame transport.
//
// Reconnect / heartbeat-miss recovery is intentionally NOT implemented this
// branch. On unexpected close the process exits 1 — let the supervisor
// restart it. See plan's "Out of scope" section.
export class TunnelClient {
  onframe?: (frame: InboundTunnelFrame) => void;
  onclose?: () => void;
  onerror?: (err: Error) => void;
  // Inspector hook: every frame in/out, plus state transitions. Optional.
  ontap?: (tap: FrameTap) => void;
  onstate?: (state: WsState) => void;

  private ws?: WebSocket;
  private opened = false;
  private closed = false;
  private _state: WsState = "connecting";

  constructor(
    private readonly url: string,
    private readonly authToken?: string
  ) {}

  get state(): WsState { return this._state; }
  get controllerUrl(): string { return this.url; }

  private setState(next: WsState): void {
    if (this._state === next) return;
    this._state = next;
    this.onstate?.(next);
  }

  async connect(): Promise<void> {
    if (this.opened) return;
    this.opened = true;

    const wsUrl = this.url.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
    const headers: Record<string, string> = {};
    if (this.authToken) headers["authorization"] = `Bearer ${this.authToken}`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers });
      this.ws = ws;

      ws.once("open", () => {
        this.setState("open");
        resolve();
      });
      ws.once("unexpected-response", (_req, res) => {
        reject(new Error(`Tunnel rejected with status ${res.statusCode}`));
      });
      ws.on("error", (e) => {
        if (ws.readyState === WebSocket.CONNECTING) reject(e);
        else this.onerror?.(e);
      });
      ws.on("close", () => this.handleClose());
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        this.handleMessage(rawDataToString(data));
      });
    });
  }

  send(frame: TunnelFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
    this.ontap?.({ ts: Date.now(), direction: "out", frame });
  }

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: "goodbye", reason });
    }
    this.ws?.close();
    this.ws = undefined;
  }

  private handleMessage(line: string): void {
    let frame: InboundTunnelFrame;
    try {
      frame = JSON.parse(line) as InboundTunnelFrame;
    } catch (e) {
      this.onerror?.(new Error(`malformed frame: ${(e as Error).message}`));
      return;
    }
    this.ontap?.({ ts: Date.now(), direction: "in", frame });
    this.onframe?.(frame);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.setState("closed");
    this.onclose?.();
  }
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}
