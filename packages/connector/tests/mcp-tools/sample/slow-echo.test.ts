import { describe, it, expect } from "vitest";

import { slowEcho } from "@mcp/local/sample/tools/slow-echo.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../helpers/register-tool.js";

describe("sample.slow_echo handler", () => {
  it("returns { message, elapsedMs } matching outputSchema (with sleep_ms=0)", async () => {
    const reg = captureRegistration(slowEcho);
    expect(reg.outputSchema).toBeDefined();

    const result = asToolResult(
      // sleep_ms=0 keeps the test fast; the default of 6000 would be slower
      // than the connector's tool_timeout_ms anyway (that's the whole point
      // of this tool — testing timeout).
      await reg.handler({ text: "hello", sleep_ms: 0 }),
    );
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      message: string;
      elapsedMs: number;
    };
    expect(parsed.message).toBe("hello");
    expect(parsed.elapsedMs).toBe(0);
    expect(result.content[0].text).toBe("hello");
  });
});
