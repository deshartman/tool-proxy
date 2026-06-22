# Author a local MCP

> Drop a folder under `mcp/local/<name>/` with one or more tool files (and optionally prompts and resources). That's it. The connector picks it up at boot — or at runtime via the **Refresh local MCPs** button.
>
> No `server.ts`, no `package.json`, no `.env`, no `connector.yaml` edit.

## What you write

```
mcp/local/<name>/
├── tools/                ← one file per tool, default-exports a Tool
│   └── <tool>.ts
├── prompts/              ← (optional) one file per prompt, default-exports a Prompt
│   └── <prompt>.ts
└── resources/            ← (optional) one file per resource, default-exports a Resource
    └── <resource>.ts
```

The folder name (`<name>`) becomes the MCP's name. Each file default-exports a `Tool`, `Prompt`, or `Resource` object — the connector's drop-in scanner ([packages/connector/src/dropin.ts](../packages/connector/src/dropin.ts)) discovers the folder, and the synthesized child runtime ([packages/connector/src/sdk/dropin-runner.ts](../packages/connector/src/sdk/dropin-runner.ts)) wires every item into a per-folder subprocess. The three sibling categories are independently optional — a tools-only folder is the most common shape.

**Why split prompts and resources from tools.** They are different in kind:

- **Tools** = side-effecting operations a procedure invokes (`messages_create`, `issue_refund`).
- **Prompts** = parameterised templates the controller's procedure-author UI consumes; one prompt per author-supplied template, version-controlled with your tool code.
- **Resources** = read-only canonical state surfaced as named, citeable artefacts (`sample://uuids/recent`). Procedures read them via `resources/read` instead of burning a tool call. Authors that need server-pushed freshness signal `subscribe: true` on the underlying SDK call so the connector forwards `notifications/resources/updated` upstream.

## Minimal example

```ts
// mcp/local/orders/tools/get-order.ts
import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

const OutputSchema = {
  orderId: z.string(),
  status: z.enum(["pending", "shipped", "delivered"]),
  total: z.number(),
};

const getOrder: Tool = {
  name: "get_order",
  envKeys: ["ORDERS_API_URL", "ORDERS_API_TOKEN"],
  register(server) {
    server.registerTool(
      "get_order",
      {
        description: "Look up an order by id.",
        inputSchema: { orderId: z.string() },
        outputSchema: OutputSchema,
      },
      async ({ orderId }) => {
        const url = `${process.env.ORDERS_API_URL}/orders/${orderId}`;
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${process.env.ORDERS_API_TOKEN}` },
        });
        const data = await res.json();
        return {
          structuredContent: data,
          content: [{ type: "text", text: JSON.stringify(data) }],
        };
      },
    );
  },
};

export default getOrder;
```

That's the whole file. Save it, restart the connector (or click **Refresh local MCPs**), and `get_order` is live.

## Prompts (optional)

A `Prompt` mirrors the `Tool` interface — one module per prompt, default-exported, with a `register(server)` that calls the SDK's `registerPrompt`. Args use zod for validation + auto-generated descriptions on `prompts/list`.

```ts
// mcp/local/orders/prompts/refund-summary.ts
import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";

const refundSummary: Prompt = {
  name: "refund_summary",
  register(server) {
    server.registerPrompt(
      "refund_summary",
      {
        description: "Compose a customer-facing refund confirmation message.",
        argsSchema: {
          orderId: z.string().describe("Order id, e.g. \"ORD_4823\"."),
          amount: z.string().describe("Refund amount, formatted with currency, e.g. \"$42.50\"."),
        },
      },
      ({ orderId, amount }) => ({
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Use orders.get_order to fetch ${orderId}, then compose a one-paragraph confirmation that the ${amount} refund was issued. Reference the order's items by name.`,
          },
        }],
      }),
    );
  },
};

export default refundSummary;
```

The controller's procedure-author UI lists `orders.refund_summary` under Prompts and lets a procedure author invoke it by name.

## Resources (optional)

A `Resource` lets a procedure read read-only canonical state via `resources/read` instead of burning a tool call. URI scheme is your choice; pick one that's specific to your MCP (`orders://recent`, `crm://customers/{id}`).

```ts
// mcp/local/orders/resources/recent-orders.ts
import type { Resource } from "@mcp-shim/connector/sdk";

const recent: string[] = [];
export function recordOrder(id: string): void {
  recent.unshift(id);
  if (recent.length > 16) recent.length = 16;
}

const recentOrders: Resource = {
  name: "recent_orders",
  register(server) {
    server.registerResource(
      "recent_orders",
      "orders://recent",
      {
        title: "Recent orders",
        description: "The 16 most recent orders this MCP has touched.",
        mimeType: "application/json",
      },
      async (uri) => ({
        contents: [{
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify({ recent: [...recent] }, null, 2),
        }],
      }),
    );
  },
};

export default recentOrders;
```

Tools in the same folder can `import { recordOrder } from "../resources/recent-orders.js"` and call it on every successful order operation — the resource then reflects the latest state on every read.

