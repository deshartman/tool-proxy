import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { now } from "./tools/now.js";
import { slowEcho } from "./tools/slow-echo.js";
import { uuid } from "./tools/uuid.js";
import { weather } from "./tools/weather.js";
import type { Tool } from "./tools/types.js";

// Tiny stub MCP server for verifying the connector end to end.
// Tools live one-per-file under tools/; each module owns its zod schema and
// handler. New demo tool? Add a file and append to TOOLS.
const TOOLS: Tool[] = [now, slowEcho, uuid, weather];

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "sample-mcp-server", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  for (const t of TOOLS) t.register(server);
  return server;
}

async function main() {
  const port = Number(process.env.PORT ?? 7100);

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
    console.log(`[sample-mcp] listening on http://localhost:${port}/mcp (tools: ${TOOLS.map(t => t.name).join(", ")})`);
  });
}

main().catch((e) => {
  console.error("sample-mcp-server failed:", e);
  process.exit(1);
});
