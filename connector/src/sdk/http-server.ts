import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "./tool.js";
import type { Prompt } from "./prompt.js";
import type { Resource } from "./resource.js";
import { createLogger } from "../logger.js";
import { envNumber } from "../env.js";

export interface CreateMcpHttpServerOptions {
  name: string;
  tools: Tool[];
  // v1.2 — MCP-CLIENT-USE. Authors register prompts and resources alongside
  // tools through the same factory. All three are optional; an MCP that ships
  // tools-only is unchanged.
  prompts?: Prompt[];
  resources?: Resource[];
  version?: string;
  // If omitted, falls back to PORT env var, then to 0 (kernel-assigned).
  // The connector's spawner sets PORT explicitly when auto-allocating.
  port?: number;
  // Server-level envKeys hint. When set, it replaces the per-tool / -prompt
  // / -resource aggregation as the authoritative list surfaced on /envkeys.
  // Use this when authoring conditionally registers items based on creds
  // presence — the server still needs to advertise *which* keys the
  // controller should populate, even before any item has registered to
  // declare them itself. The connector hands this list to the controller
  // via creds-request so the operator never wonders "what envKeys does
  // this MCP need."
  envKeys?: string[];
  // Extra capability keys to advertise on the MCP initialize response,
  // merged alongside the standard tools/prompts/resources presence keys.
  // Used by protocol extensions (e.g. the memory + identity provider shape
  // in MEMORY-MCP-INTERFACE.md §7) that need to declare custom capability
  // groups. Standard keys stay auto-managed — do NOT set `tools`,
  // `prompts`, or `resources` here.
  //
  // IMPORTANT: MCP's ServerCapabilitiesSchema is `.strip()` — unknown
  // top-level keys are removed by the SDK on both send and receive. Custom
  // shapes MUST be nested under `experimental` (Record<string, object>) or
  // `extensions` (same shape), which the schema preserves. Vendor
  // convention is a single-key namespace so the receiver can find the
  // group without collision:
  //   capabilities: { experimental: { "your-mcp-name": { ...your fields } } }
  capabilities?: Record<string, unknown>;
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
  const prompts = opts.prompts ?? [];
  const resources = opts.resources ?? [];

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  // Capabilities follow the registered surface. McpServer's runtime tracks
  // which categories have handlers; we still need to advertise on the wire
  // what the connector / controller can call. The per-category capability
  // is empty — its presence is the signal. Custom keys from opts.capabilities
  // are merged in first so the standard tools/prompts/resources presence
  // keys always win — a caller can't accidentally overwrite them.
  const capabilities: Record<string, unknown> = { ...(opts.capabilities ?? {}), tools: {} };
  if (prompts.length > 0) capabilities.prompts = {};
  else delete capabilities.prompts;
  if (resources.length > 0) capabilities.resources = {};
  else delete capabilities.resources;

  const server = new McpServer(
    { name: opts.name, version: opts.version ?? "0.1.0" },
    { capabilities }
  );
  for (const tool of opts.tools) tool.register(server);
  for (const prompt of prompts) prompt.register(server);
  for (const resource of resources) resource.register(server);

  // McpServer wires its tools/list handler lazily — only on the first
  // registerTool() call. A creds-gated MCP that registers zero tools (e.g.
  // a Type 1 MCP awaiting its API token over the wire) would otherwise
  // return -32601 "Method not found" to tools/list, killing the
  // connector's buildManifest at boot. Install an empty-list handler
  // ourselves so the wire response is the normal MCP semantics: "server up,
  // 0 tools right now." The supervisor's creds-update restart re-spawns
  // with non-empty tools, and the SDK's own lazy-init takes over.
  //
  // We do NOT install equivalent empty handlers for prompts/list and
  // resources/list — the connector only calls those when the upstream
  // server has DECLARED the matching capability. With zero registered
  // prompts we don't declare capabilities.prompts above, the connector's
  // manifest builder skips listPrompts(), and we never see -32601. Same
  // for resources. Tools is special: capabilities.tools is always set
  // (every MCP we ship advertises tools).
  if (opts.tools.length === 0) {
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  }

  await server.connect(transport);

  // Resolve the envKeys list surfaced on /envkeys. Server-level opts.envKeys
  // wins when provided (use when items register conditionally and the
  // per-item aggregate would be empty until creds arrive). Otherwise
  // aggregate envKeys across registered tools, prompts, and resources
  // (de-duped, stable order). Out-of-band of the MCP protocol itself —
  // keeps the wire format unchanged; consumed by the connector's
  // creds-request frame.
  const envKeys = opts.envKeys
    ? dedupe(opts.envKeys)
    : aggregateEnvKeys([...opts.tools, ...prompts, ...resources]);

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
      log.info({
        port,
        url: `http://localhost:${port}/mcp`,
        tools: opts.tools.map((tool) => tool.name),
        prompts: prompts.map((p) => p.name),
        resources: resources.map((r) => r.name),
      }, `listening`);
      resolveListen({
        port,
        close: () => new Promise<void>((res) => http.close(() => res())),
      });
    });
  });
}

function aggregateEnvKeys(items: Array<{ envKeys?: string[] }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!item.envKeys) continue;
    for (const key of item.envKeys) {
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
