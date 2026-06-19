import { describe, it, expect, afterEach, vi } from "vitest";

import { weather } from "../../../../../mcp/local/sample/tools/weather.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../helpers/register-tool.js";

// Mock fetch for both legs of weather.gov's two-step lookup:
//   1. /points/{lat},{lon}  → { properties: { forecast: <url> } }
//   2. <forecast url>        → { properties: { periods: [<period>, ...] } }

describe("sample.weather handler", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns { periodName, detailedForecast } matching outputSchema", async () => {
    const reg = captureRegistration(weather);
    expect(reg.outputSchema).toBeDefined();

    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({ properties: { forecast: "https://api.weather.gov/forecast/abc" } }),
          { status: 200, headers: { "content-type": "application/geo+json" } },
        );
      }
      return new Response(
        JSON.stringify({
          properties: {
            periods: [
              {
                name: "Tonight",
                detailedForecast: "Clear, with a low around 50.",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/geo+json" } },
      );
    }) as typeof globalThis.fetch;

    const result = asToolResult(await reg.handler({ lat: 37.7749, lon: -122.4194 }));
    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      periodName: string;
      detailedForecast: string;
    };
    expect(parsed.periodName).toBe("Tonight");
    expect(parsed.detailedForecast).toBe("Clear, with a low around 50.");
    // content[0].text is a "<name>: <forecast>" join — keep that for the LLM.
    expect(result.content[0].text).toBe("Tonight: Clear, with a low around 50.");
  });
});
