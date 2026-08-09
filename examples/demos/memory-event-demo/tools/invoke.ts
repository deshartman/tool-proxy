// Smoke test for the v1.4 controller-call tunnel mechanism
// (docs/MCP-PROTOCOL.md §"v1.4 — Controller API calls (Twilio-bundled
// only)"), targeting memory.append_event. Standalone demo bundle, not
// agentic-memory: this action's error vocabulary (invalid_params/
// controller_error) doesn't fit agentic-memory's MEMORY-MCP-INTERFACE.md-
// pinned ErrorCode union.
//
// See ../invoke.mjs for the driver script.

import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { callControllerApi } from "@mcp-shim/connector/sdk";

// Mirrors the controller's own IDENTITY_CHANNEL_KINDS
// (server/src/memory/append-event-controller-action.ts) literal-for-literal.
// Keep in sync if that list changes — the controller rejects anything else
// with invalid_params before this tool ever hears back.
const IdentityChannel = z.enum([
  "voice",
  "sms",
  "rcs",
  "mms",
  "whatsapp",
  "webchat",
  "email",
  "chat",
  "test-harness",
]);

const InputSchema = {
  identity: z.object({
    channel: IdentityChannel,
    value: z.string(),
  }),
  event: z.string().describe("The fact, stored verbatim, e.g. \"your flight is delayed\""),
  occurredAt: z.string().optional().describe("ISO 8601; defaults to now"),
  // Optional and NOT deduped by the controller in v1 — a retry-after-timeout
  // can create a duplicate entry, explicitly accepted as low-harm. No hard
  // requirement to generate one, unlike the dial-twice-is-real-money case
  // outbound.place_call's own params carry an idempotencyKey for.
  idempotencyKey: z.string().optional(),
};

const OutputSchema = {
  identityId: z.string().optional(),
  stored: z.boolean().optional(),
};

export const invoke: Tool = {
  name: "invoke",
  register(server) {
    server.registerTool(
      "invoke",
      {
        title: "Demo: invoke the controller's memory.append_event action",
        description:
          "Calls memory.append_event on the controller via callControllerApi and returns its result. " +
          "Writes a real episodic memory entry against whatever identity the controller resolves.",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ identity, event, occurredAt, idempotencyKey }) => {
        try {
          // Default ~8s timeout is fine here — memory.append_event is a fast
          // identity-resolve + episodic write, not an LLM-turn-gated action
          // like outbound.*, so no { timeoutMs } override is passed.
          const result = (await callControllerApi("memory.append_event", {
            identity,
            event,
            ...(occurredAt ? { occurredAt } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          })) as { identityId?: string; stored?: boolean };
          return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (err) {
          const code = (err as { code?: string }).code ?? "controller_error";
          const message = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
          };
        }
      },
    );
  },
};

export default invoke;
