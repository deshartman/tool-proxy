// Smoke test for the v1.4 controller-call tunnel mechanism
// (docs/MCP-PROTOCOL.md §"v1.4 — Controller API calls (Twilio-bundled
// only)"), targeting memory.inject_context. Standalone demo bundle, not
// agentic-memory: this action's error vocabulary (invalid_params/
// cross_account/controller_error) doesn't fit agentic-memory's
// MEMORY-MCP-INTERFACE.md-pinned ErrorCode union.
//
// See ../invoke.mjs for the driver script, and ./list.ts for the resolve half of
// the flow — injection takes an opaque identityId, never an address.

import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { callControllerApi } from "@mcp-shim/connector/sdk";

// Mirrors the controller's memory.inject_context params literally — keep in
// step with docs/CONTROLLER-ACTIONS.md §memory.inject_context in the
// controller repo. Its schema is `.strict()`, so a stray key (the retired
// `identity` pair or flat `customer` string, `channelId`, a `type` tier
// selector) is rejected with invalid_params rather than ignored.
const InputSchema = {
  // REQUIRED. Working memory is keyed (accountId, agentId, identityKey) —
  // there is no way to write it without naming an agent. The controller
  // resolves this account-scoped and answers cross_account if the agent
  // belongs to a different account than the tunnel session.
  agentId: z.string().describe("The agent whose working memory receives the note"),
  // REQUIRED, and an opaque handle — NOT an address. Resolve one with the
  // `list` tool first. The previous contract took the address here and resolved
  // it internally, but that resolve was find-or-create: a typo minted a phantom
  // customer and the write silently "succeeded".
  identityId: z.string().describe("Opaque identity handle from the `list` tool — not a phone number or email"),
  event: z.string().describe("The fact, e.g. \"your flight is delayed\""),
  occurredAt: z.string().optional().describe("ISO 8601; defaults to now"),
  // Governs how long the working row is held open. The controller defaults 600s
  // (= its quietFlushMs). Its range policy is ASYMMETRIC: above 86400s is clamped
  // (its absolute-age sweeper flushes a working row at 24h regardless of
  // activity, so a longer promise would be a lie — read `expiresAt` for the
  // post-clamp truth), but 0, negative, and fractional values are REJECTED with
  // invalid_params. Raise it when you want inject-then-wait-for-INBOUND rather
  // than inject-then-outbound.
  //
  // Genuine multi-turn shelf life: a live note survives successive turns, so the
  // agent may raise the fact MORE THAN ONCE inside the window — keep it tight when
  // that matters. (Consume-once was tried and failed live: a customer's opening
  // greeting spent the note before the turn that needed it.)
  ttlSeconds: z.number().optional().describe("Shelf life in seconds; default 600. Survives successive turns, so the fact may be raised more than once. >86400 is clamped; 0/negative/fractional are rejected"),
  // Optional and NOT deduped by the controller in v1 — a retry-after-timeout
  // can create a duplicate note, explicitly accepted as low-harm. No hard
  // requirement to generate one, unlike the dial-twice-is-real-money case
  // outbound.place_call's own params carry an idempotencyKey for.
  idempotencyKey: z.string().optional(),
};

const OutputSchema = {
  stored: z.boolean().optional(),
  // Post-clamp, so it can differ from what ttlSeconds implied.
  expiresAt: z.string().optional(),
};

export const invoke: Tool = {
  name: "invoke",
  register(server) {
    server.registerTool(
      "invoke",
      {
        title: "Demo: invoke the controller's memory.inject_context action",
        description:
          "Calls memory.inject_context on the controller via callControllerApi and returns its result. " +
          "Writes a real note into the named agent's working memory for the given identityId — " +
          "resolve one with the `list` tool first; this action does not accept an address.",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ agentId, identityId, event, occurredAt, ttlSeconds, idempotencyKey }) => {
        try {
          // Default ~8s timeout is fine here — memory.inject_context is a fast
          // identity-resolve plus row write, not an LLM-turn-gated action like
          // outbound.*, so no { timeoutMs } override is passed.
          const result = (await callControllerApi("memory.inject_context", {
            agentId,
            identityId,
            event,
            ...(occurredAt ? { occurredAt } : {}),
            ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          })) as { stored?: boolean; expiresAt?: string };
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
