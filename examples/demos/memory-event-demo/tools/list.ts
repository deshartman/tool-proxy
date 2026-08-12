// Browse, search, AND resolve the account's identities. Mirrors the controller's
// identity.list action; see docs/CONTROLLER-ACTIONS.md §identity.list in the
// controller repo.
//
// This is the only identity lookup there is. A sibling identity.find did the
// exact single-row version until the controller merged them: `identifier` is a
// case-insensitive SUBSTRING and an exact address is a substring of itself, so
// one predicate serves both browse and resolve rather than two query paths that
// could drift over the same data.
//
// THAT MERGE HAS A SHARP EDGE FOR RESOLVE. A full address can match MORE THAN ONE
// row — `identifier: "des@example.com"` also matches `des@example.com.au`. So
// never take identities[0] as "the" customer: compare each result's `aliases`
// (always the FULL set per identity, never narrowed by the query) against the
// address you asked about. An empty array means unknown customer, which is a
// normal answer, not an error.
//
// TWO MORE SHARP EDGES, both deliberate controller-side:
//   - No cap and no cursor. Omitting `limit` returns the account's ENTIRE
//     identity set. Capping at 100 was considered and rejected because a silent
//     truncation is indistinguishable from "that's all of them", whereas an
//     unbounded call can be slow but cannot lie.
//   - The binding constraint is therefore the TIMEOUT, not response size, and a
//     timeout returns NOTHING rather than a partial list. This tool raises the
//     coordinator's 8s default to 30s for that reason. On the MCP-tool path the
//     connector's own policy.tool_timeout_ms (5s default!) fires first — see
//     ../README.md for the yaml change.
//
// DO NOT RETRY ON TIMEOUT. There's no cancellation path: the controller's query
// runs to completion and replies onto a requestId already discarded, so a retry
// loop stacks abandoned full-account scans on it while the caller sees only
// failures. Raise the timeout (or narrow with identifier/channel) instead.

import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";
import { callControllerApi } from "@mcp-shim/connector/sdk";

const InputSchema = {
  identifier: z.string().optional().describe("Case-insensitive SUBSTRING on alias values — may match several identities"),
  channel: z.enum(["phone", "email", "webchat-uid"]).optional().describe("Optional narrowing; omit for any kind"),
  // Deliberately no default. Substituting one here would reintroduce exactly the
  // silent truncation the controller refused to ship.
  limit: z.number().optional().describe("OMIT to get the account's full identity set"),
};

const OutputSchema = {
  identities: z.array(
    z.object({
      identityId: z.string(),
      isTemp: z.boolean(),
      provider: z.string(),
      externalRef: z.string(),
      // Always the FULL alias set, never narrowed by identifier/channel — search by
      // email and you still get their phone. You asked to resolve a customer, so
      // you get the record, not an echo of the query.
      aliases: z.array(z.object({ channel: z.string(), value: z.string() })),
      lastEngagedAt: z.string().nullable(),
      sessionCount: z.number(),
    }),
  ),
};

const LIST_TIMEOUT_MS = 30_000;

export const list: Tool = {
  name: "list",
  register(server) {
    server.registerTool(
      "list",
      {
        title: "Demo: browse the account's identities",
        description:
          "Calls identity.list on the controller via callControllerApi. Account-scoped, newest first. " +
          "There is no server-side cap: omitting `limit` returns every identity in the account, so a " +
          "large account can exceed the timeout — and a timeout yields nothing, not a partial list.",
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
      },
      async ({ identifier, channel, limit }) => {
        try {
          const result = (await callControllerApi(
            "identity.list",
            {
              ...(identifier ? { identifier } : {}),
              ...(channel ? { channel } : {}),
              ...(limit !== undefined ? { limit } : {}),
            },
            { timeoutMs: LIST_TIMEOUT_MS },
          )) as { identities: unknown[] };
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

export default list;
