export type { Tool } from "./tool.js";
export type { Prompt } from "./prompt.js";
export type { Resource } from "./resource.js";
export { createMcpHttpServer } from "./http-server.js";
export type { CreateMcpHttpServerOptions, McpHttpServerHandle } from "./http-server.js";
export { createWebhookEndpoint } from "./webhook.js";
export type {
  WebhookEndpoint,
  WebhookEndpointOptions,
  WebhookEvent,
  WebhookEventName,
} from "./webhook.js";
export { callControllerApi } from "./controller-api.js";
export type { CallControllerApiOptions } from "./controller-api.js";
export { createLogger } from "../logger.js";
export type { Logger } from "../logger.js";

// Empty-string-safe env readers (MCP-AUDIT #21). Exported for MCP authors so a
// drop-in can honour the same "empty string == not set" rule the connector's own
// src/ does: `FOO=` (a blank line in a dir/.env, or a controller-supplied key
// cleared to "") means "leave this unset", not "set it to the empty string".
// `process.env.FOO ?? default` gets that wrong — "" is not nullish, so the
// default is skipped and the empty value flows into a URL, a port number, or a
// log level. Use envString / envOptional / envNumber, never `??`.
export { envString, envOptional, envNumber } from "../env.js";
