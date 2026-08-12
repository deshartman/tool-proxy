// Structured tool errors, mirroring bundled-mcps/agentic-memory/errors.ts's
// isError + JSON-in-text convention. Salesforce returns errors as an array
// of {message, errorCode, fields} regardless of status code — we preserve
// the full array in `details` rather than remapping onto an invented enum,
// since Salesforce's own errorCode strings (MALFORMED_QUERY, DUPLICATE_VALUE,
// REQUIRED_FIELD_MISSING, ...) are already descriptive.

import type { CallToolResult } from "@modelcontextprotocol/server";

// Must stay typed against the SDK's own result type. A hand-rolled `interface
// { isError: true; content: [...] }` lacks the index signature `registerTool`'s
// handler-return type requires, and TS doesn't extend fresh-object-literal
// leniency to a named interface — so it fails assignability at every call site
// (TS2769). `import type` is erased: no runtime dep. Intersection keeps narrowing.
export type ToolErrorResult = CallToolResult & { isError: true };

interface SalesforceApiError {
  message: string;
  errorCode: string;
  fields?: string[];
}

export function salesforceError(status: number, body: unknown): ToolErrorResult {
  const errors: SalesforceApiError[] = Array.isArray(body)
    ? (body as SalesforceApiError[])
    : [{ message: typeof body === "string" ? body : JSON.stringify(body), errorCode: "UNKNOWN" }];
  const [first] = errors;
  const payload = {
    error: {
      code: first?.errorCode ?? "UNKNOWN",
      message: first?.message ?? `Salesforce API returned ${status}`,
      status,
      details: errors,
    },
  };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
}
