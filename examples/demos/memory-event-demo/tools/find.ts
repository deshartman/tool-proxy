// The resolve half of memory injection, via the MCP-tool path. Mirrors the
// controller's identity.find action — see docs/CONTROLLER-ACTIONS.md
// §identity.find in the controller repo, and ./invoke.ts for the write half.
//
// Lookup-only, never find-or-create: an unknown customer comes back as
// `identity: null`, which is a NORMAL answer meaning "we've never interacted
// with this person", not an error. See the description text below — a caller
// that logs-and-drops the null has misread it.

import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { callControllerApi } from "@mcp-shim/connector/sdk";

const InputSchema = {
  identifier: z.string().describe("The customer reference in YOUR namespace — a phone number, email, or webchat UID"),
  // REQUIRED and never derived. The controller's normalisation is kind-aware
  // (lowercase for email, trim-only for phone and webchat-uid), so an exact
  // lookup is impossible without knowing the kind. Sniffing it from the string
  // shape is what the retired `customer` field did, and is exactly why opaque
  // webchat UIDs were unreachable. `test-harness` is refused on input — it's a
  // controller-internal construct that can still appear in a returned alias.
  channel: z.enum(["phone", "email", "webchat-uid"]).describe("Identifier kind; required, never inferred"),
};

// One shared record shape across find and list, so callers parse one type.
const IdentitySummary = {
  identityId: z.string(),
  isTemp: z.boolean().describe("false once a CRM hydration confirmed it"),
  provider: z.string().describe("'postgres' for controller-native identities"),
  externalRef: z.string().describe("Self-equal when provider is 'postgres' — read it WITH provider"),
  aliases: z.array(z.object({ channel: z.string(), value: z.string() })),
  lastEngagedAt: z.string().nullable().describe("ISO 8601, across ALL agents"),
  sessionCount: z.number().describe("All-time, across ALL agents"),
};

const OutputSchema = {
  // Nullable, not optional-and-absent: "we looked and found nobody" is a real
  // answer the caller has to branch on.
  identity: z.object(IdentitySummary).nullable(),
};

export const find: Tool = {
  name: "find",
  register(server) {
    server.registerTool(
      "find",
      {
        title: "Demo: resolve one customer identifier to an identityId",
        description:
          "Calls identity.find on the controller via callControllerApi. Exact match, 0 or 1 result. " +
          "A null `identity` is a normal answer meaning the controller has never interacted with this " +
          "customer — there is no conversation history to inject a note into, so the correct alternative " +
          "is to place an outbound call with the fact in callContext instead. Lookup never creates.",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ identifier, channel }) => {
        try {
          // 8s default is fine — an exact single-row lookup, no LLM turn.
          const result = (await callControllerApi("identity.find", { identifier, channel })) as {
            identity: unknown | null;
          };
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

export default find;
