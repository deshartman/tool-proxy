import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

// Public, key-less US weather. Three-step now that we accept a city name:
//   1. geocode city -> {lat, lon} (keyless; see geocodeCity below)
//   2. /points/{lat},{lon} on weather.gov returns a forecast URL
//   3. GET that URL, return the next-period forecast text
// 1.5s budget per HTTP call: 3 sequential calls * 1.5s = 4.5s stays under
// the connector's default tool_timeout_ms of 5000.
const REQ_TIMEOUT_MS = 1500;
const USER_AGENT = "mcp-shim-sample (https://github.com/twilio/mcp-shim)";

async function fetchJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/geo+json,application/json" },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Geocode a city name to coordinates via Open-Meteo (keyless, no UA policy).
// Fetches the top 5 matches so ambiguous names (Springfield, Portland, ...)
// surface a disambiguation error instead of silently picking one.
// If the resolved location is outside the US, the weather.gov /points step
// downstream will fail — that's the country-mismatch signal.
async function geocodeCity(city: string): Promise<{ lat: number; lon: number }> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=5&language=en&format=json`;
  const res = await fetchJson(url) as {
    results?: Array<{ latitude: number; longitude: number; name: string; admin1?: string; country?: string }>;
  };
  const hits = res.results ?? [];
  if (hits.length === 0) throw new Error(`No location found for "${city}". Try including a state or country (e.g. "${city}, CA" or "${city}, France").`);
  if (hits.length > 1) {
    const labels = hits.map(h => [h.name, h.admin1, h.country].filter(Boolean).join(", "));
    throw new Error(`Multiple locations match "${city}": ${labels.join("; ")}. Re-ask with a state or country to disambiguate (e.g. "${labels[0]}").`);
  }
  return { lat: hits[0].latitude, lon: hits[0].longitude };
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
        title: "Sample Get US Weather Forecast",
        description: "US-only forecast via weather.gov. Geocodes the given city and returns the next-period forecast text.",
        inputSchema: {
          city: z.string().min(1).describe("US city name, optionally with state (e.g. 'Boulder' or 'Boulder, CO')."),
        },
        outputSchema: OutputSchema,
      },
      async ({ city }) => {
        const { lat, lon } = await geocodeCity(city);
        const points = await fetchJson(`https://api.weather.gov/points/${lat},${lon}`) as {
          properties?: { forecast?: string };
        };
        const forecastUrl = points?.properties?.forecast;
        if (!forecastUrl) throw new Error(`weather.gov returned no forecast URL for "${city}" (location may be outside the US)`);
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
