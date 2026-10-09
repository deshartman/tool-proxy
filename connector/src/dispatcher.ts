import type { ConnectorConfig } from "./config.js";
import { bareNaming, type WireNaming } from "./tunnel/naming.js";
import type { McpServerConnection } from "./servers/index.js";
import type { ToolManifest } from "./tunnel/frames.js";
import type { TunnelClient } from "./tunnel/client.js";
import { renderArgsForLog } from "./policy/redact.js";

// JSON-RPC 2.0 standard error codes (we only emit the ones we actually use).
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
  // Optional supervisor hook. Lets the dispatcher distinguish "MCP is
  // being restarted" from "MCP is gone" when a mid-flight tool call sees
  // its target removed from the servers map. Used only to enrich the
  // mcp_disconnected log line — the reply kind stays the same. Absent →
  // dispatcher falls back to the bare "mcp_disconnected" label (pre-2026-07-28
  // behavior).
  isRestarting?: (name: string) => boolean;
  // Approval gate. Absent → every server is reachable (tests, and callers
  // with no gate). When present, a server for which this returns false is
  // treated as ABSENT on every route — same reply a non-existent server
  // gets, and the aggregate list methods skip it. The manifest already
  // withholds unapproved servers; without this, a controller naming one
  // directly would still reach it.
  isServerEnabled?: (name: string) => boolean;
  // How tool/prompt names look on the wire for THIS session — bare
  // `<server>.<name>` under 1.x, `<shimId>.<server>.<name>` under 2.x. Chosen
  // once per tunnel from the negotiated major (tunnel/naming.ts). Absent →
  // bare, i.e. today's behaviour.
  naming?: WireNaming;
}

