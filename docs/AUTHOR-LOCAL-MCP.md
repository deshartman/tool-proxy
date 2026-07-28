# Author a local MCP

> Drop a folder under `mcp/local/<name>/` with one or more tool files (and optionally prompts and resources). That's it. The connector picks it up at boot — or at runtime via the **Refresh local MCPs** button.
>
> No `server.ts`, no `package.json`, no `.env`, no `connector.yaml` edit.
>
> **One operator gesture before your tools go live (v1.3+).** After the connector picks up your folder, your MCP appears in the controller UI's "Pending approval" lane. An operator clicks **Approve** (and pastes any `envKeys` values you declared) to enable the tools. See §"Approval — the operator's one click" below.

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

The folder name (`<name>`) becomes the MCP's name. Each file default-exports a `Tool`, `Prompt`, or `Resource` object — the connector's drop-in scanner ([connector/src/dropin.ts](../connector/src/dropin.ts)) discovers the folder, and the synthesized child runtime ([connector/src/sdk/dropin-runner.ts](../connector/src/sdk/dropin-runner.ts)) wires every item into a per-folder subprocess. The three sibling categories are independently optional — a tools-only folder is the most common shape.

**Why split prompts and resources from tools.** They are different in kind:

- **Tools** = side-effecting operations a procedure invokes (`messages_create`, `issue_refund`).
- **Prompts** = parameterised templates the controller's procedure-author UI consumes; one prompt per author-supplied template, version-controlled with your tool code.
- **Resources** = read-only canonical state surfaced as named, citeable artefacts (`sample://uuids/recent`). Procedures read them via `resources/read` instead of burning a tool call. Authors that need server-pushed freshness signal `subscribe: true` on the underlying SDK call so the connector forwards `notifications/resources/updated` upstream.

## Minimal example

```ts
// customer-mcps/orders/tools/get-order.ts
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
// customer-mcps/orders/prompts/refund-summary.ts
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
// customer-mcps/orders/resources/recent-orders.ts
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

For URI templates with variables (e.g. `crm://customers/{id}`), use the SDK's `ResourceTemplate` type — see [`examples/demos/sample/resources/uuids-recent.ts`](../examples/demos/sample/resources/uuids-recent.ts) for the canonical pattern.

## Restart vs. refresh

Two ways to get the connector to pick up a new folder:

