// DEMO-ONLY: fan-out shim events to a local "demo-ui" process so the laptop
// browser can render a shim-side view side-by-side with the cloud's view.
//
// In production this code path is dormant: if DEMO_UI_URL is unset (the
// default), createDemoUiSink returns no-op closures and no HTTP traffic
// leaves the shim toward localhost.
//
// Wire shape: one POST /events per emit, body = single NDJSON line.
// Fire-and-forget — failures are logged once but the agent loop is never
// blocked or retried.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import type { UiEvent, UiPayload, UiTokenEvent } from "@mcp-shim/shared";

export interface DemoUiSink {
  emit: (level: "info" | "detail", message: string) => void;
  emitToken: (queryId: string, seq: number, delta: string, done?: boolean) => void;
  publishCloudLike: (message: string) => void;
}

export function createDemoUiSink(opts: {
  shimId: string;
  url?: string;
  token?: string;
}): DemoUiSink {
  const noop: DemoUiSink = {
    emit: () => {},
    emitToken: () => {},
    publishCloudLike: () => {},
  };
  if (!opts.url) return noop;

  const target = new URL(opts.url.replace(/\/$/, "") + "/events");
  const dial = target.protocol === "https:" ? httpsRequest : httpRequest;
  const headers: Record<string, string> = { "content-type": "application/x-ndjson" };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;

  let warned = false;
  const post = (payload: UiPayload) => {
    const req = dial(
      {
        method: "POST",
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname,
        headers,
      },
      (res) => {
        // Drain so node frees the socket. We don't care about the body.
        res.on("data", () => {});
        res.on("end", () => {});
      }
    );
    req.on("error", (e: Error) => {
      if (!warned) {
        console.warn(`[${opts.shimId}] demo-ui sink unreachable: ${e.message} — continuing without it`);
        warned = true;
      }
    });
    req.end(JSON.stringify(payload) + "\n");
  };

  return {
    emit: (level, message) => {
      const ev: UiEvent = {
        source: opts.shimId,
        panel: "shim",
        level,
        message,
        ts: Date.now(),
      };
      post(ev);
    },
    emitToken: (queryId, seq, delta, done) => {
      const tok: UiTokenEvent = {
        kind: "token",
        queryId,
        source: opts.shimId,
        seq,
        delta,
        done,
      };
      post(tok);
    },
    // Synthesize the cloud-side events the shim view needs (e.g. the
    // "incoming request" pulse). The cloud emits these on its own bus; we
    // mirror them here for the laptop tab.
    publishCloudLike: (message) => {
      const ev: UiEvent = {
        source: "main",
        panel: "cloud",
        level: "info",
        message,
        ts: Date.now(),
      };
      post(ev);
    },
  };
}
