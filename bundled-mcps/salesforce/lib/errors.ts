// Structured tool errors, mirroring bundled-mcps/agentic-memory/errors.ts's
// isError + JSON-in-text convention. Salesforce returns errors as an array
// of {message, errorCode, fields} regardless of status code — we preserve
// the full array in `details` rather than remapping onto an invented enum,
// since Salesforce's own errorCode strings (MALFORMED_QUERY, DUPLICATE_VALUE,
// REQUIRED_FIELD_MISSING, ...) are already descriptive.

export interface ToolErrorResult {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
}

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
