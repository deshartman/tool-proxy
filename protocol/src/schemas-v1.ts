// Protocol 1.x — Zod schemas for every tunnel frame. These ARE the 1.x wire
// contract, frozen: 1.0 is exactly the wire as of 2026-10-09. Do not edit a
// 1.x shape to suit 2.x — derive the change in schemas-v2.ts instead.
//
// Zod schemas for every tunnel frame. These ARE the wire contract: the
// TypeScript types in ./types.ts are derived from them with z.infer, so the
// two can never disagree. docs/MCP-PROTOCOL.md is the prose explanation; where
// it and these schemas differ, the schemas win and the doc has a bug.
//
// Objects are declared plain (z.object). Strictness is applied at parse time
// by ./parse.ts, which knows the peer's protocol minor: strict against the same
// minor, strip unknown fields from a newer one. That keeps additive changes
// deployable without a lockstep upgrade, while still catching typos and drift
// between peers on the same minor.
//
// Open-ended string fields stay z.string(), not enums, where the wire has
// always been open — `author`, error `code`s — so a new value is not a break.

import { z } from "zod";

// ── Shared descriptors ──────────────────────────────────────────────────────

export const ToolDescriptorSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string(),
  inputSchema: z.unknown(),
  outputSchema: z.unknown().optional(),
  allowed: z.boolean(),
});

export const PromptArgumentDescriptorSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
});

export const PromptDescriptorSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  arguments: z.array(PromptArgumentDescriptorSchema).optional(),
});

export const ResourceDescriptorSchema = z.object({
  uri: z.string(),
  name: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});

export const ResourceTemplateDescriptorSchema = z.object({
  uriTemplate: z.string(),
  name: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});

export const ServerCapabilitiesAdvertSchema = z.object({
  prompts: z.object({ listChanged: z.boolean().optional() }).optional(),
  resources: z.object({ listChanged: z.boolean().optional(), subscribe: z.boolean().optional() }).optional(),
  tools: z.object({ listChanged: z.boolean().optional() }).optional(),
  completions: z.record(z.string(), z.never()).optional(),
  logging: z.record(z.string(), z.never()).optional(),
});

export const ServerDescriptorSchema = z.object({
  name: z.string(),
  transport: z.enum(["http", "stdio"]),
  author: z.string(),
  envKeys: z.array(z.string()).optional(),
  tools: z.array(ToolDescriptorSchema),
  prompts: z.array(PromptDescriptorSchema).optional(),
  resources: z.array(ResourceDescriptorSchema).optional(),
  resourceTemplates: z.array(ResourceTemplateDescriptorSchema).optional(),
  capabilities: ServerCapabilitiesAdvertSchema.optional(),
  protocolVersion: z.string().optional(),
});

export const ToolManifestSchema = z.object({
  connectorId: z.string(),
  environment: z.string(),
  version: z.string(),
  servers: z.array(ServerDescriptorSchema),
});

const serverTool = z.object({ server: z.string(), tool: ToolDescriptorSchema });
const serverName = (key: string) => z.object({ server: z.string(), [key]: z.string() });

export const ManifestDeltaSchema = z.object({
  added: z.array(serverTool),
  removed: z.array(z.object({ server: z.string(), tool: z.string() })),
  changed: z.array(serverTool),
  addedPrompts: z.array(z.object({ server: z.string(), prompt: PromptDescriptorSchema })).optional(),
  removedPrompts: z.array(serverName("prompt")).optional(),
  changedPrompts: z.array(z.object({ server: z.string(), prompt: PromptDescriptorSchema })).optional(),
  addedResources: z.array(z.object({ server: z.string(), resource: ResourceDescriptorSchema })).optional(),
  removedResources: z.array(serverName("resource")).optional(),
  changedResources: z.array(z.object({ server: z.string(), resource: ResourceDescriptorSchema })).optional(),
  addedResourceTemplates: z
    .array(z.object({ server: z.string(), resourceTemplate: ResourceTemplateDescriptorSchema }))
    .optional(),
  removedResourceTemplates: z.array(serverName("resourceTemplate")).optional(),
  changedResourceTemplates: z
    .array(z.object({ server: z.string(), resourceTemplate: ResourceTemplateDescriptorSchema }))
    .optional(),
});

const errorObject = z.object({ code: z.string(), message: z.string() });

export const CredsSourceSchema = z.enum(["twilio-tunnel-row", "operator-entered", "none"]);

export const McpAuthSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("bearer"), envKey: z.string() }),
  z.object({ kind: z.literal("header"), headerName: z.string(), envKey: z.string() }),
  z.object({
    kind: z.literal("oauth2-client-credentials"),
    tokenUrlEnvKey: z.string(),
    clientIdEnvKey: z.string(),
    clientSecretEnvKey: z.string(),
    scopes: z.array(z.string()).optional(),
  }),
]);

