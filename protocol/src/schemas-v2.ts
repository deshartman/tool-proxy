// Protocol 2.x — derived from 1.x, carrying ONLY the agreed 2.0 deltas
// (AgenticProcedure plan §9.0 / shim plan §2–3). Every frame the contract does
// not touch is re-exported from schemas-v1.ts as the SAME schema object, so the
// two majors cannot drift apart by accident; a 2.x change is visible here as an
// explicit `.extend()` or omission.
//
// The 2.0 deltas:
//   1. register gains `shimId` (8 lowercase Crockford base32, required in 2.x).
//   2. Tool names are composed `<shimId>.<server>.<tool>` — see naming.ts. The
//      wire still carries server and tool names BARE inside descriptors; the
//      composition is a rule both sides apply with the exported helpers.
//   3. ManifestDelta gains `addedServers` / `removedServers`: a server whose
//      first appearance is a delta now arrives with its author and transport,
//      instead of the receiver inferring them (shim plan §2.5a).
//   4. `mcp-notification` is removed. No connector emitted it since §9.1/§9.4.
//   5. Server names must be dot-free (serverNameSchema) wherever a server name
//      appears, because the qualified-name parse depends on it.

import { z } from "zod";
import * as v1 from "./schemas-v1.js";
import { serverNameSchema, shimIdSchema } from "./naming.js";

// Re-exported unchanged.
export {
  ToolDescriptorSchema,
  PromptArgumentDescriptorSchema,
  PromptDescriptorSchema,
  ResourceDescriptorSchema,
  ResourceTemplateDescriptorSchema,
  ServerCapabilitiesAdvertSchema,
  CredsSourceSchema,
  McpAuthSpecSchema,
  RegisterAckFrameSchema,
  RpcFrameSchema,
  HeartbeatFrameSchema,
  GoodbyeFrameSchema,
  WebhookAllocateFrameSchema,
  WebhookAllocateAckFrameSchema,
  WebhookFrameSchema,
  WebhookRevokeFrameSchema,
  CredsRequestFrameSchema,
  CredsResponseFrameSchema,
  CredsUpdateFrameSchema,
  McpConfigAckFrameSchema,
  McpConfigResyncFrameSchema,
  LocalMcpsRescanFrameSchema,
  LocalMcpsRescanAckFrameSchema,
  McpDiscoveredFrameSchema,
  McpEnableFrameSchema,
  McpDisableFrameSchema,
  McpEnableAckFrameSchema,
  ControllerCallFrameSchema,
  ControllerCallResponseFrameSchema,
} from "./schemas-v1.js";

// Δ5 — a server name appears as a descriptor name and as a delta's `server`.
export const ServerDescriptorSchema = v1.ServerDescriptorSchema.extend({ name: serverNameSchema });

export const ToolManifestSchema = v1.ToolManifestSchema.extend({
  servers: z.array(ServerDescriptorSchema),
});

// A config entry's name becomes a server name once spawned.
export const McpConfigEntrySchema = v1.McpConfigEntrySchema.extend({ name: serverNameSchema });

// Δ3 — server lifecycle in deltas.
export const ServerAddedSchema = z.object({
  name: serverNameSchema,
  transport: z.enum(["http", "stdio"]),
  author: z.string(),
  protocolVersion: z.string().optional(),
});

export const ManifestDeltaSchema = v1.ManifestDeltaSchema.extend({
  addedServers: z.array(ServerAddedSchema).optional(),
  removedServers: z.array(serverNameSchema).optional(),
});

// Δ1 — register carries the shim's identity; tunnelProtocol is required in 2.x
// (a 2.x peer always knows its version; absence means a 1.x peer).
export const RegisterFrameSchema = v1.RegisterFrameSchema.extend({
  manifest: ToolManifestSchema,
  shimId: shimIdSchema,
  tunnelProtocol: z.string(),
});

export const ManifestDeltaFrameSchema = z.object({ type: z.literal("manifest-delta"), delta: ManifestDeltaSchema });

export const McpConfigSnapshotFrameSchema = v1.McpConfigSnapshotFrameSchema.extend({
  servers: z.array(McpConfigEntrySchema),
});

export const McpConfigDeltaFrameSchema = v1.McpConfigDeltaFrameSchema.extend({
  added: z.array(McpConfigEntrySchema).optional(),
  updated: z.array(McpConfigEntrySchema).optional(),
});

// Δ4 — mcp-notification is absent from both direction lists.
export const CONNECTOR_FRAME_SCHEMAS = [
  RegisterFrameSchema,
  ManifestDeltaFrameSchema,
  v1.RpcFrameSchema,
  v1.HeartbeatFrameSchema,
  v1.GoodbyeFrameSchema,
  v1.WebhookAllocateFrameSchema,
  v1.WebhookRevokeFrameSchema,
  v1.CredsRequestFrameSchema,
  v1.McpConfigAckFrameSchema,
  v1.McpConfigResyncFrameSchema,
  v1.LocalMcpsRescanAckFrameSchema,
  v1.McpDiscoveredFrameSchema,
  v1.McpEnableAckFrameSchema,
  v1.ControllerCallFrameSchema,
] as const;

export const CONTROLLER_FRAME_SCHEMAS = [
  v1.RegisterAckFrameSchema,
  v1.RpcFrameSchema,
  v1.HeartbeatFrameSchema,
  v1.GoodbyeFrameSchema,
  v1.WebhookAllocateAckFrameSchema,
  v1.WebhookFrameSchema,
  v1.CredsResponseFrameSchema,
  v1.CredsUpdateFrameSchema,
  McpConfigSnapshotFrameSchema,
  McpConfigDeltaFrameSchema,
  v1.LocalMcpsRescanFrameSchema,
  v1.McpEnableFrameSchema,
  v1.McpDisableFrameSchema,
  v1.ControllerCallResponseFrameSchema,
] as const;

export const ConnectorFrameSchema = z.discriminatedUnion("type", CONNECTOR_FRAME_SCHEMAS);
export const ControllerFrameSchema = z.discriminatedUnion("type", CONTROLLER_FRAME_SCHEMAS);
