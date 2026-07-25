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
// Reconnect orchestration lives in index.ts (scheduleAutoReconnect /
// connectTunnel). Both failure modes — WS handshake rejection (e.g. 502)
// and mid-session close — feed into the same backoff path. Set
// policy.reconnect.enabled=false in connector.yaml to opt out.
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

  // Hard cap on the WS handshake. A network outage or a half-open TLS
  // socket can leave a dial hanging for minutes (we observed 4 min before
  // the OS finally fired ECONNRESET) which strands the connector in
  // reconnecting=true and makes the manual Reconnect button feel dead.
  // 10s is generous — a healthy controller responds in ~300ms.
  private static readonly DIAL_TIMEOUT_MS = 10_000;

  constructor(
    private readonly url: string,
    private readonly authToken?: string,
    private readonly connectorName?: string,
    private readonly authProvider?: { accessToken(): Promise<string> }
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

    // Controller URL → WS URL. Upgrade scheme then default the path to
    // /mcp-tunnel when none is set; the controller dispatches /crelay and
    // /mcp-tunnel on a single port so the path is now part of the contract.
    // Honour an explicit path if the operator sets one (useful for tests
    // dialling localhost directly).
    const upgraded = this.url.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
    const parsed = new URL(upgraded);
    if (parsed.pathname === "" || parsed.pathname === "/") {
      parsed.pathname = "/mcp-tunnel";
    }
    const wsUrl = parsed.toString();
    const headers: Record<string, string> = {};
    if (this.authProvider) {
      headers["authorization"] = `Bearer ${await this.authProvider.accessToken()}`;
    } else if (this.authToken) {
      headers["authorization"] = `Bearer ${this.authToken}`;
    }
    if (this.connectorName) headers["x-connector-name"] = this.connectorName;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers });
      this.ws = ws;

      // Pre-settlement flag. Any error that fires BEFORE the WS handshake
      // resolves is a recoverable dial failure and should reject the connect
      // Promise so the caller can log it at WARN via formatHandshakeFailure.
      // We CANNOT rely on `ws.readyState === CONNECTING` for this — the ws
      // library transitions state to CLOSING before emitting 'error' on
      // pre-open TCP failures (e.g. ECONNREFUSED from Node's happy-eyeballs
      // dial), so that check misclassifies the error as post-open and lets
      // it escape to `this.onerror` → ERROR-level log with a full stack.
      let settled = false;

      // Dial-timeout. Without this, a half-open TLS handshake can hang
      // for the kernel TCP timeout (~4min) and the connector sits stuck
      // in reconnecting=true. 10s is the hard cap.
      const timeoutMs = TunnelClient.DIAL_TIMEOUT_MS;
      const dialTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Abort the dial. terminate() forces a close even mid-handshake,
        // which the existing 'close' handler picks up.
        try { ws.terminate(); } catch { /* swallow */ }
        reject(new Error(`Tunnel dial timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const clearDialTimer = (): void => clearTimeout(dialTimer);

      ws.once("open", () => {
        clearDialTimer();
        settled = true;
        this.setState("open");
        resolve();
      });
      ws.once("unexpected-response", (_req, res) => {
        clearDialTimer();
        if (settled) return;
        settled = true;
        reject(new Error(`Tunnel rejected with status ${res.statusCode}`));
      });
      ws.on("error", (error) => {
        if (!settled) {
          clearDialTimer();
          settled = true;
          reject(error);
        } else {
          this.onerror?.(error);
        }
      });
      ws.on("close", () => {
        clearDialTimer();
        this.handleClose();
      });
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
    } catch (error) {
      this.onerror?.(new Error(`malformed frame: ${(error as Error).message}`));
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
