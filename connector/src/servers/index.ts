import { Client } from "@modelcontextprotocol/client";
import type { McpSubscription, SubscriptionFilter } from "@modelcontextprotocol/client";
import { createLogger } from "../logger.js";

// Connection-shape types + the makeConnection helper. This module exists
// independently of connectHttp / connectStdio (which live in their own
// transport files and dispatch through ./connect.js) so the cycle that used
// to exist — index.ts ↔ http.ts ↔ stdio.ts — is gone:
//
//   * http.ts and stdio.ts import only from index.ts (types + makeConnection)
//   * index.ts imports nothing from the transport files
//   * connect.ts imports from both transport files; consumers call into
//     connect.ts (not index.ts) for connectServer / connectAll
//
// `npx madge --circular connector/src` reports zero cycles after
// this split.
import type {
  PromptDescriptor,
  ResourceDescriptor,
  ResourceTemplateDescriptor,
  ServerCapabilitiesAdvert,
  ToolDescriptor,
} from "../tunnel/frames.js";

// Raw tool from a local MCP server, before being shaped into a ToolDescriptor.
export interface DiscoveredTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}

// Server-emitted notification we forward to the controller as `mcp-notification`.
// Opaque envelope — the dispatcher doesn't interpret beyond the JSON-RPC shape.
export interface ServerNotification {
  method: string;
  params?: unknown;
}

export interface McpServerConnection {
  name: string;
  transport: "http" | "stdio";
  // The capabilities the upstream MCP server advertised to the connector at
  // initialize time. Captured at connect time so the manifest builder can
  // surface them on the wire as part of ServerDescriptor.capabilities (used
  // by the controller to decide which optional method panels to render).
  capabilities?: ServerCapabilitiesAdvert;
  // §9.2 — the MCP protocol revision negotiated with this upstream at
  // initialize time (e.g. "2026-07-28" / "2025-11-25"). Captured at connect
  // time so the manifest builder can surface it per ServerDescriptor.
  // undefined when the client (or a test mock) doesn't expose the accessor.
  protocolVersion?: string;
  listTools(): Promise<DiscoveredTool[]>;
  callTool(name: string, args: unknown, opts: { timeoutMs: number }): Promise<unknown>;
  // Optional surface — only servers that advertised the matching capability
  // are guaranteed to answer. The dispatcher forwards any inbound call;
  // upstream rejection (-32601 etc.) is just relayed back.
  listPrompts(): Promise<PromptDescriptor[]>;
  getPrompt(name: string, args: Record<string, unknown> | undefined, opts: { timeoutMs: number }): Promise<unknown>;
  listResources(): Promise<ResourceDescriptor[]>;
  listResourceTemplates(): Promise<ResourceTemplateDescriptor[]>;
  readResource(uri: string, opts: { timeoutMs: number }): Promise<unknown>;
  subscribeResource(uri: string, opts: { timeoutMs: number }): Promise<unknown>;
  unsubscribeResource(uri: string, opts: { timeoutMs: number }): Promise<unknown>;
  complete(params: unknown, opts: { timeoutMs: number }): Promise<unknown>;
  setLoggingLevel(level: string, opts: { timeoutMs: number }): Promise<unknown>;
  // Subscribe to server-initiated notifications so the dispatcher can forward
  // them as `mcp-notification` frames. Returns an unsubscribe function.
  onNotification(handler: (n: ServerNotification) => void): () => void;
  close(): Promise<void>;
}

