import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { sendSms } from "./tools/send-sms.js";
import { lookupPhoneNumber } from "./tools/lookup-phone-number.js";
import { listRecent } from "./tools/list-recent.js";
import type { Tool } from "./tools/types.js";

// Demo MCP server that wraps Twilio's APIs as MCP tools. Standalone — not a
// workspace of the connector repo, so its `twilio` SDK doesn't pollute the
// connector image. Add it to the connector's mcp_servers[] block to expose
// these tools through the tunnel.
const TOOLS: Tool[] = [sendSms, lookupPhoneNumber, listRecent];

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "twilio-mcp-server", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  for (const t of TOOLS) t.register(server);
  return server;
}

async function main() {
  const port = Number(process.env.PORT ?? 7200);
  // Touch the client up front so we crash on missing creds at boot, not on
  // first tool call.
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set");
  }

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
    console.log(`[twilio-mcp] listening on http://localhost:${port}/mcp (tools: ${TOOLS.map(t => t.name).join(", ")})`);
  });
}

main().catch((e) => {
  console.error("twilio-mcp-server failed:", e);
  process.exit(1);
});
