import { z } from "zod";
import type { Tool } from "@mcp-shim/connector/sdk";

// Public, key-less Australian weather. Two-step now that we accept a city name:
//   1. geocode city -> {lat, lon} (Open-Meteo geocoding, AU-filtered)
//   2. Open-Meteo forecast API returns daily + current conditions for that
//      lat/lon; we surface today's summary.
// 2s budget per HTTP call: 2 sequential calls * 2s = 4s stays under the
// connector's default tool_timeout_ms of 5000.
const REQ_TIMEOUT_MS = 2000;
const USER_AGENT = "mcp-shim-sample (https://github.com/twilio/mcp-shim)";

async function fetchJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Geocode a city name to coordinates via Open-Meteo (keyless, no UA policy).
// Filters to Australia at the API layer — the downstream forecast is AU-only,
// so a non-AU query fails fast with a clear message instead of returning
// weather for a same-named city in another country.
async function geocodeCity(city: string): Promise<{ lat: number; lon: number; label: string }> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=5&language=en&format=json&country=AU`;
  const res = await fetchJson(url) as {
    results?: Array<{ latitude: number; longitude: number; name: string; admin1?: string; country_code?: string }>;
  };
  const hits = (res.results ?? []).filter(h => h.country_code === "AU");
  if (hits.length === 0) throw new Error(`No Australian location found for "${city}". Try including a state (e.g. "${city}, NSW"). Weather data is AU-only.`);
  const pick = hits[0];
  return { lat: pick.latitude, lon: pick.longitude, label: [pick.name, pick.admin1].filter(Boolean).join(", ") };
}

// Weather-code lookup for Open-Meteo's WMO codes. Only the common ones —
// unknown codes fall back to "code N".
const WMO_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Light rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Light snow",
  73: "Moderate snow",
  75: "Heavy snow",
  80: "Rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with heavy hail",
};

// Bucket A (JSON-shaped) per OUTPUT-SCHEMA.md — projection-friendly fields
// for today's forecast. The handler still returns a human-readable
// content[0].text for the LLM, but the structuredContent is the procedure-
// author target.
const OutputSchema = {
  location: z.string().describe("Resolved location label, e.g. 'Perth, Western Australia'."),
  summary: z.string().describe("Human-readable weather summary for today."),
  tempMinC: z.number().describe("Forecast minimum temperature in °C."),
  tempMaxC: z.number().describe("Forecast maximum temperature in °C."),
  precipitationMm: z.number().describe("Forecast total precipitation in mm."),
};

export const weather: Tool = {
  name: "weather",
  register(server) {
    server.registerTool(
      "weather",
      {
        title: "Sample Get AU Weather Forecast",
        description: "Australia-only forecast via Open-Meteo. Geocodes the given city and returns today's forecast summary.",
        inputSchema: {
          city: z.string().min(1).describe("Australian city name, optionally with state (e.g. 'Sydney' or 'Perth, WA')."),
        },
        outputSchema: OutputSchema,
      },
      async ({ city }) => {
        const { lat, lon, label } = await geocodeCity(city);
        const forecast = await fetchJson(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
          + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum`
          + `&timezone=Australia%2FSydney&forecast_days=1`,
        ) as {
          daily?: {
            weather_code?: number[];
            temperature_2m_max?: number[];
            temperature_2m_min?: number[];
            precipitation_sum?: number[];
          };
        };
        const daily = forecast?.daily;
        const code = daily?.weather_code?.[0];
        const tmax = daily?.temperature_2m_max?.[0];
        const tmin = daily?.temperature_2m_min?.[0];
        const precip = daily?.precipitation_sum?.[0];
        if (code === undefined || tmax === undefined || tmin === undefined || precip === undefined) {
          throw new Error(`Open-Meteo returned no daily forecast for "${label}"`);
        }
        const summary = WMO_CODES[code] ?? `code ${code}`;
        const data = {
          location: label,
          summary,
          tempMinC: tmin,
          tempMaxC: tmax,
          precipitationMm: precip,
        };
        return {
          structuredContent: data,
          content: [{
            type: "text",
            text: `${label}: ${summary}, ${tmin}–${tmax}°C, ${precip}mm precipitation.`,
          }],
        };
      },
    );
  },
};