// Wrap a connected SDK Client in the McpServerConnection shape the rest of
// the connector consumes. Lives here (alongside the type it implements)
// rather than in http.ts so stdio.ts can import it without forming a cycle.
export function makeConnection(
  name: string,
  transport: "http" | "stdio",
  client: Client,
): McpServerConnection {
  // Multi-subscriber fan-out for server-initiated notifications. The SDK only
  // exposes a single `fallbackNotificationHandler` slot; we install one
  // forwarder and dispatch to every subscriber registered by the dispatcher.
  const notifSubscribers = new Set<(n: ServerNotification) => void>();
  // Install once. Ignores in-band MCP notifications the SDK already routes
  // (initialized, cancelled, progress wired to the request that requested it)
  // — those have no method we need to forward. The fallback fires for
  // notifications the SDK didn't register a method-specific handler for,
  // which covers `notifications/message`, `notifications/resources/updated`,
  // `notifications/resources/list_changed`, prompts/tools list_changed,
  // and `notifications/progress` when no in-flight request is correlated.
  // The cast covers test-time mocks of Client that omit this slot — the
  // real SDK Client always has it.
  (client as unknown as { fallbackNotificationHandler?: (n: { method: string; params?: unknown }) => Promise<void> })
    .fallbackNotificationHandler = async (notification: { method: string; params?: unknown }) => {
      const n: ServerNotification = {
        method: notification.method,
        params: notification.params,
      };
      for (const handler of notifSubscribers) handler(n);
    };

  // getServerCapabilities is only meaningful after .connect() — and only
  // on the real SDK Client. Test mocks frequently omit it; failing soft
  // here means buildManifest just doesn't surface capability flags for
  // those mocks. That's correct: a missing capabilities object means
  // "didn't declare", which is exactly what an undefined return signals.
  const capabilities = typeof (client as unknown as { getServerCapabilities?: () => unknown }).getServerCapabilities === "function"
    ? (client.getServerCapabilities() as ServerCapabilitiesAdvert | undefined)
    : undefined;

  // §9.2 — exact negotiated protocol revision string ("2026-07-28" /
  // "2025-11-25"). Distinct from getProtocolEra() (the "modern"/"legacy"
  // label used below); the manifest surfaces the precise revision per MCP.
  const protocolVersion = (client as { getNegotiatedProtocolVersion?: () => string | undefined })
    .getNegotiatedProtocolVersion?.();

  // 2026-07-28 removed unsolicited server→client notifications: tools/prompts/
  // resources list_changed and per-resource resources/updated are delivered
  // ONLY on a `subscriptions/listen` stream the client opens. We open one for
  // the change types the server advertised; the SDK routes its notifications to
  // the same fallbackNotificationHandler installed above, so they reach the
  // controller unchanged (listen() is era-transparent that way). On a 2025-era
  // connection these arrive unsolicited and listen() throws — hence modern-only.
  // Per-resource subscriptions open their own streams in subscribeResource.
  const era = (client as { getProtocolEra?: () => string | undefined }).getProtocolEra?.();
  const isModern = era === "modern";
  const subLog = createLogger(`mcp:${name}`);
  let changeSub: McpSubscription | undefined;
  const resourceSubs = new Map<string, McpSubscription>();

  if (isModern) {
    const filter: SubscriptionFilter = {};
    const caps = capabilities as Record<string, { listChanged?: boolean } | undefined> | undefined;
    if (caps?.tools?.listChanged) filter.toolsListChanged = true;
    if (caps?.prompts?.listChanged) filter.promptsListChanged = true;
    if (caps?.resources?.listChanged) filter.resourcesListChanged = true;
    if (Object.keys(filter).length > 0) {
      // Fire-and-forget: connection setup must not block on the listen ack.
      void client.listen(filter).then(
        (sub) => { changeSub = sub; },
        (err) => subLog.warn({ err: String(err) }, "subscriptions/listen (list_changed) failed to open"),
      );
    }
  }

  return {
    name,
    transport,
    capabilities,
    protocolVersion,
    async listTools(): Promise<DiscoveredTool[]> {
      const result = await client.listTools();
      return result.tools.map((tool) => ({
        name: tool.name,
        title: tool.title ?? tool.annotations?.title,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      }));
    },
    async callTool(toolName, args, opts) {
      return client.callTool(
        { name: toolName, arguments: args as Record<string, unknown> | undefined },
        { timeout: opts.timeoutMs },
      );
    },
    async listPrompts(): Promise<PromptDescriptor[]> {
      const result = await client.listPrompts();
      return result.prompts.map((prompt) => stripUndefined<PromptDescriptor>({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments?.map((arg) => stripUndefined({
          name: arg.name,
          description: arg.description,
          required: arg.required,
        })),
      }));
    },
    async getPrompt(promptName, args, opts) {
      return client.getPrompt(
        { name: promptName, ...(args ? { arguments: args as Record<string, string> } : {}) },
        { timeout: opts.timeoutMs },
      );
    },
    async listResources(): Promise<ResourceDescriptor[]> {
      const result = await client.listResources();
      return result.resources.map((resource) => stripUndefined<ResourceDescriptor>({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      }));
    },
    async listResourceTemplates(): Promise<ResourceTemplateDescriptor[]> {
      const result = await client.listResourceTemplates();
      return result.resourceTemplates.map((tmpl) => stripUndefined<ResourceTemplateDescriptor>({
        uriTemplate: tmpl.uriTemplate,
        name: tmpl.name,
        description: tmpl.description,
        mimeType: tmpl.mimeType,
      }));
    },
    async readResource(uri, opts) {
      return client.readResource({ uri }, { timeout: opts.timeoutMs });
    },
    async subscribeResource(uri, opts) {
      // 2026: per-resource updates arrive on a subscriptions/listen stream
      // scoped to this URI (notifications route to the fallback forwarder).
      // 2025: the classic resources/subscribe RPC (unsolicited updates).
      if (isModern) {
        const sub = await client.listen({ resourceSubscriptions: [uri] }, { timeout: opts.timeoutMs });
        await resourceSubs.get(uri)?.close().catch(() => {}); // idempotent re-subscribe
        resourceSubs.set(uri, sub);
        return {};
      }
      return client.subscribeResource({ uri }, { timeout: opts.timeoutMs });
    },
    async unsubscribeResource(uri, opts) {
      if (isModern) {
        const sub = resourceSubs.get(uri);
        if (sub) {
          resourceSubs.delete(uri);
          await sub.close().catch(() => {});
        }
        return {};
      }
      return client.unsubscribeResource({ uri }, { timeout: opts.timeoutMs });
    },
    async complete(params, opts) {
      return client.complete(params as Parameters<Client["complete"]>[0], { timeout: opts.timeoutMs });
    },
    async setLoggingLevel(level, opts) {
      return client.setLoggingLevel(level as Parameters<Client["setLoggingLevel"]>[0], { timeout: opts.timeoutMs });
    },
    onNotification(handler) {
      notifSubscribers.add(handler);
      return () => notifSubscribers.delete(handler);
    },
    async close() {
      // Tear down any 2026 listen streams first; client.close() then aborts
      // the transport. Every close() here is idempotent.
      await changeSub?.close().catch(() => {});
      for (const sub of resourceSubs.values()) await sub.close().catch(() => {});
      resourceSubs.clear();
      await client.close();
    },
  };
}

// Drop keys whose value is undefined so the resulting object only carries the
// fields that were actually advertised. The MCP SDK consistently uses
// `field?: T | undefined` shapes; serialising those undefineds onto the wire
// would inflate the manifest and confuse strict consumers.
function stripUndefined<T extends object>(input: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

// Helper: shape a DiscoveredTool into a ToolDescriptor with the allowed flag set.
export function toDescriptor(tool: DiscoveredTool, allowed: boolean): ToolDescriptor {
  return stripUndefined<ToolDescriptor>({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    allowed,
  });
}
