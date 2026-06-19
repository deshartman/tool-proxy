import { describe, it, expect } from "vitest";

import { uuid } from "@mcp/local/sample/tools/uuid.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../helpers/register-tool.js";

describe("sample.uuid handler", () => {
  it("wraps the UUID in { value } and round-trips through outputSchema", async () => {
    const reg = captureRegistration(uuid);
    expect(reg.outputSchema).toBeDefined();

    const result = asToolResult(await reg.handler({}));
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      value: string;
    };
    // RFC 4122 v4 shape: 8-4-4-4-12 hex with version=4 / variant in {8,9,a,b}.
    expect(parsed.value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(result.content[0].text).toBe(parsed.value);
  });
});
