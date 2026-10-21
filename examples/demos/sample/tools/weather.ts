import { z } from "zod";
import type { Tool } from "@gtmi/toolproxy-connector/sdk";

// Public, key-less Australian weather. Two-step now that we accept a city name:
//   1. geocode city -> {lat, lon} (Open-Meteo geocoding, AU-filtered)
//   2. Norwegian Met Institute (api.met.no) hourly forecast — we roll up
//      today's entries (Sydney-local) into min/max/precip/summary. Switched
//      from Open-Meteo's api.open-meteo.com after a 2026-07 outage on that
//      host; met.no is public-sector infra with SLAs.
// 3s budget per HTTP call: 2 sequential * 3s = 6s under a raised tool
// budget (met.no often responds in <1s; the ceiling is only for stalls).
const REQ_TIMEOUT_MS = 3000;
const USER_AGENT = "tool-proxy-sample (https://github.com/deshartman/tool-proxy)";

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

// met.no symbol_code -> human-readable summary. Codes come with _day / _night
// / _polartwilight suffixes that we strip at the lookup site, so this table
// keys off the bare stem. Unknown stems fall back to the raw code.
const SYMBOL_SUMMARIES: Record<string, string> = {
  clearsky: "Clear sky",
  fair: "Fair",
  partlycloudy: "Partly cloudy",
  cloudy: "Cloudy",
  fog: "Fog",
  lightrain: "Light rain",
  rain: "Rain",
  heavyrain: "Heavy rain",
  lightrainshowers: "Light rain showers",
  rainshowers: "Rain showers",
  heavyrainshowers: "Heavy rain showers",
  lightsleet: "Light sleet",
  sleet: "Sleet",
  heavysleet: "Heavy sleet",
  lightsnow: "Light snow",
  snow: "Snow",
  heavysnow: "Heavy snow",
  lightsnowshowers: "Light snow showers",
  snowshowers: "Snow showers",
  heavysnowshowers: "Heavy snow showers",
  lightrainandthunder: "Light rain and thunder",
  rainandthunder: "Rain and thunder",
  heavyrainandthunder: "Heavy rain and thunder",
};

function summariseSymbol(code: string): string {
  // Strip _day / _night / _polartwilight suffix.
  const stem = code.replace(/_(day|night|polartwilight)$/, "");
  return SYMBOL_SUMMARIES[stem] ?? code;
}

// Sydney-local calendar date for a UTC ISO timestamp. AEST is UTC+10 with
// no DST (state-wide half the year — Perth is +8, Sydney +10/+11). For a
// demo tool one fixed offset (+10) is close enough; a production tool would
// use Intl.DateTimeFormat with the resolved location's tz.
function sydneyDate(isoUtc: string): string {
  const t = new Date(isoUtc).getTime() + 10 * 3600 * 1000;
  return new Date(t).toISOString().slice(0, 10); // YYYY-MM-DD
}

interface MetNoTimeseriesEntry {
  time: string;
  data: {
    instant: { details: { air_temperature?: number } };
    next_1_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } };
    next_6_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } };
  };
}

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
          `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`,
        ) as { properties?: { timeseries?: MetNoTimeseriesEntry[] } };

        const series = forecast?.properties?.timeseries ?? [];
        if (series.length === 0) {
          throw new Error(`met.no returned no timeseries for "${label}"`);
        }
        // Roll up today's Sydney-local hours: min/max instant.air_temperature,
        // sum of next_1_hours.details.precipitation_amount. Symbol comes from
        // the first entry that has a next_6_hours summary today.
        const today = sydneyDate(series[0].time);
        const todaysEntries = series.filter((e) => sydneyDate(e.time) === today);
        if (todaysEntries.length === 0) {
          throw new Error(`met.no returned no entries for today (${today}) at "${label}"`);
        }
        const temps = todaysEntries
          .map((e) => e.data.instant.details.air_temperature)
          .filter((t): t is number => typeof t === "number");
        const precip = todaysEntries
          .map((e) => e.data.next_1_hours?.details?.precipitation_amount ?? 0)
          .reduce((a, b) => a + b, 0);
        const symbolCode =
          todaysEntries.find((e) => e.data.next_6_hours?.summary?.symbol_code)?.data.next_6_hours
            ?.summary?.symbol_code
          ?? todaysEntries[0].data.next_1_hours?.summary?.symbol_code
          ?? "unknown";
        if (temps.length === 0) {
          throw new Error(`met.no returned no temperature readings for today at "${label}"`);
        }
        const tmin = Math.min(...temps);
        const tmax = Math.max(...temps);
        const summary = summariseSymbol(symbolCode);
        const data = {
          location: label,
          summary,
          tempMinC: Number(tmin.toFixed(1)),
          tempMaxC: Number(tmax.toFixed(1)),
          precipitationMm: Number(precip.toFixed(1)),
        };
        return {
          structuredContent: data,
          content: [{
            type: "text",
            text: `${label}: ${summary}, ${data.tempMinC}–${data.tempMaxC}°C, ${data.precipitationMm}mm precipitation.`,
          }],
        };
      },
    );
  },
};
