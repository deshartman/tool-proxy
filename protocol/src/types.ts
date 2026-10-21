// TypeScript types DERIVED from the Zod schemas, so types and runtime
// validation can never disagree. Import these; don't redeclare.
//
// Three majors: `V1` (frozen 1.x wire), `V2` (the 2.0 deltas) and `V3` (the
// 3.0 proxyId rename). The unprefixed
// names are aliases for the CURRENT major — the one PROTOCOL_VERSION speaks.

import type { z } from "zod";
import type * as S1 from "./schemas-v1.js";
import type * as S2 from "./schemas-v2.js";
import type * as S3 from "./schemas-v3.js";

type Infer<T extends z.ZodType> = z.infer<T>;

export namespace V1 {
  export type ToolDescriptor = Infer<typeof S1.ToolDescriptorSchema>;
  export type ServerDescriptor = Infer<typeof S1.ServerDescriptorSchema>;
  export type ToolManifest = Infer<typeof S1.ToolManifestSchema>;
  export type ManifestDelta = Infer<typeof S1.ManifestDeltaSchema>;
  export type McpConfigEntry = Infer<typeof S1.McpConfigEntrySchema>;
  export type RegisterFrame = Infer<typeof S1.RegisterFrameSchema>;
  export type RegisterAckFrame = Infer<typeof S1.RegisterAckFrameSchema>;
  export type McpDiscoveredFrame = Infer<typeof S1.McpDiscoveredFrameSchema>;
  export type McpNotificationFrame = Infer<typeof S1.McpNotificationFrameSchema>;
  export type ConnectorFrame = Infer<typeof S1.ConnectorFrameSchema>;
  export type ControllerFrame = Infer<typeof S1.ControllerFrameSchema>;
}

export namespace V2 {
  export type ToolDescriptor = Infer<typeof S2.ToolDescriptorSchema>;
  export type ServerDescriptor = Infer<typeof S2.ServerDescriptorSchema>;
  export type ToolManifest = Infer<typeof S2.ToolManifestSchema>;
  export type ManifestDelta = Infer<typeof S2.ManifestDeltaSchema>;
  export type ServerAdded = Infer<typeof S2.ServerAddedSchema>;
  export type McpConfigEntry = Infer<typeof S2.McpConfigEntrySchema>;
  export type RegisterFrame = Infer<typeof S2.RegisterFrameSchema>;
  export type RegisterAckFrame = Infer<typeof S2.RegisterAckFrameSchema>;
  export type McpDiscoveredFrame = Infer<typeof S2.McpDiscoveredFrameSchema>;
  export type ConnectorFrame = Infer<typeof S2.ConnectorFrameSchema>;
  export type ControllerFrame = Infer<typeof S2.ControllerFrameSchema>;
}

export namespace V3 {
  export type ToolDescriptor = Infer<typeof S3.ToolDescriptorSchema>;
  export type ServerDescriptor = Infer<typeof S3.ServerDescriptorSchema>;
  export type ToolManifest = Infer<typeof S3.ToolManifestSchema>;
  export type ManifestDelta = Infer<typeof S3.ManifestDeltaSchema>;
  export type ServerAdded = Infer<typeof S3.ServerAddedSchema>;
  export type McpConfigEntry = Infer<typeof S3.McpConfigEntrySchema>;
  export type RegisterFrame = Infer<typeof S3.RegisterFrameSchema>;
  export type RegisterAckFrame = Infer<typeof S3.RegisterAckFrameSchema>;
  export type McpDiscoveredFrame = Infer<typeof S3.McpDiscoveredFrameSchema>;
  export type ConnectorFrame = Infer<typeof S3.ConnectorFrameSchema>;
  export type ControllerFrame = Infer<typeof S3.ControllerFrameSchema>;
}

// Shapes identical in every major.
export type PromptArgumentDescriptor = Infer<typeof S1.PromptArgumentDescriptorSchema>;
export type PromptDescriptor = Infer<typeof S1.PromptDescriptorSchema>;
export type ResourceDescriptor = Infer<typeof S1.ResourceDescriptorSchema>;
export type ResourceTemplateDescriptor = Infer<typeof S1.ResourceTemplateDescriptorSchema>;
export type ServerCapabilitiesAdvert = Infer<typeof S1.ServerCapabilitiesAdvertSchema>;
export type CredsSource = Infer<typeof S1.CredsSourceSchema>;
export type McpAuthSpec = Infer<typeof S1.McpAuthSpecSchema>;
export type ManifestDeltaFrame = Infer<typeof S1.ManifestDeltaFrameSchema>;
export type RpcFrame = Infer<typeof S1.RpcFrameSchema>;
export type HeartbeatFrame = Infer<typeof S1.HeartbeatFrameSchema>;
export type GoodbyeFrame = Infer<typeof S1.GoodbyeFrameSchema>;
export type WebhookAllocateFrame = Infer<typeof S1.WebhookAllocateFrameSchema>;
export type WebhookAllocateAckFrame = Infer<typeof S1.WebhookAllocateAckFrameSchema>;
export type WebhookFrame = Infer<typeof S1.WebhookFrameSchema>;
export type WebhookRevokeFrame = Infer<typeof S1.WebhookRevokeFrameSchema>;
export type CredsRequestFrame = Infer<typeof S1.CredsRequestFrameSchema>;
export type CredsResponseFrame = Infer<typeof S1.CredsResponseFrameSchema>;
export type CredsUpdateFrame = Infer<typeof S1.CredsUpdateFrameSchema>;
export type McpConfigSnapshotFrame = Infer<typeof S1.McpConfigSnapshotFrameSchema>;
export type McpConfigDeltaFrame = Infer<typeof S1.McpConfigDeltaFrameSchema>;
export type McpConfigAckFrame = Infer<typeof S1.McpConfigAckFrameSchema>;
export type McpConfigResyncFrame = Infer<typeof S1.McpConfigResyncFrameSchema>;
export type LocalMcpsRescanFrame = Infer<typeof S1.LocalMcpsRescanFrameSchema>;
export type LocalMcpsRescanAckFrame = Infer<typeof S1.LocalMcpsRescanAckFrameSchema>;
export type McpEnableFrame = Infer<typeof S1.McpEnableFrameSchema>;
export type McpDisableFrame = Infer<typeof S1.McpDisableFrameSchema>;
export type McpEnableAckFrame = Infer<typeof S1.McpEnableAckFrameSchema>;
export type ControllerCallFrame = Infer<typeof S1.ControllerCallFrameSchema>;
export type ControllerCallResponseFrame = Infer<typeof S1.ControllerCallResponseFrameSchema>;

// The current major — PROTOCOL_VERSION is still "1.0" until the connector's
// Phase 2b flips it, so these resolve to V1 today.
export type ToolDescriptor = V1.ToolDescriptor;
export type ServerDescriptor = V1.ServerDescriptor;
export type ToolManifest = V1.ToolManifest;
export type ManifestDelta = V1.ManifestDelta;
export type McpConfigEntry = V1.McpConfigEntry;
export type RegisterFrame = V1.RegisterFrame;
export type RegisterAckFrame = V1.RegisterAckFrame;
export type McpDiscoveredFrame = V1.McpDiscoveredFrame;
export type McpNotificationFrame = V1.McpNotificationFrame;
export type ConnectorFrame = V1.ConnectorFrame;
export type ControllerFrame = V1.ControllerFrame;
