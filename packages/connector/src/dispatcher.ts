import type { ConnectorConfig } from "./config.js";
import type { McpServerConnection } from "./servers/index.js";
import type { ToolManifest } from "./tunnel/frames.js";
import type { TunnelClient } from "./tunnel/client.js";
import { renderArgsForLog } from "./policy/redact.js";

// JSON-RPC 2.0 standard error codes (we only emit the two we actually use).
const E_METHOD_NOT_FOUND = -32601;
const E_INVALID_PARAMS = -32602;
// Server-defined error space (-32000 to -32099); we use -32010 for everything
// the customer-side code rejects, with the `kind` field discriminating cause.
const E_TOOL_REJECTED = -32010;

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: unknown };
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

export interface DispatcherDeps {
  config: ConnectorConfig;
  servers: Map<string, McpServerConnection>;
  getManifest: () => ToolManifest;
  tunnel: TunnelClient;
  log?: (line: string) => void;
}

export class Dispatcher {
  private inFlight = 0;

  constructor(private readonly deps: DispatcherDeps) {}

  attach(): void {
    // Compose with any pre-existing onframe (e.g. the boot-installed
    // frame router that handles register-ack and webhook frames). The
    // dispatcher only cares about `rpc` frames; everything else falls
    // through to the previously-installed handler.
    const previous = this.deps.tunnel.onframe;
    this.deps.tunnel.onframe = (frame) => {
      if (frame.type === "rpc") {
        void this.handleRpcFrame(frame.payload);
        return;
      }
      previous?.(frame);
    };
  }

  private async handleRpcFrame(payload: unknown): Promise<void> {
    const req = parseRequest(payload);
    if (!req) return; // malformed; nothing to reply to without an id

    if (req.method === "tools/list") {
      this.reply({ id: req.id ?? null, result: this.listAllowedTools() });
      return;
    }

    if (req.method === "tools/call") {
      await this.handleToolCall(req);
      return;
    }

    this.reply({
      id: req.id ?? null,
      error: { code: E_METHOD_NOT_FOUND, message: `method not found: ${req.method}` },
    });
  }

  private listAllowedTools(): { tools: Array<{ name: string; description: string; inputSchema: unknown; outputSchema?: unknown }> } {
    const manifest = this.deps.getManifest();
    const tools: Array<{ name: string; description: string; inputSchema: unknown; outputSchema?: unknown }> = [];
    for (const server of manifest.servers) {
      for (const tool of server.tools) {
        tools.push({
          name: `${server.name}.${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
        });
      }
    }
    return { tools };
  }

  private async handleToolCall(req: JsonRpcRequest): Promise<void> {
    const params = req.params as { name?: unknown; arguments?: unknown } | undefined;
    const qualifiedName = typeof params?.name === "string" ? params.name : "";
    const args = params?.arguments;
    const id = req.id ?? null;

    if (!qualifiedName.includes(".")) {
      this.reply({
        id,
        error: { code: E_INVALID_PARAMS, message: "tool name must be `${server}.${tool}`" },
      });
      return;
    }
    const dot = qualifiedName.indexOf(".");
    const serverName = qualifiedName.slice(0, dot);
    const toolName = qualifiedName.slice(dot + 1);

    const server = this.deps.servers.get(serverName);
    if (!server) {
      this.replyKind(id, "tool_not_found", `no local MCP server '${serverName}'`);
      return;
    }

    if (this.inFlight >= this.deps.config.policy.max_concurrent_calls) {
      this.replyKind(id, "concurrency_limit", `max_concurrent_calls reached`);
      return;
    }

    this.inFlight++;
    const argsLog = renderArgsForLog(args, this.deps.config.policy.log_tool_args);
    this.log(`tools/call ${qualifiedName} args=${argsLog}`);

    try {
      const result = await server.callTool(toolName, args, {
        timeoutMs: this.deps.config.policy.tool_timeout_ms,
      });
      this.reply({ id, result });
      this.log(`tools/call ${qualifiedName} ok`);
    } catch (err) {
      const detail = (err as Error)?.message ?? String(err);
      this.replyKind(id, "tool_failed", detail);
      this.log(`tools/call ${qualifiedName} failed: ${detail}`);
    } finally {
      this.inFlight--;
    }
  }

  private reply(resp: { id: JsonRpcId; result: unknown } | { id: JsonRpcId; error: { code: number; message: string; data?: unknown } }): void {
    const full: JsonRpcResponse = "result" in resp
      ? { jsonrpc: "2.0", id: resp.id, result: resp.result }
      : { jsonrpc: "2.0", id: resp.id, error: resp.error };
    this.deps.tunnel.send({ type: "rpc", payload: full });
  }

  private replyKind(id: JsonRpcId, kind: string, message: string): void {
    this.reply({
      id,
      error: { code: E_TOOL_REJECTED, message, data: { kind } },
    });
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }
}

function parseRequest(payload: unknown): JsonRpcRequest | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<JsonRpcRequest>;
  if (p.jsonrpc !== "2.0" || typeof p.method !== "string") return null;
  return p as JsonRpcRequest;
}

