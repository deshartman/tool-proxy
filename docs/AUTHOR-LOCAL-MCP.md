# Author a local MCP

> Drop a folder under `mcp/local/<name>/tools/` with one or more tool files. That's it. The connector picks it up at boot — or at runtime via the **Refresh local MCPs** button.
>
> No `server.ts`, no `package.json`, no `.env`, no `connector.yaml` edit.

## What you write

```
mcp/local/<name>/
└── tools/
    └── <tool>.ts        ← one file per tool, default-exports a Tool
```

The folder name (`<name>`) becomes the MCP's name. Each tool file default-exports a `Tool` object — the connector's drop-in scanner ([packages/connector/src/dropin.ts](../packages/connector/src/dropin.ts)) discovers it, and the synthesized child runtime ([packages/connector/src/sdk/dropin-runner.ts](../packages/connector/src/sdk/dropin-runner.ts)) wires every tool into a per-folder subprocess.

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

1. **Each tool file default-exports a `Tool` object.** Named exports work too — the runner picks the first one matching the Tool shape.
2. **Tools we author declare `outputSchema`.** Lets controller-side procedure authors write `{{ hydrate:<server>.<tool>.<field> }}` and have it type-checked.
3. **Wrap single-scalar outputs in `{ value }`.** Stable field name regardless of tool semantics — see [`mcp/local/sample/tools/now.ts`](../mcp/local/sample/tools/now.ts) for the canonical example.
4. **Return `structuredContent` AND `content`.** The first is the schema-typed JSON; the second is the human-readable rendering.
5. **`envKeys` lists the env vars your tool reads.** Optional but strongly recommended — the controller UI uses it to render the right form fields.

## Live examples

- [`mcp/local/sample/tools/`](../mcp/local/sample/tools/) — `now`, `slow_echo`, `uuid`, `weather`. No external services.
- [`mcp/local/crm/tools/`](../mcp/local/crm/tools/) — `get_customer`, `get_recent`, `issue_refund`, plus calendar helpers. Thin client over the mock customer service at [mock/customers/](../mock/customers/).

Both are live drop-ins — no `server.ts`, no `package.json`, no yaml entry.

## Cross-references

- [packages/connector/README.md](../packages/connector/README.md) — connector overview + boot / build / inspect.
- [docs/MCP-PROTOCOL.md](MCP-PROTOCOL.md) — wire-format contract between connector and controller. §"v1.2 — Local MCP rescan" describes the **Refresh local MCPs** frame.
- [.claude/plans/Done/MCP-LOADING-LOCAL.md](../.claude/plans/Done/MCP-LOADING-LOCAL.md) — design plan for the local-MCP track.
- [CLAUDE.md](../CLAUDE.md) — connector architecture, "Three MCP integration patterns" section.