For URI templates with variables (e.g. `crm://customers/{id}`), use the SDK's `ResourceTemplate` type — see [`mcp/local/sample/resources/uuids-recent.ts`](../mcp/local/sample/resources/uuids-recent.ts) for the canonical pattern.

## Restart vs. refresh

Two ways to get the connector to pick up a new folder:

| Trigger | When the folder is seen |
|---|---|
| Restart the connector | At boot. Always works. |
| **Refresh local MCPs** (controller UI: Connector detail → MCPs tab) | Live. No restart needed. |
| **Refresh local MCPs** (inspector at <http://localhost:9090/>) | Live, local-dev path. |

Both refresh paths re-run the drop-in scanner, register new folders with the supervisor, fan out a `creds-request` for each, and emit a `manifest-delta` so the controller picks up the new tools.

## Where do creds come from?

Per-MCP env values arrive over the WSS tunnel from the **controller**. Operator enters them in the controller UI under Connector → MCPs → `<your MCP name>`; the controller pushes them down via `creds-response` (boot) or `creds-update` (steady state). The connector merges them into the child process's env and restarts the child if values change.

The `envKeys` array on each `Tool` (or, server-level, on `createMcpHttpServer({ envKeys: [...] })`) tells the controller's UI which keys to surface — the operator never has to guess.

For offline development, you can still use `mcp/local/<name>/.env`. The connector's env merge order is:

```
process.env  ⊕  mcp/local/<name>/.env  ⊕  yaml inline (rare)  ⊕  controller-supplied
                                                                ↑ winner on conflict
```

The plan is to remove the `dir/.env` fallback once every customer has migrated their creds into the controller — the per-spawn `mcp spawn env-sources` log line tracks that progress (the `dirDotEnv: [...]` array trends toward `[]`).

## Need a third-party SDK?

A drop-in folder doesn't ship a `package.json` by default. Framework deps (`zod`, `@mcp-shim/connector/sdk`) resolve up to the connector workspace's `node_modules`. If your tool needs an SDK that isn't already in the workspace (e.g. `axios`, `@salesforce/sf-cli`, `octokit`), `cd` into the folder and:

```bash
npm init -y
npm install <sdk>
```

That creates a local `package.json` + `node_modules` inside the folder. The SDK stays out of the workspace hoist (deliberate — keeps drop-in MCPs from accidentally importing each other's deps). The connector's start-up loop installs them once on first boot.

The Twilio bundle at [`mcp/bundled/twilio/`](../mcp/bundled/twilio/) is the live example of this shape.

## Authoring rules to know

These are pinned by tests at [packages/connector/tests/mcp-tools/](../packages/connector/tests/mcp-tools/) and validated at boot by [src/manifest/validate.ts](../packages/connector/src/manifest/validate.ts):

1. **Each file default-exports a `Tool` / `Prompt` / `Resource` object.** Named exports work too — the runner picks the first one matching the matching shape.
2. **Tools we author declare `outputSchema`.** Lets controller-side procedure authors write `{{ hydrate:<server>.<tool>.<field> }}` and have it type-checked.
3. **Wrap single-scalar outputs in `{ value }`.** Stable field name regardless of tool semantics — see [`mcp/local/sample/tools/now.ts`](../mcp/local/sample/tools/now.ts) for the canonical example.
4. **Return `structuredContent` AND `content`.** The first is the schema-typed JSON; the second is the human-readable rendering.
5. **`envKeys` lists the env vars your tool reads.** Optional but strongly recommended — the controller UI uses it to render the right form fields.
6. **Prompts and resources don't declare `outputSchema`.** That field is tools-only. The MCP protocol's `prompts/get` and `resources/read` are typed by the prompt's `argsSchema` and the resource's `mimeType` respectively.
7. **Pick distinct URI schemes per MCP for resources.** `orders://...`, `crm://...`, `inventory://...`. The connector and controller route resource reads by scheme/host.

## Live examples

- [`mcp/local/sample/`](../mcp/local/sample/) — `tools/` (`now`, `slow_echo`, `uuid`, `weather`), `prompts/weather-briefing.ts`, `resources/uuids-recent.ts`. The fullest worked example — all three sibling categories. No external services.
- [`mcp/local/crm/tools/`](../mcp/local/crm/tools/) — `get_customer`, `get_recent`, `issue_refund`, plus calendar helpers. Thin client over the mock customer service at [mock/customers/](../mock/customers/). Tools-only.

Both are live drop-ins — no `server.ts`, no `package.json`, no yaml entry.

## Cross-references

- [packages/connector/README.md](../packages/connector/README.md) — connector overview + boot / build / inspect.
- [docs/MCP-PROTOCOL.md](MCP-PROTOCOL.md) — wire-format contract between connector and controller. §"v1.2 — MCP server-method extension" covers prompts / resources / completions / logging on the wire; §"v1.2 — Local MCP rescan" describes the **Refresh local MCPs** frame.
- [CLAUDE.md](../CLAUDE.md) — connector architecture, "Three MCP integration patterns" section.