const BARE = bareNaming();

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
        // Top-level catch — handleRpcFrame is already exhaustive about
        // replying with tool_failed / replyKind per-branch, so this fires
        // only for programmer-error throws that escape the method itself
        // (e.g. a future refactor throwing before the try). Log through
        // pino instead of leaking into unhandledRejection; we can't reply
        // with an error frame because the request id lives inside
        // handleRpcFrame's scope.
        this.handleRpcFrame(frame.payload).catch((error) => {
          this.log(`unhandled rpc error: ${(error as Error)?.message ?? String(error)}`);
        });
        return;
      }
      previous?.(frame);
    };
  }

  private async handleRpcFrame(payload: unknown): Promise<void> {
    const req = parseRequest(payload);
    if (!req) return; // malformed; nothing to reply to without an id
    const id = req.id ?? null;

    if (req.method === "tools/list") {
      this.reply({ id, result: this.listAllowedTools() });
      return;
    }
    if (req.method === "tools/call") {
      await this.handleToolCall(req);
      return;
    }

    // v1.2 — MCP-CLIENT-USE. Server-method passthrough. The dispatcher
    // routes by method to the matching McpServerConnection method. The
    // server-discriminator follows two patterns:
    //
    //   * `${server}.${name}` for prompts/get and tools/call (the same
    //     namespacing existing tools/call uses).
    //   * URI scheme/host for resources/{read,subscribe,unsubscribe} —
    //     the URI itself carries the namespace via the scheme component
    //     (e.g. `kb://sources/abc` → server "kb"). We use the URI's host
    //     position as the server name — see splitResourceServer().
    //   * `params.serverName` opt-in for {prompts,resources}/list,
    //     resources/templates/list, completion/complete, logging/setLevel
    //     so the controller can target a specific MCP. Omitted = aggregate
    //     across every connected MCP for the list methods; required for
    //     the per-server methods (complete, setLevel).
    if (req.method === "prompts/list") {
      await this.handleListPrompts(req);
      return;
    }
    if (req.method === "prompts/get") {
      await this.handleGetPrompt(req);
      return;
    }
    if (req.method === "resources/list") {
      await this.handleListResources(req);
      return;
    }
    if (req.method === "resources/templates/list") {
      await this.handleListResourceTemplates(req);
      return;
    }
    if (req.method === "resources/read") {
      await this.handleReadResource(req);
      return;
    }
    if (req.method === "resources/subscribe") {
      await this.handleResourceSubscribe(req, "subscribe");
      return;
    }
    if (req.method === "resources/unsubscribe") {
      await this.handleResourceSubscribe(req, "unsubscribe");
      return;
    }
    if (req.method === "completion/complete") {
      await this.handleComplete(req);
      return;
    }
    if (req.method === "logging/setLevel") {
      await this.handleSetLevel(req);
      return;
    }

    this.reply({
      id,
      error: { code: E_METHOD_NOT_FOUND, message: `method not found: ${req.method}` },
    });
  }

  private get naming(): WireNaming {
    return this.deps.naming ?? BARE;
  }

  // Resolve a wire name to (server, name), or reply with the error and return
  // undefined. A FOREIGN shimId — a well-formed 2.x name addressed to another
  // shim — gets the same reply an unknown server gets, so a controller learns
  // nothing about which shims exist; it is logged so a misroute is visible.
  private resolveName(
    id: JsonRpcId,
    wireName: string,
    what: "tool" | "prompt",
    notFoundKind: "tool_not_found" | "server_not_found",
  ): { server: string; name: string } | undefined {
    const parsed = this.naming.parse(wireName);
    if (parsed.ok) return { server: parsed.server, name: parsed.name };
    if (parsed.reason === "foreign-shim") {
      this.log(`${what} ${wireName} is addressed to shim ${parsed.shimId}, not this shim — refused`);
      this.replyKind(id, notFoundKind, `no local MCP server for '${wireName}'`);
      return undefined;
    }
    const shape = this.naming.shape.replace("${name}", `\${${what}}`);
    this.reply({ id, error: { code: E_INVALID_PARAMS, message: `${what} name must be \`${shape}\` with non-empty parts` } });
    return undefined;
  }

  private listAllowedTools(): { tools: Array<{ name: string; description: string; inputSchema: unknown; outputSchema?: unknown }> } {
    const manifest = this.deps.getManifest();
    const tools: Array<{ name: string; description: string; inputSchema: unknown; outputSchema?: unknown }> = [];
    for (const server of manifest.servers) {
      for (const tool of server.tools) {
        tools.push({
          name: this.naming.compose(server.name, tool.name),
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

    const resolved = this.resolveName(id, qualifiedName, "tool", "tool_not_found");
    if (!resolved) return;
    const serverName = resolved.server;
    const toolName = resolved.name;

    const server = this.server(serverName);
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
      // Wire semantics are deliberately unchanged: an `isError: true` result is
      // the spec-correct shape for a tool-level rejection (bad args, app-level
      // refusal) and is relayed verbatim so the controller's model can read the
      // message and adapt. Converting it to a JSON-RPC error would collapse the
      // distinction between "the tool ran and rejected" and "the transport
      // died". This is observability only — logging every such call as "ok" made
      // a rejected call indistinguishable from a successful one after the fact,
      // since the result payload lives only in the in-memory message tap.
      // Detail is intentionally omitted: isError text often echoes the
      // arguments, which policy.log_tool_args may have redacted above.
      const toolError =
        typeof result === "object" &&
        result !== null &&
        (result as { isError?: unknown }).isError === true;
      this.log(`tools/call ${qualifiedName} ${toolError ? "tool-error" : "ok"}`);
    } catch (err) {
      const detail = (err as Error)?.message ?? String(err);
      // If the server disappeared from the map while we were awaiting a
      // reply, the supervisor closed the connection under us (typical
      // cause: creds-update / rapid restart / Type 2 config-delta). Reply
      // with a specific error kind so the controller can distinguish this
      // from a genuine tool crash, and log it plainly.
      const disconnected = !this.deps.servers.has(serverName);
      const kind = disconnected ? "mcp_disconnected" : "tool_failed";
      this.replyKind(id, kind, detail);
      // Log-level hint: distinguish a mid-restart disconnect from a truly-
      // gone MCP. Supervisor state is the source of truth; the servers
      // map races the restart window. Reply kind stays "mcp_disconnected"
      // either way — this is observability, not wire semantics.
      const restartHint = disconnected && this.deps.isRestarting?.(serverName)
        ? " — restart in progress"
        : "";
      this.log(`tools/call ${qualifiedName} failed (${kind}): ${detail}${restartHint}`);
    } finally {
      this.inFlight--;
    }
  }

  // ── prompts ────────────────────────────────────────────────────────────

  private async handleListPrompts(req: JsonRpcRequest): Promise<void> {
    const id = req.id ?? null;
    const params = (req.params ?? {}) as { serverName?: unknown };
    const serverName = typeof params.serverName === "string" ? params.serverName : undefined;

    const targets = this.targetsForList(serverName);
    if (serverName && targets.length === 0) {
      this.replyKind(id, "server_not_found", `no local MCP server '${serverName}'`);
      return;
    }
    const prompts: Array<{ name: string; description?: string; arguments?: unknown }> = [];
    for (const server of targets) {
      const caps = server.capabilities;
      // Skip servers that didn't advertise prompts — protects against
      // upstream returning -32601 and one server's miss failing the union.
      if (!caps?.prompts) continue;
      try {
        const list = await server.listPrompts();
        for (const prompt of list) {
          prompts.push({
            name: this.naming.compose(server.name, prompt.name),
            ...(prompt.description !== undefined ? { description: prompt.description } : {}),
            ...(prompt.arguments !== undefined ? { arguments: prompt.arguments } : {}),
          });
        }
      } catch (err) {
        this.log(`prompts/list ${server.name} failed: ${(err as Error)?.message ?? String(err)}`);
      }
    }
    this.reply({ id, result: { prompts } });
  }

  private async handleGetPrompt(req: JsonRpcRequest): Promise<void> {
    const id = req.id ?? null;
    const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
    const qualifiedName = typeof params.name === "string" ? params.name : "";
    const resolved = this.resolveName(id, qualifiedName, "prompt", "server_not_found");
    if (!resolved) return;
    const serverName = resolved.server;
    const promptName = resolved.name;

    const server = this.server(serverName);
    if (!server) {
      this.replyKind(id, "server_not_found", `no local MCP server '${serverName}'`);
      return;
    }
    const args = params.arguments && typeof params.arguments === "object"
      ? params.arguments as Record<string, unknown>
      : undefined;
    try {
      const result = await server.getPrompt(promptName, args, {
        timeoutMs: this.deps.config.policy.tool_timeout_ms,
      });
      this.reply({ id, result });
    } catch (err) {
      this.replyKind(id, "prompt_failed", (err as Error)?.message ?? String(err));
    }
  }

  // ── resources ──────────────────────────────────────────────────────────

  private async handleListResources(req: JsonRpcRequest): Promise<void> {
    const id = req.id ?? null;
    const params = (req.params ?? {}) as { serverName?: unknown };
    const serverName = typeof params.serverName === "string" ? params.serverName : undefined;

    const targets = this.targetsForList(serverName);
    if (serverName && targets.length === 0) {
      this.replyKind(id, "server_not_found", `no local MCP server '${serverName}'`);
      return;
    }
    const resources: Array<Record<string, unknown>> = [];
    for (const server of targets) {
      if (!server.capabilities?.resources) continue;
      try {
        const list = await server.listResources();
        for (const resource of list) resources.push({ ...resource });
      } catch (err) {
        this.log(`resources/list ${server.name} failed: ${(err as Error)?.message ?? String(err)}`);
      }
    }
    this.reply({ id, result: { resources } });
  }

  private async handleListResourceTemplates(req: JsonRpcRequest): Promise<void> {
    const id = req.id ?? null;
    const params = (req.params ?? {}) as { serverName?: unknown };
    const serverName = typeof params.serverName === "string" ? params.serverName : undefined;

    const targets = this.targetsForList(serverName);
    if (serverName && targets.length === 0) {
      this.replyKind(id, "server_not_found", `no local MCP server '${serverName}'`);
      return;
    }
    const resourceTemplates: Array<Record<string, unknown>> = [];
    for (const server of targets) {
      if (!server.capabilities?.resources) continue;
      try {
        const list = await server.listResourceTemplates();
        for (const tmpl of list) resourceTemplates.push({ ...tmpl });
      } catch (err) {
        this.log(`resources/templates/list ${server.name} failed: ${(err as Error)?.message ?? String(err)}`);
      }
    }
    this.reply({ id, result: { resourceTemplates } });
  }

  private async handleReadResource(req: JsonRpcRequest): Promise<void> {
    const id = req.id ?? null;
    const params = (req.params ?? {}) as { uri?: unknown };
    const uri = typeof params.uri === "string" ? params.uri : "";
    if (!uri) {
      this.reply({ id, error: { code: E_INVALID_PARAMS, message: "resources/read requires `uri`" } });
      return;
    }
    const target = this.serverForResource(uri, req.params);
    if (!target.server) {
      this.replyKind(id, "server_not_found", target.error);
      return;
    }
    try {
      const result = await target.server.readResource(uri, {
        timeoutMs: this.deps.config.policy.tool_timeout_ms,
      });
      this.reply({ id, result });
    } catch (err) {
      this.replyKind(id, "resource_failed", (err as Error)?.message ?? String(err));
    }
  }

  private async handleResourceSubscribe(req: JsonRpcRequest, kind: "subscribe" | "unsubscribe"): Promise<void> {
    const id = req.id ?? null;
    const params = (req.params ?? {}) as { uri?: unknown };
    const uri = typeof params.uri === "string" ? params.uri : "";
    if (!uri) {
      this.reply({ id, error: { code: E_INVALID_PARAMS, message: `resources/${kind} requires \`uri\`` } });
      return;
    }
    const target = this.serverForResource(uri, req.params);
    if (!target.server) {
      this.replyKind(id, "server_not_found", target.error);
      return;
    }
    try {
      const result = kind === "subscribe"
        ? await target.server.subscribeResource(uri, { timeoutMs: this.deps.config.policy.tool_timeout_ms })
        : await target.server.unsubscribeResource(uri, { timeoutMs: this.deps.config.policy.tool_timeout_ms });
      this.reply({ id, result });
    } catch (err) {
      this.replyKind(id, `${kind}_failed`, (err as Error)?.message ?? String(err));
    }
  }

  // ── completion / logging ───────────────────────────────────────────────

  private async handleComplete(req: JsonRpcRequest): Promise<void> {
    const id = req.id ?? null;
    const params = (req.params ?? {}) as { serverName?: unknown };
    const serverName = typeof params.serverName === "string" ? params.serverName : undefined;
    if (!serverName) {
      this.reply({
        id,
        error: { code: E_INVALID_PARAMS, message: "completion/complete requires `params.serverName`" },
      });
      return;
    }
    const server = this.server(serverName);
    if (!server) {
      this.replyKind(id, "server_not_found", `no local MCP server '${serverName}'`);
      return;
    }
    // Strip the connector-only `serverName` discriminator before forwarding
    // to the upstream MCP — its complete handler doesn't expect it.
    const upstreamParams: Record<string, unknown> = { ...(params as Record<string, unknown>) };
    delete upstreamParams.serverName;
    try {
      const result = await server.complete(upstreamParams, {
        timeoutMs: this.deps.config.policy.tool_timeout_ms,
      });
      this.reply({ id, result });
    } catch (err) {
      this.replyKind(id, "complete_failed", (err as Error)?.message ?? String(err));
    }
  }

  private async handleSetLevel(req: JsonRpcRequest): Promise<void> {
    const id = req.id ?? null;
    const params = (req.params ?? {}) as { serverName?: unknown; level?: unknown };
    const serverName = typeof params.serverName === "string" ? params.serverName : undefined;
    const level = typeof params.level === "string" ? params.level : undefined;
    if (!serverName || !level) {
      this.reply({
        id,
        error: { code: E_INVALID_PARAMS, message: "logging/setLevel requires `params.serverName` and `params.level`" },
      });
      return;
    }
    const server = this.server(serverName);
    if (!server) {
      this.replyKind(id, "server_not_found", `no local MCP server '${serverName}'`);
      return;
    }
    try {
      const result = await server.setLoggingLevel(level, {
        timeoutMs: this.deps.config.policy.tool_timeout_ms,
      });
      this.reply({ id, result });
    } catch (err) {
      this.replyKind(id, "set_level_failed", (err as Error)?.message ?? String(err));
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────

  // For *list* methods (prompts/list, resources/list, resources/templates/list),
  // the controller can opt into a single-server query via params.serverName,
  // or aggregate across every connected MCP by omitting it. Aggregation is
  // the natural default — a controller-side procedure UI builds one prompt
  // picker across every MCP.
  private targetsForList(serverName: string | undefined): McpServerConnection[] {
    if (serverName) {
      const server = this.server(serverName);
      return server ? [server] : [];
    }
    return [...this.deps.servers.values()].filter((server) => this.enabled(server.name));
  }

  // Resource methods (read / subscribe / unsubscribe) need to pick a single
  // upstream MCP. The controller passes `params.serverName` explicitly when
  // it knows the routing (most common case — the controller already grouped
  // resources by server). As a fallback we try the URI scheme: `kb://...`
  // → server "kb". Either path must succeed unambiguously; otherwise we
  // return an error string for the caller to relay.
  private serverForResource(uri: string, rawParams: unknown): { server?: McpServerConnection; error: string } {
    const params = (rawParams ?? {}) as { serverName?: unknown };
    const explicit = typeof params.serverName === "string" ? params.serverName : undefined;
    if (explicit) {
      const server = this.server(explicit);
      return server ? { server, error: "" } : { error: `no local MCP server '${explicit}'` };
    }
    // Best-effort scheme match: scheme component is the part before `://`.
    const schemeEnd = uri.indexOf("://");
    if (schemeEnd > 0) {
      const scheme = uri.slice(0, schemeEnd);
      const server = this.server(scheme);
      if (server) return { server, error: "" };
    }
    return { error: `cannot route resource '${uri}' — pass params.serverName` };
  }

  // The only lookup routes may use — applies the approval gate.
  private server(name: string): McpServerConnection | undefined {
    if (!this.enabled(name)) return undefined;
    return this.deps.servers.get(name);
  }

  private enabled(name: string): boolean {
    return this.deps.isServerEnabled?.(name) ?? true;
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
