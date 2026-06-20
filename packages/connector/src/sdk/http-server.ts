import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Tool } from "./tool.js";
import { createLogger } from "../logger.js";
import { envNumber } from "../env.js";

export interface CreateMcpHttpServerOptions {
  name: string;
  tools: Tool[];
  version?: string;
  // If omitted, falls back to PORT env var, then to 0 (kernel-assigned).
  // The connector's spawner sets PORT explicitly when auto-allocating.
  port?: number;
  // Server-level envKeys hint. When set, it replaces the per-tool
  // aggregation as the authoritative list surfaced on /envkeys. Use this
  // when tools register conditionally on creds presence — the server still
  // needs to advertise *which* keys the controller should populate, even
  // before any tool has registered to declare them itself. The connector
  // hands this list to the controller via creds-request so the operator
  // never wonders "what envKeys does this MCP need."
  envKeys?: string[];
}

export interface McpHttpServerHandle {
  port: number;
  close(): Promise<void>;
}

// Customer-authored Type 1 MCP servers call this from their `server.ts`.
// Stateful StreamableHTTPServerTransport with randomUUID session IDs is the
// only mode the SDK's HTTP transport supports for our use.
export async function createMcpHttpServer(opts: CreateMcpHttpServerOptions): Promise<McpHttpServerHandle> {
  const requestedPort = opts.port ?? envNumber("PORT", 0);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  const server = new McpServer(
    { name: opts.name, version: opts.version ?? "0.1.0" },
    { capabilities: { tools: {} } }
  );
  for (const tool of opts.tools) tool.register(server);

  await server.connect(transport);

  // Resolve the envKeys list surfaced on /envkeys. Server-level opts.envKeys
  // wins when provided (use when tools register conditionally and the
  // per-tool aggregate would be empty until creds arrive). Otherwise fall
  // back to aggregating envKeys across the registered tools (de-duped,
  // stable order). Out-of-band of the MCP protocol itself — keeps the wire
  // format unchanged; consumed by the connector's creds-request frame.
  const envKeys = opts.envKeys ? dedupe(opts.envKeys) : aggregateEnvKeys(opts.tools);

  return new Promise<McpHttpServerHandle>((resolveListen, rejectListen) => {
    const http = createServer((req, res) => {
      if (req.url === "/envkeys") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ envKeys }));
        return;
      }
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

    http.once("error", rejectListen);
    http.listen(requestedPort, () => {
      const addr = http.address();
      const port = typeof addr === "object" && addr ? addr.port : requestedPort;
      const log = createLogger(opts.name);
      log.info({ port, url: `http://localhost:${port}/mcp`, tools: opts.tools.map((tool) => tool.name) }, `listening`);
      resolveListen({
        port,
        close: () => new Promise<void>((res) => http.close(() => res())),
      });
    });
  });
}

function aggregateEnvKeys(tools: Tool[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tool of tools) {
    if (!tool.envKeys) continue;
    for (const key of tool.envKeys) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function dedupe(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
