import { describe, it, expect } from "vitest";

import { now } from "@mcp/local/sample/tools/now.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../helpers/register-tool.js";

describe("sample.now handler", () => {
  it("wraps the timestamp in { value } and round-trips through outputSchema", async () => {
    const reg = captureRegistration(now);
    expect(reg.outputSchema).toBeDefined();

    const result = asToolResult(await reg.handler({}));
    expect(result.structuredContent).toBeDefined();

    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      value: string;
    };
    // ISO 8601 sanity — Date.parse must yield a finite instant.
    expect(Number.isFinite(Date.parse(parsed.value))).toBe(true);
    // content[0].text and structuredContent.value carry the same data.
    expect(result.content[0].text).toBe(parsed.value);
  });
});
