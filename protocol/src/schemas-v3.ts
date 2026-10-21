// Protocol 3.x — the Tool Proxy rename. Derived from 2.x and carrying ONLY the
// identity delta: register's `shimId` becomes `proxyId`. Every other schema is
// re-exported from schemas-v2.ts as the SAME object, so 3.x cannot drift from
// 2.x by accident; a 3.x change is visible here as an explicit `.extend()`.
//
// The 3.0 deltas:
//   1. register carries `proxyId` (8 lowercase Crockford base32, required) in
//      place of `shimId`. `tunnelProtocol` stays required.
//   2. Tool names are composed `<proxyId>.<server>.<tool>` — see naming.ts.
//
// 2.x (`shimId`) is frozen in schemas-v2.ts and still negotiated: a 3.x
// connector speaks 2.x to a controller that only advertises 2.x.

import { z } from "zod";
import * as v2 from "./schemas-v2.js";
import { proxyIdSchema } from "./naming.js";

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
  ServerDescriptorSchema,
  ToolManifestSchema,
  McpConfigEntrySchema,
  ServerAddedSchema,
  ManifestDeltaSchema,
  ManifestDeltaFrameSchema,
  McpConfigSnapshotFrameSchema,
  McpConfigDeltaFrameSchema,
} from "./schemas-v2.js";

// Δ1 — `shimId` is dropped, `proxyId` required.
export const RegisterFrameSchema = v2.RegisterFrameSchema.omit({ shimId: true }).extend({
  proxyId: proxyIdSchema,
});

export const CONNECTOR_FRAME_SCHEMAS = [
  RegisterFrameSchema,
  ...v2.CONNECTOR_FRAME_SCHEMAS.filter((s) => s.shape.type.value !== "register"),
] as unknown as readonly [
  typeof RegisterFrameSchema,
  ...(typeof v2.CONNECTOR_FRAME_SCHEMAS)[number][],
];

export const CONTROLLER_FRAME_SCHEMAS = v2.CONTROLLER_FRAME_SCHEMAS;

export const ConnectorFrameSchema = z.discriminatedUnion("type", CONNECTOR_FRAME_SCHEMAS as unknown as [
  typeof RegisterFrameSchema,
  ...(typeof v2.CONNECTOR_FRAME_SCHEMAS)[number][],
]);
export const ControllerFrameSchema = v2.ControllerFrameSchema;
