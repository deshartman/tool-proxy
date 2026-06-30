import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

// Public, key-less US weather API. Two-step: /points/{lat},{lon} returns a
// forecast URL; we GET that and return the next-period forecast text.
// 4s budget per HTTP call so this stays well under the connector's default
// tool_timeout_ms of 5000.
const REQ_TIMEOUT_MS = 4000;
const USER_AGENT = "mcp-shim-sample (https://github.com/twilio/mcp-shim)";

async function fetchJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/geo+json,application/json" },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`weather.gov ${url} -> ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Bucket A (JSON-shaped) per OUTPUT-SCHEMA.md — projection-friendly fields
// for the next forecast period. The handler still returns a human-readable
// content[0].text for the LLM, but the structuredContent is the procedure-
// author target.
const OutputSchema = {
  periodName: z.string().describe("Forecast period name (e.g. 'Tonight', 'Tuesday')."),
  detailedForecast: z.string().describe("Free-text forecast for that period."),
};

export const weather: Tool = {
  name: "weather",
  register(server) {
    server.registerTool(
      "weather",
      {
        title: "Check Weather",
        description: "US-only forecast via weather.gov. Returns the next-period forecast text for the given lat/lon.",
        inputSchema: {
          lat: z.number().min(-90).max(90),
          lon: z.number().min(-180).max(180),
        },
        outputSchema: OutputSchema,
      },
      async ({ lat, lon }) => {
        const points = await fetchJson(`https://api.weather.gov/points/${lat},${lon}`) as {
          properties?: { forecast?: string };
        };
        const forecastUrl = points?.properties?.forecast;
        if (!forecastUrl) throw new Error("weather.gov returned no forecast URL (location may be outside the US)");
        const forecast = await fetchJson(forecastUrl) as {
          properties?: { periods?: Array<{ name: string; detailedForecast: string }> };
        };
        const next = forecast?.properties?.periods?.[0];
        if (!next) throw new Error("weather.gov returned no forecast periods");
        const data = { periodName: next.name, detailedForecast: next.detailedForecast };
        return {
          structuredContent: data,
          content: [{ type: "text", text: `${next.name}: ${next.detailedForecast}` }],
        };
      },
    );
  },
};
