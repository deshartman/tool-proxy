// Smoke test for the v1.4 controller-call tunnel mechanism
// (docs/MCP-PROTOCOL.md §"v1.4 — Controller API calls (Twilio-bundled
// only)"). This is a standalone demo bundle, not agentic-memory, because
// outbound calling has its own error vocabulary (docs/CONTROLLER-ACTIONS.md)
// that doesn't fit agentic-memory's MEMORY-MCP-INTERFACE.md-pinned
// ErrorCode union.
//
// CAUTION: this places/sends a REAL call/message through whatever
// agent/channel the controller resolves for agentId/channelId — not a
// simulation. See ../invoke.mjs for the driver script.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { callControllerApi } from "@mcp-shim/connector/sdk";

const InputSchema = {
  action: z.enum(["place_call", "send_message"]),
  agentId: z.string(),
  channelId: z.string(),
  to: z.string().describe("E.164 phone number"),
  callContext: z.record(z.string(), z.string()).optional(),
};

const OutputSchema = {
  success: z.boolean(),
  callSid: z.string().optional(),
  providerId: z.string().optional(),
};

// idempotencyKey is generated here, not accepted as input — per
// docs/CONTROLLER-ACTIONS.md, generating and owning the dedup key is the
// calling bundle's responsibility, not the caller's.
export const invoke: Tool = {
  name: "invoke",
  register(server) {
    server.registerTool(
      "invoke",
      {
        title: "Demo: invoke a controller-side outbound action",
        description:
          "Calls outbound.place_call or outbound.send_message on the controller via callControllerApi " +
          "and returns its result. Places/sends a REAL call/message — not a simulation.",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ action, agentId, channelId, to, callContext }) => {
        const wireAction = action === "place_call" ? "outbound.place_call" : "outbound.send_message";
        const idempotencyKey = randomUUID();
        try {
          const result = (await callControllerApi(
            wireAction,
            { agentId, channelId, to, ...(callContext ? { callContext } : {}), idempotencyKey },
            { timeoutMs: 30_000 },
          )) as { callSid?: string; providerId?: string };
          const data = { success: true, ...result };
          return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
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
