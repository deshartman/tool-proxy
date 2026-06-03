import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getRecent } from "./tools/get-recent.js";
import { issueRefund } from "./tools/issue-refund.js";
import type { Tool } from "./tools/types.js";

// Demo MCP server for the Refund Eligibility procedure. Exposes a hydration
// tool (get_recent) and a side-effect tool (issue_refund). All data is
// fixtured — this is a connector-side stand-in for a real orders system.
//
// In the connector.yaml, mcp_servers[].name MUST be "orders" so the
// controller stamps these tools as customer.orders.get_recent /
// customer.orders.issue_refund — that's the qualified name the procedure's
// EXPECTED_CUSTOMER_TOOLS binds against.
const TOOLS: Tool[] = [getRecent, issueRefund];

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "orders-mcp-server", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  for (const t of TOOLS) t.register(server);
  return server;
}

async function main() {
  const port = Number(process.env.PORT ?? 7300);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  const server = buildServer();
  await server.connect(transport);

  const http = createServer((req, res) => {
    if (req.url !== "/mcp") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: unknown;
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.statusCode = 400;
          res.end("malformed body");
          return;
        }
      }
      void transport.handleRequest(req, res, body);
    });
  });

  http.listen(port, () => {
    console.log(`[orders-mcp] listening on http://localhost:${port}/mcp (tools: ${TOOLS.map(t => t.name).join(", ")})`);
  });
}

main().catch((e) => {
  console.error("orders-mcp-server failed:", e);
  process.exit(1);
});
