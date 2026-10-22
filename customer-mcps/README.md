# customer-mcps/

Drop your Type 1 MCPs here. Every folder under this directory that contains a `tools/`
subdirectory with at least one `.ts` (or `.js`) file becomes an MCP the connector
spawns, discovers, and forwards to the controller.

## Minimum shape

```
customer-mcps/
└── <name>/
    └── tools/
        └── hello.ts
```

Where `hello.ts` default-exports a `Tool`:

```ts
import { z } from "zod";
import type { Tool } from "@gtmi/toolproxy-connector/sdk";

const tool: Tool<{ who: string }, { greeting: string }> = {
  name: "hello",
  description: "Say hello",
  inputSchema: z.object({ who: z.string() }),
  outputSchema: z.object({ greeting: z.string() }),
  async invoke({ who }) {
    return { greeting: `Hello, ${who}!` };
  },
};
export default tool;
```

The folder name (`<name>`) is the MCP's wire name; tool calls arrive as
`<name>.hello`. Optional siblings `prompts/` and `resources/` follow the same
default-export convention.

## Discovery timing

- Boot: the scanner runs once. Folders present at start-up register immediately.
- Hot rescan: click **Refresh local MCPs** on the controller UI (or POST to the
  inspector's `/mcp/rescan-local`) and the connector re-scans without a
  process restart.

New drop-ins land in "awaiting approval" state until the controller operator
approves them via the UI. The **two-key model** — filesystem write proposes,
operator click accepts — is a load-bearing property of the design.

## Delivery paths (production)

Two ways to get folders here in a deployed connector:

- **Derived image** — `FROM ghcr.io/twilio-demos/tool-proxy` + `COPY ./my-mcps/
  /var/lib/tool-proxy/customer-mcps/`; build and deploy your own image.
- **Volume mount** — mount an OCI volume / K8s ConfigMap or PVC / Fly volume /
  bind mount at `/var/lib/tool-proxy/customer-mcps/`. Enables hot-reload via
  the controller UI's rescan button.

See [deploy/DERIVED-IMAGE.md](../deploy/DERIVED-IMAGE.md) and
[deploy/VOLUME-MOUNT.md](../deploy/VOLUME-MOUNT.md) for walkthroughs.

## More docs

- [docs/AUTHOR-LOCAL-MCP.md](../docs/AUTHOR-LOCAL-MCP.md) — deep dive on
  authoring tools, prompts, resources.
- [examples/demos/sample/](../examples/demos/sample/) — full worked example
  with all three sibling categories.