export const McpConfigEntrySchema = z.object({
  mcpId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  transport: z.enum(["http", "streamable-http", "sse", "websocket", "stdio"]),
  url: z.string().optional(),
  command: z.array(z.string()).optional(),
  auth: McpAuthSpecSchema,
  envKeys: z.array(z.string()).optional(),
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

export const RegisterFrameSchema = z.object({
  type: z.literal("register"),
  manifest: ToolManifestSchema,
  name: z.string().optional(),
  registrationToken: z.string().optional(),
  // "<major>.<minor>". Absent means a 1.x peer that predates the field.
  tunnelProtocol: z.string().optional(),
  // 1.0.1 — the NEXT major's handshake field, tolerated (not validated) so a
  // 2.x connector can register with a 1.x controller that ENFORCES validation.
  // Without it a strict 1.x parse rejects a 2.x register as unrecognized_keys,
  // and a customer who upgrades the connector before the controller gets a
  // dead tunnel. A 1.x controller ignores the value and stays 1.x; the session
  // major is min(connector, controller) at register-ack. Only register needs
  // this — every later frame is sent in the negotiated major. Format is
  // deliberately unchecked here: it is a 2.x field, validated by 2.x.
  shimId: z.string().optional(),
});

export const RegisterAckFrameSchema = z.object({
  type: z.literal("register-ack"),
  connectorId: z.string().optional(),
  accepted: z.boolean().optional(),
  error: errorObject.optional(),
  acceptedToolCount: z.number().optional(),
  registrationToken: z.string().optional(),
  // The controller's supported tunnelProtocol range, echoed on every ack so
  // the connector learns the peer's minor. Absent from a controller that
  // predates the field.
  supportedTunnelProtocol: z.object({ min: z.string(), max: z.string() }).optional(),
});

export const ManifestDeltaFrameSchema = z.object({ type: z.literal("manifest-delta"), delta: ManifestDeltaSchema });
export const RpcFrameSchema = z.object({ type: z.literal("rpc"), payload: z.unknown() });
export const HeartbeatFrameSchema = z.object({ type: z.literal("heartbeat"), ts: z.number() });
export const GoodbyeFrameSchema = z.object({ type: z.literal("goodbye"), reason: z.string().optional() });

// ── Webhook ingress ─────────────────────────────────────────────────────────

export const WebhookAllocateFrameSchema = z.object({
  type: z.literal("webhook-allocate"),
  mcp: z.string(),
  ttlSeconds: z.number().optional(),
});

export const WebhookAllocateAckFrameSchema = z.object({
  type: z.literal("webhook-allocate-ack"),
  mcp: z.string(),
  url: z.string().optional(),
  error: errorObject.optional(),
});

export const WebhookFrameSchema = z.object({
  type: z.literal("webhook"),
  mcp: z.string(),
  queryParameters: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  body: z.unknown(),
  headers: z.record(z.string(), z.string()).optional(),
  receivedAt: z.number(),
});

export const WebhookRevokeFrameSchema = z.object({ type: z.literal("webhook-revoke"), mcp: z.string() });

// ── Creds ───────────────────────────────────────────────────────────────────

export const CredsRequestFrameSchema = z.object({
  type: z.literal("creds-request"),
  requestId: z.string(),
  mcp: z.string(),
  mcpId: z.string().optional(),
  author: z.string(),
  envKeys: z.array(z.string()),
});

export const CredsResponseFrameSchema = z.object({
  type: z.literal("creds-response"),
  requestId: z.string(),
  env: z.record(z.string(), z.string()).optional(),
  source: CredsSourceSchema.optional(),
  error: z.string().optional(),
});

export const CredsUpdateFrameSchema = z.object({
  type: z.literal("creds-update"),
  mcp: z.string(),
  mcpId: z.string().optional(),
  env: z.record(z.string(), z.string()),
  source: CredsSourceSchema,
  reason: z.string().optional(),
});

// ── v1.1 3rd-party roster ───────────────────────────────────────────────────

export const McpConfigSnapshotFrameSchema = z.object({
  type: z.literal("mcp-config-snapshot"),
  generation: z.number(),
  servers: z.array(McpConfigEntrySchema),
});

export const McpConfigDeltaFrameSchema = z.object({
  type: z.literal("mcp-config-delta"),
  generation: z.number(),
  added: z.array(McpConfigEntrySchema).optional(),
  updated: z.array(McpConfigEntrySchema).optional(),
  removed: z.array(z.string()).optional(),
});

export const McpConfigAckFrameSchema = z.object({
  type: z.literal("mcp-config-ack"),
  generation: z.number(),
  perMcp: z.array(
    z.object({
      mcpId: z.string(),
      name: z.string(),
      status: z.enum(["started", "failed", "skipped", "removed"]),
      error: z.string().optional(),
    }),
  ),
});

export const McpConfigResyncFrameSchema = z.object({
  type: z.literal("mcp-config-resync"),
  reason: z.enum(["gap", "boot", "manual"]),
});

// ── v1.2 local rescan + notifications ───────────────────────────────────────

export const LocalMcpsRescanFrameSchema = z.object({ type: z.literal("local-mcps-rescan") });

export const LocalMcpsRescanAckFrameSchema = z.object({
  type: z.literal("local-mcps-rescan-ack"),
  added: z.array(z.object({ name: z.string(), toolsCount: z.number() })),
  removed: z.array(z.string()),
  unchanged: z.array(z.string()),
  errors: z.array(z.object({ name: z.string(), error: z.string() })),
});

// Retained so an older peer's frame still parses; no current connector emits it.
export const McpNotificationFrameSchema = z.object({
  type: z.literal("mcp-notification"),
  server: z.string(),
  payload: z.unknown(),
});

// ── v1.3 approval gate ──────────────────────────────────────────────────────

export const McpDiscoveredFrameSchema = z.object({
  type: z.literal("mcp-discovered"),
  mcp: z.string(),
  author: z.string(),
  // "local" is the pre-gated-everything literal for a customer drop-in; a
  // receiver MUST treat it as "dropin". New connectors never send it.
  source: z.enum(["bundled", "dropin", "yaml", "local"]),
  kind: z.literal("example").optional(),
  envKeys: z.array(z.string()),
  tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
  discoveredAt: z.string(),
});

export const McpEnableFrameSchema = z.object({
  type: z.literal("mcp-enable"),
  mcp: z.string(),
  env: z.record(z.string(), z.string()).optional(),
  source: z.literal("operator-entered").optional(),
});

export const McpDisableFrameSchema = z.object({ type: z.literal("mcp-disable"), mcp: z.string() });

export const McpEnableAckFrameSchema = z.object({
  type: z.literal("mcp-enable-ack"),
  mcp: z.string(),
  status: z.enum(["enabled", "disabled", "error"]),
  error: z.string().optional(),
  toolsCount: z.number().optional(),
});

// ── v1.4 controller calls ───────────────────────────────────────────────────

export const ControllerCallFrameSchema = z.object({
  type: z.literal("controller-call"),
  requestId: z.string(),
  mcp: z.string(),
  mcpId: z.string().optional(),
  action: z.string(),
  params: z.unknown(),
});

export const ControllerCallResponseFrameSchema = z.object({
  type: z.literal("controller-call-response"),
  requestId: z.string(),
  result: z.unknown().optional(),
  error: errorObject.optional(),
});

// ── Direction unions ────────────────────────────────────────────────────────

// Frames a connector sends; a controller receives these.
export const CONNECTOR_FRAME_SCHEMAS = [
  RegisterFrameSchema,
  ManifestDeltaFrameSchema,
  RpcFrameSchema,
  HeartbeatFrameSchema,
  GoodbyeFrameSchema,
  WebhookAllocateFrameSchema,
  WebhookRevokeFrameSchema,
  CredsRequestFrameSchema,
  McpConfigAckFrameSchema,
  McpConfigResyncFrameSchema,
  LocalMcpsRescanAckFrameSchema,
  McpNotificationFrameSchema,
  McpDiscoveredFrameSchema,
  McpEnableAckFrameSchema,
  ControllerCallFrameSchema,
] as const;

// Frames a controller sends; a connector receives these. `rpc`, `heartbeat`
// and `goodbye` travel in both directions.
export const CONTROLLER_FRAME_SCHEMAS = [
  RegisterAckFrameSchema,
  RpcFrameSchema,
  HeartbeatFrameSchema,
  GoodbyeFrameSchema,
  WebhookAllocateAckFrameSchema,
  WebhookFrameSchema,
  CredsResponseFrameSchema,
  CredsUpdateFrameSchema,
  McpConfigSnapshotFrameSchema,
  McpConfigDeltaFrameSchema,
  LocalMcpsRescanFrameSchema,
  McpEnableFrameSchema,
  McpDisableFrameSchema,
  ControllerCallResponseFrameSchema,
] as const;

export const ConnectorFrameSchema = z.discriminatedUnion("type", CONNECTOR_FRAME_SCHEMAS);
export const ControllerFrameSchema = z.discriminatedUnion("type", CONTROLLER_FRAME_SCHEMAS);
