import { createServer } from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
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
  // Under MCP `2026-07-28`, `extensions` is a first-class field on
  // ServerCapabilities and is the sanctioned home for custom capability
  // groups. Vendor convention is a single-key namespace so the receiver
  // can find the group without collision:
  //   capabilities: { extensions: { "your-mcp-name": { ...your fields } } }
  capabilities?: Record<string, unknown>;
}

export interface McpHttpServerHandle {
  port: number;
  // Bound address, as reported by the listening socket. Always LOOPBACK_BIND in
  // practice; surfaced so the MCP-AUDIT #1 test can assert the real bind rather
  // than infer it from OS bind semantics (which differ between Linux and BSD
  // once SO_REUSEADDR is in play, and so cannot discriminate portably).
  address: string;
  close(): Promise<void>;
}

// See the bind-address note on createMcpHttpServer below. Named rather than
// inlined so the hardening test can assert against the same constant.
export const LOOPBACK_BIND = "127.0.0.1";

// Customer-authored Type 1 MCP servers call this from their `server.ts`, and
// every drop-in / bundled MCP reaches it through the drop-in runner.
//
// BIND ADDRESS IS LOOPBACK-ONLY, DELIBERATELY (MCP-AUDIT #1). `/mcp` carries the
// MCP's entire tool surface with no authentication of any kind — including write
// tools running under real customer credentials — and `/envkeys` names the creds
// it wants. Omitting the host argument makes Node bind `::`/`0.0.0.0`, which put
// that surface on every interface: the LAN in dev, and every sibling in the
// container's network namespace in production. Nothing needs the wider bind —
// the connector always dials `http://127.0.0.1:<port>/mcp` (the endpoint
// mcp-supervisor's spawnChild stamps onto the spec) and reaches /envkeys through
// that same URL. Don't drop the host argument, and don't make it configurable.
//
// Serves MCP `2026-07-28` and — via createMcpHandler's default
// `legacy: 'stateless'` — the 2025-era protocol too: one endpoint, both eras,
// a fresh McpServer built per request (the 2026-07-28 model is stateless —
// no `Mcp-Session-Id`). The connector's own outbound client negotiates the
// era per connection (see servers/*.ts `versionNegotiation`).
export async function createMcpHttpServer(opts: CreateMcpHttpServerOptions): Promise<McpHttpServerHandle> {
  const requestedPort = opts.port ?? envNumber("PORT", 0);
  const prompts = opts.prompts ?? [];
  const resources = opts.resources ?? [];

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

  // createMcpHandler drives a FRESH McpServer per request (the 2026-07-28
  // protocol is per-request / stateless). Registration is cheap; each request
  // gets its own server instance carrying the same tool/prompt/resource set.
  const buildServer = (): McpServer => {
    const server = new McpServer(
      { name: opts.name, version: opts.version ?? "0.1.0" },
      { capabilities },
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
      server.server.setRequestHandler("tools/list", () => ({ tools: [] }));
    }
    return server;
  };

  // Default legacy: 'stateless' → the same handler also serves 2025-era
  // clients through the established stateless idiom. toNodeHandler adapts the
  // web-standard handler to Node (req, res) and reads/parses the body itself.
  const handler = createMcpHandler(buildServer);
  const nodeMcp = toNodeHandler(handler);

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
      // toNodeHandler owns body reading + era routing (2025 / 2026-07-28).
      void nodeMcp(req, res);
    });

    http.once("error", rejectListen);
    http.listen(requestedPort, LOOPBACK_BIND, () => {
      const addr = http.address();
      const port = typeof addr === "object" && addr ? addr.port : requestedPort;
      const address = typeof addr === "object" && addr ? addr.address : LOOPBACK_BIND;
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
        address,
        close: () =>
          new Promise<void>((res) => {
            http.close(() => {
              // Release the handler's per-request event bus / subscriptions
              // alongside the socket. Swallow any close error — we're tearing
              // down regardless.
              Promise.resolve(handler.close()).then(() => res(), () => res());
            });
          }),
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
