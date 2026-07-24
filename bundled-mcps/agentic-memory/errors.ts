// Structured tool errors per MEMORY-MCP-INTERFACE.md §10. Every mocked
// tool that returns an error responds via `isError: true` with the
// spec's envelope in `structuredContent.error`, so a caller inspecting
// either the structured result or the text content gets the same shape.

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

export interface ToolErrorResult {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
}

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