| Trigger | When the folder is seen |
|---|---|
| Restart the connector | At boot. Always works. |
| **Refresh local MCPs** (controller UI: Connector detail → MCPs tab) | Live. No restart needed. |
| **Refresh local MCPs** (inspector at <http://localhost:9090/>) | Live, local-dev path. |

Both refresh paths re-run the drop-in scanner, register new folders with the supervisor, fan out an `mcp-discovered` frame for each new drop-in, and (after the operator approves) emit a `manifest-delta` so the controller picks up the new tools.

## Approval — the operator's one click

In v1.3+, customer-authored drop-in MCPs go through an explicit operator approval gate before the LLM can call their tools. The flow:

1. **You drop the folder.** Connector scans `${MCP_DROPIN_DIR}`, spawns the child, lists tools, but **withholds them from the manifest** (because they're customer-authored and not yet approved).
2. **Connector emits `mcp-discovered`** with your MCP's name, the `envKeys` list you declared, and the tool names + descriptions.
3. **Controller UI surfaces the MCP** in a "Pending approval" lane within the connector detail view's custom-MCPs section. The operator sees the tool names + descriptions and an inline form for the `envKeys` you declared.
4. **Operator clicks Approve.** They paste env values inline (or skip — they can be added later via Edit creds).
5. **Controller sends `mcp-enable`** to the connector. The connector merges the env, restarts the child, adds the tools to the manifest, emits a `manifest-delta`.
6. **Tools light up in the LLM's view.** Now callable via the controller's normal procedure dispatch.

After this one-time approval, ongoing creds rotation goes through the existing **Edit creds** path (NOT through repeated approvals). The controller persists the approval row keyed on `(connectorId, mcp-name)`. After every connector restart, the controller automatically re-sends `mcp-enable` — no operator action needed for the replay.

**Disable.** The operator can click **Disable** at any time. The connector drops the tools from the manifest immediately, but the child process keeps running — re-enabling is sub-second (no spawn cost).

**What gates and what doesn't.** Only customer drop-ins (folders under `${MCP_DROPIN_DIR}` with `author: "customer"`) go through the gate. Yaml-listed Type 1 hand-written MCPs and Twilio-bundled MCPs auto-enable as before — the yaml listing IS the acceptance for those. 3rd-party MCPs (added via the controller's New 3rd Party MCP button) are also unaffected — they're already operator-authored.

**Wire details:** see [MCP-PROTOCOL.md §"v1.3 — Customer drop-in approval gate"](MCP-PROTOCOL.md).

## Smoke-testing locally before the admin pastes creds

You drop a folder, the connector picks it up, the inspector lists your tools — but they're tagged **Awaiting config** if you declared `envKeys`. The dev feedback loop closes here:

1. Open the inspector at <http://localhost:9090/>.
2. Click the **purple name** of your MCP (peer to clicking a tool — opens the right pane).
3. Paste your dev creds into the masked fields. Click **Apply (session only)**.
4. Tools flip to **Ready**. Click any tool to bring up its shape + Run button. Smoke-test.

Session creds:
- Live in connector RAM only — never written to disk, never sent to the controller.
- Expire 12 hours after paste. Re-paste resets the timer.
- Layer **below** controller-supplied creds. If an admin later sets the same key in the controller UI, the controller value wins per-key automatically.

This is for the dev's local box; production deployments should always use controller-supplied creds. See [`INSPECTOR.md`](INSPECTOR.md) §"Right pane — MCP creds view" for the full reference.

## Where do creds come from?

Per-MCP env values arrive over the WSS tunnel from the **controller**. Operator enters them in the controller UI under Connector → MCPs → `<your MCP name>`; the controller pushes them down via `mcp-enable` (initial approval, v1.3+) or `creds-update` (steady state). The connector merges them into the child process's env and restarts the child if values change.

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

No in-repo MCP currently uses the third-party-SDK shape.

## Authoring rules to know

These are validated at boot by [src/manifest/validate.ts](../connector/src/manifest/validate.ts):

1. **Each file default-exports a `Tool` / `Prompt` / `Resource` object.** Named exports work too — the runner picks the first one matching the matching shape.
2. **Tools we author declare `outputSchema`.** Lets controller-side procedure authors write `{{ hydrate:<server>.<tool>.<field> }}` and have it type-checked.
3. **Wrap single-scalar outputs in `{ value }`.** Stable field name regardless of tool semantics — see [`examples/demos/sample/tools/now.ts`](../examples/demos/sample/tools/now.ts) for the canonical example.
4. **Return `structuredContent` AND `content`.** The first is the schema-typed JSON; the second is the human-readable rendering.
5. **`envKeys` lists the env vars your tool reads.** Optional but strongly recommended — the controller UI uses it to render the right form fields.
6. **Prompts and resources don't declare `outputSchema`.** That field is tools-only. The MCP protocol's `prompts/get` and `resources/read` are typed by the prompt's `argsSchema` and the resource's `mimeType` respectively.
7. **Pick distinct URI schemes per MCP for resources.** `orders://...`, `crm://...`, `inventory://...`. The connector and controller route resource reads by scheme/host.

## Live examples

- [`examples/demos/sample/`](../examples/demos/sample/) — `tools/` (`now`, `slow_echo`, `uuid`, `weather`), `prompts/weather-briefing.ts`, `resources/uuids-recent.ts`. The fullest worked example — all three sibling categories. No external services. Live drop-in: no `server.ts`, no `package.json`, no yaml entry.

## Cross-references

- [connector/README.md](../connector/README.md) — connector overview + boot / build / inspect.
- [docs/MCP-PROTOCOL.md](MCP-PROTOCOL.md) — wire-format contract between connector and controller. §"v1.2 — MCP server-method extension" covers prompts / resources / completions / logging on the wire; §"v1.2 — Local MCP rescan" describes the **Refresh local MCPs** frame; §"v1.3 — Customer drop-in approval gate" describes the approval handshake.
- [CLAUDE.md](../CLAUDE.md) — connector architecture, "Three MCP integration patterns" section.
