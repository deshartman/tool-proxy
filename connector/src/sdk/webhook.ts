// Generic webhook ingress for MCP authors.
//
// Use this when an MCP needs to receive inbound HTTPS POSTs (Twilio
// statusCallback, message-status callbacks, recording status, fax, video — any
// upstream API that asks for a public URL). The connector hosts the public
// endpoint on the controller side; you get a stable URL plus a stream of
// events delivered locally via the inspector loopback.
//
//   import { createWebhookEndpoint } from "@mcp-shim/connector/sdk";
//
//   const cb = await createWebhookEndpoint({ mcp: "twilio" });
//   cb.on("callback", ({ body, queryParameters, headers }) => {
//     // store, forward, ack — whatever this MCP needs
//   });
//   await twilio.messages.create({ ..., statusCallback: cb.url });
//
// Lifecycle:
// - `cb.url` is set on `await createWebhookEndpoint(...)` and may change if
//   the connector reconnects (the controller mints a fresh plaintext token
//   per session, though the URL `rowId` stays stable across reissues so a
//   pasted Twilio config keeps resolving). Subscribe to `"url"` to be
//   notified of changes if you cache the URL.
// - `cb.stop()` revokes the allocation and closes the local stream. The
//   controller GCs the row on WS close anyway, but stop() is the explicit
//   teardown path for short-lived MCPs.

import { request as httpRequest, type IncomingMessage } from "node:http";
import { createLogger } from "../logger.js";
import { envNumber } from "../env.js";

const log = createLogger("sdk-webhook");

// Inbound event delivered to listeners on `endpoint.on("callback", fn)`.
//
// IMPORTANT — body is already parsed.
//   The controller normalises the upstream POST before forwarding it on the
//   tunnel: `application/json` bodies are JSON.parse'd; `application/x-www-
//   form-urlencoded` bodies are decoded into an object. Anything else hits a
//   415 at the controller and never reaches the MCP. By the time you receive
//   the event, `body` is the parsed object (or whatever JSON shape the
//   upstream sent — never a string of JSON, never a raw form-encoded string).
//   DO NOT call JSON.parse(body); it will throw.
//
//   `headers["content-type"]` is forwarded for informational purposes only —
//   it tells you what the upstream sent, but it has no bearing on what's in
//   `body` because the controller has already done the parsing. Header
//   forwarding is allowlisted to `X-Twilio-*` (case-insensitive) plus
//   Content-Type; everything else is stripped.
//
// `receivedAt` is the controller's wall-clock at the moment it answered HTTP
// 200 to the upstream — useful for ordering, not authoritative ("the event
// happened at this time" needs to come from `body` fields like Timestamp).
export interface WebhookEvent {
  body: unknown;
  queryParameters: Record<string, string | string[]>;
  headers?: Record<string, string>;
  receivedAt: number;
}

export interface WebhookEndpointOptions {
  // Must match the MCP server name as the connector knows it (the same name
  // that appears in the manifest's ServerDescriptor.name — i.e. the yaml
  // entry's `name:` field for that MCP).
  mcp: string;
  // Override the inspector port. Defaults to process.env.INSPECTOR_PORT, then
  // 9090 (matching the connector default).
  inspectorPort?: number;
}

export type WebhookEventName = "callback" | "url" | "error";

export interface WebhookEndpoint {
  url: string;
  on(event: "callback", listener: (e: WebhookEvent) => void): void;
  on(event: "url", listener: (url: string) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  off(event: WebhookEventName, listener: (...args: unknown[]) => void): void;
  stop(): Promise<void>;
}

export function createWebhookEndpoint(opts: WebhookEndpointOptions): Promise<WebhookEndpoint> {
  const port = opts.inspectorPort ?? envNumber("INSPECTOR_PORT", 9090);
  if (!port || Number.isNaN(port)) {
    return Promise.reject(new Error(
      `inspector port not resolvable. Set INSPECTOR_PORT or pass {inspectorPort} to createWebhookEndpoint. ` +
      `If the connector was started with --no-inspector, webhook ingress is unavailable.`
    ));
  }
  return new Promise<WebhookEndpoint>((resolve, reject) => {
    const callbackListeners = new Set<(e: WebhookEvent) => void>();
    const urlListeners = new Set<(url: string) => void>();
    const errorListeners = new Set<(err: Error) => void>();

    let currentUrl: string | undefined;
    let stopped = false;
    let ssReq: ReturnType<typeof httpRequest> | undefined;
    let ssRes: IncomingMessage | undefined;

    const fail = (err: Error) => {
      if (currentUrl === undefined) {
        // Pre-resolve failure: surface to the awaiter.
        reject(err);
      } else {
        for (const fn of errorListeners) fn(err);
      }
    };

    const open = () => {
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        path: `/internal/webhook/stream?mcp=${encodeURIComponent(opts.mcp)}`,
        method: "GET",
        headers: { accept: "text/event-stream" },
      }, (res) => {
        ssRes = res;
        if (res.statusCode !== 200) {
          fail(new Error(`webhook stream rejected by inspector: HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (chunk: string) => {
          buf += chunk;
          // SSE delimits events with \n\n; split, parse the last full one(s).
          let idx = buf.indexOf("\n\n");
          while (idx >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            handleSseBlock(block);
            idx = buf.indexOf("\n\n");
          }
        });
        res.on("end", () => {
          if (!stopped) log.warn({ mcp: opts.mcp }, `webhook stream closed by connector`);
        });
        res.on("error", (e) => fail(e));
      });
      req.on("error", (e) => fail(e));
      req.end();
      ssReq = req;
    };

    const handleSseBlock = (block: string) => {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (dataLines.length === 0) return;
      let payload: unknown;
      try { payload = JSON.parse(dataLines.join("\n")); }
      catch (error) { fail(new Error(`malformed SSE data: ${(error as Error).message}`)); return; }

      if (event === "url") {
        const url = (payload as { url?: string }).url;
        if (typeof url !== "string") return;
        const isFirst = currentUrl === undefined;
        currentUrl = url;
        if (isFirst) {
          resolve(buildHandle());
        } else {
          for (const fn of urlListeners) fn(url);
        }
      } else if (event === "webhook") {
        for (const fn of callbackListeners) fn(payload as WebhookEvent);
      } else if (event === "error") {
        const message = (payload as { message?: string }).message ?? "unknown error";
        fail(new Error(message));
      }
    };

    const buildHandle = (): WebhookEndpoint => ({
      get url(): string { return currentUrl!; },
      on(event: WebhookEventName, listener: (...args: never[]) => void): void {
        if (event === "callback") callbackListeners.add(listener as (e: WebhookEvent) => void);
        else if (event === "url") urlListeners.add(listener as (url: string) => void);
        else if (event === "error") errorListeners.add(listener as (err: Error) => void);
      },
      off(event: WebhookEventName, listener: (...args: unknown[]) => void): void {
        if (event === "callback") callbackListeners.delete(listener as (e: WebhookEvent) => void);
        else if (event === "url") urlListeners.delete(listener as (url: string) => void);
        else if (event === "error") errorListeners.delete(listener as (err: Error) => void);
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        try { ssRes?.destroy(); } catch { /* ignore */ }
        try { ssReq?.destroy(); } catch { /* ignore */ }
        await postRevoke(port, opts.mcp).catch((e) => log.warn({ err: e as Error, mcp: opts.mcp }, `revoke POST failed`));
      },
    });

    open();
  });
}

function postRevoke(port: number, mcp: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const body = JSON.stringify({ mcp });
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/internal/webhook/revoke",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
