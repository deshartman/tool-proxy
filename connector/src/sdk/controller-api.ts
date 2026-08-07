// v1.4 — Controller API calls (Twilio-bundled only).
//
// Lets a Twilio-authored bundled MCP's own tool handler invoke a named
// controller-side action and get a typed result back, synchronously,
// before its own tool call returns. Thin wrapper around the inspector's
// loopback route (POST /internal/controller-api/call), which forwards the
// call over the tunnel as a controller-call frame and awaits the matching
// controller-call-response. See docs/MCP-PROTOCOL.md
// §"v1.4 — Controller API calls (Twilio-bundled only)" for the wire
// contract.
//
//   import { callControllerApi } from "@mcp-shim/connector/sdk";
//
//   const result = await callControllerApi("memory.append_event", { customerId, event });
//
// Only Twilio-authored bundled MCPs may call this — the connector's
// isAuthorTwilio gate rejects everything else with a "not_authorized"
// error before the call ever reaches the tunnel. Customer drop-ins have no
// access in this iteration.
//
// Timeout is per-call, connector-side only, default 8s. Pass
// { timeoutMs } for any action known to do real work before answering
// (e.g. an LLM turn in the critical path) — don't rely on the default for
// anything but simple/fast actions. On timeout (or any other failure) this
// rejects with an Error carrying a `code` property (e.g. "timeout",
// "tunnel_unavailable", or whatever the controller's action returned).

import { envNumber } from "../env.js";

export interface CallControllerApiOptions {
  timeoutMs?: number;
}

interface ControllerApiCallResponseBody {
  result?: unknown;
  error?: { code: string; message: string };
}

export async function callControllerApi(
  action: string,
  params: unknown,
  opts?: CallControllerApiOptions,
): Promise<unknown> {
  const port = envNumber("INSPECTOR_PORT", 9090);
  const token = process.env.MCP_WEBHOOK_TOKEN;
  const res = await fetch(`http://127.0.0.1:${port}/internal/controller-api/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // F3: inspector CSRF guard requires this header on state-changing POSTs.
      "x-inspector-request": "1",
      // F7: same per-MCP identity token webhook ingress uses.
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action, params, timeoutMs: opts?.timeoutMs }),
  });
  const body = (await res.json()) as ControllerApiCallResponseBody;
  if (!res.ok) {
    throw Object.assign(new Error(body.error?.message ?? "controller-call failed"), { code: body.error?.code });
  }
  return body.result;
}
