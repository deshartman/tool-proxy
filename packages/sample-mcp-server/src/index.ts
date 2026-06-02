import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// Tiny stub MCP server for verifying the connector end to end.
// Exposes three tools:
//   echo(text)                  — returns the same text back
//   now()                       — returns the server's current ISO timestamp
//   slow_echo(text, sleep_ms?)  — sleeps then echoes; used to test tool_timeout_ms

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "sample-mcp-server", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "echo",
    {
      description: "Echo the provided text back unchanged.",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({ content: [{ type: "text", text }] })
  );

  server.registerTool(
    "now",
    { description: "Return the server's current time as an ISO 8601 timestamp." },
    async () => ({ content: [{ type: "text", text: new Date().toISOString() }] })
  );

  server.registerTool(
    "slow_echo",
    {
      description: "Sleep for sleep_ms (default 6000), then echo text. Use to test tool_timeout_ms.",
      inputSchema: {
        text: z.string(),
        sleep_ms: z.number().optional(),
      },
    },
    async ({ text, sleep_ms }) => {
      await new Promise((r) => setTimeout(r, sleep_ms ?? 6000));
      return { content: [{ type: "text", text }] };
    }
  );

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
    console.log(`[sample-mcp] listening on http://localhost:${port}/mcp`);
  });
}

main().catch((e) => {
  console.error("sample-mcp-server failed:", e);
  process.exit(1);
});
