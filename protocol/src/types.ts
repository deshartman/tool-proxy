// TypeScript types for every frame, DERIVED from the Zod schemas so the types
// and the runtime validation can never disagree. Import these; don't redeclare.

import type { z } from "zod";
import type * as S from "./schemas.js";

export type ToolDescriptor = z.infer<typeof S.ToolDescriptorSchema>;
export type PromptArgumentDescriptor = z.infer<typeof S.PromptArgumentDescriptorSchema>;
export type PromptDescriptor = z.infer<typeof S.PromptDescriptorSchema>;
export type ResourceDescriptor = z.infer<typeof S.ResourceDescriptorSchema>;
export type ResourceTemplateDescriptor = z.infer<typeof S.ResourceTemplateDescriptorSchema>;
export type ServerCapabilitiesAdvert = z.infer<typeof S.ServerCapabilitiesAdvertSchema>;
export type ServerDescriptor = z.infer<typeof S.ServerDescriptorSchema>;
export type ToolManifest = z.infer<typeof S.ToolManifestSchema>;
export type ManifestDelta = z.infer<typeof S.ManifestDeltaSchema>;
export type CredsSource = z.infer<typeof S.CredsSourceSchema>;
export type McpAuthSpec = z.infer<typeof S.McpAuthSpecSchema>;
export type McpConfigEntry = z.infer<typeof S.McpConfigEntrySchema>;

export type RegisterFrame = z.infer<typeof S.RegisterFrameSchema>;
export type RegisterAckFrame = z.infer<typeof S.RegisterAckFrameSchema>;
export type ManifestDeltaFrame = z.infer<typeof S.ManifestDeltaFrameSchema>;
export type RpcFrame = z.infer<typeof S.RpcFrameSchema>;
export type HeartbeatFrame = z.infer<typeof S.HeartbeatFrameSchema>;
export type GoodbyeFrame = z.infer<typeof S.GoodbyeFrameSchema>;
export type WebhookAllocateFrame = z.infer<typeof S.WebhookAllocateFrameSchema>;
export type WebhookAllocateAckFrame = z.infer<typeof S.WebhookAllocateAckFrameSchema>;
export type WebhookFrame = z.infer<typeof S.WebhookFrameSchema>;
export type WebhookRevokeFrame = z.infer<typeof S.WebhookRevokeFrameSchema>;
export type CredsRequestFrame = z.infer<typeof S.CredsRequestFrameSchema>;
export type CredsResponseFrame = z.infer<typeof S.CredsResponseFrameSchema>;
export type CredsUpdateFrame = z.infer<typeof S.CredsUpdateFrameSchema>;
export type McpConfigSnapshotFrame = z.infer<typeof S.McpConfigSnapshotFrameSchema>;
export type McpConfigDeltaFrame = z.infer<typeof S.McpConfigDeltaFrameSchema>;
export type McpConfigAckFrame = z.infer<typeof S.McpConfigAckFrameSchema>;
export type McpConfigResyncFrame = z.infer<typeof S.McpConfigResyncFrameSchema>;
export type LocalMcpsRescanFrame = z.infer<typeof S.LocalMcpsRescanFrameSchema>;
export type LocalMcpsRescanAckFrame = z.infer<typeof S.LocalMcpsRescanAckFrameSchema>;
export type McpNotificationFrame = z.infer<typeof S.McpNotificationFrameSchema>;
export type McpDiscoveredFrame = z.infer<typeof S.McpDiscoveredFrameSchema>;
export type McpEnableFrame = z.infer<typeof S.McpEnableFrameSchema>;
export type McpDisableFrame = z.infer<typeof S.McpDisableFrameSchema>;
export type McpEnableAckFrame = z.infer<typeof S.McpEnableAckFrameSchema>;
export type ControllerCallFrame = z.infer<typeof S.ControllerCallFrameSchema>;
export type ControllerCallResponseFrame = z.infer<typeof S.ControllerCallResponseFrameSchema>;

/** Frames a connector sends (a controller receives). */
export type ConnectorFrame = z.infer<typeof S.ConnectorFrameSchema>;
/** Frames a controller sends (a connector receives). */
export type ControllerFrame = z.infer<typeof S.ControllerFrameSchema>;
