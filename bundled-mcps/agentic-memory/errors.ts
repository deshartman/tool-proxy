// Structured tool errors per MEMORY-MCP-INTERFACE.md §10. Every mocked
// tool that returns an error responds via `isError: true` with the
// spec's envelope in `structuredContent.error`, so a caller inspecting
// either the structured result or the text content gets the same shape.

import type { CallToolResult } from "@modelcontextprotocol/server";

export type ErrorCode =
  | "not_implemented"
  | "invalid_identifier"
  | "identity_not_found"
  | "identity_merged"
  | "rate_limit_exceeded"
  | "storage_full"
  | "timeout"
  | "schema_mismatch"
  | "internal_error";

export interface StructuredError {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
    mergedInto?: string;
  };
}

// Must stay typed against the SDK's own result type. A hand-rolled `interface
// { isError: true; content: [...] }` lacks the index signature `registerTool`'s
// handler-return type requires, and TS doesn't extend fresh-object-literal
// leniency to a named interface — so it fails assignability at every call site
// (TS2769). `import type` is erased: no runtime dep. Intersection keeps narrowing.
export type ToolErrorResult = CallToolResult & { isError: true };

// Error results DO NOT include structuredContent — that would collide with
// each tool's outputSchema (which describes the happy-path shape). The
// spec's envelope goes in the text content as JSON, so callers can still
// parse it programmatically.
export function toolError(
  code: ErrorCode,
  message: string,
  extras: { retryable?: boolean; retryAfterMs?: number; mergedInto?: string } = {},
): ToolErrorResult {
  const payload: StructuredError = {
    error: {
      code,
      message,
      retryable: extras.retryable ?? false,
      ...(extras.retryAfterMs !== undefined ? { retryAfterMs: extras.retryAfterMs } : {}),
      ...(extras.mergedInto !== undefined ? { mergedInto: extras.mergedInto } : {}),
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}
