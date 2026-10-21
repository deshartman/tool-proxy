// Helper for handler-level tests (S3a / S4a / S5a in OUTPUT-SCHEMA.md).
//
// Tools are not exported as plain functions — they're closures captured by
// `server.registerTool(name, opts, handler)`. To exercise a handler in a
// unit test we need a fake McpServer that intercepts the registration and
// hands the captured handler back, paired with the declared schema so the
// test can zod-parse the structuredContent against it.
//
// Why parse schema with z.object(): tools follow SDK convention and pass
// the schema as a plain object of zod fields (NOT z.object({...})) — see
// OUTPUT-SCHEMA.md authoring rule #1. We re-wrap here so a single
// .parse(...) call can validate the structuredContent shape.

import type { Tool } from "@gtmi/toolproxy-connector/sdk";
import { z, type ZodRawShape } from "zod";

export interface RegisteredHandler {
  name: string;
  description: string;
  inputSchema: ZodRawShape | undefined;
  outputSchema: ZodRawShape | undefined;
  // The handler closure. We type the args/result loosely because each tool
  // has its own input args shape; tests cast at the call site.
  handler: (args: unknown, extra?: unknown) => Promise<unknown>;
}

// Capture the registration arguments without running an actual McpServer.
// `tool.register(...)` calls server.registerTool exactly once.
export function captureRegistration(tool: Tool): RegisteredHandler {
  let captured: RegisteredHandler | undefined;
  const fakeServer = {
    registerTool(
      name: string,
      config: {
        description?: string;
        inputSchema?: ZodRawShape;
        outputSchema?: ZodRawShape;
      },
      handler: (args: unknown, extra?: unknown) => Promise<unknown>,
    ) {
      captured = {
        name,
        description: config.description ?? "",
        inputSchema: config.inputSchema,
        outputSchema: config.outputSchema,
        handler,
      };
      return {} as never;
    },
  };
  // @ts-expect-error fake server only implements registerTool, which is
  // all every tool's register() function calls.
  tool.register(fakeServer);
  if (!captured) {
    throw new Error(`Tool '${tool.name}' did not call server.registerTool`);
  }
  return captured;
}

// Wrap a captured outputSchema (plain object of zod fields) so callers can
// validate structuredContent in one .parse(...). A schema-less tool gives
// back a zod object with no constraints; that's a defensive pass-through —
// the validate.test.ts suite already pins "every authored tool declares one"
// at the manifest layer.
export function asZodObject(shape: ZodRawShape | undefined): z.ZodObject<ZodRawShape> {
  return z.object(shape ?? {});
}

export interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

// Cast the unknown handler return into the MCP tool-result shape. Every
// crm/sample/apis tool returns this shape on both success and error paths.
export function asToolResult(value: unknown): ToolCallResult {
  return value as ToolCallResult;
}
