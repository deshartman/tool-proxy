# aviation-weather-mcp (Type 2 example)

A Type 2 MCP integration: the connector dials an **already-built MCP server**
rather than running customer-authored tool code. There is no `server.ts`,
no `tools/`, no SDK import — just config.

The server itself is the published [`aviation-weather-mcp`](https://www.npmjs.com/package/aviation-weather-mcp)
package. The connector spawns it via stdio (`npx -y aviation-weather-mcp`)
and forwards the MCP frames over the tunnel.

## Tools exposed

- `wx_metar` — latest METAR for an ICAO airport
- `wx_taf` — Terminal Area Forecast
- `wx_pireps` — recent pilot reports near an airport
- `wx_sigmets` — active SIGMETs/AIRMETs
- `wx_icon_d2` — DWD ICON-D2 NWP forecast (lat/lon)
- `wx_outlook` — 3–15 day VFR confidence outlook
- `wx_preflight` — single-airfield VFR brief (METAR + TAF + ICON-D2)
- `wx_route` — direct-route brief between two airports

No API key required. The bundled airport database covers ~22k fields.

## Config

The connector entry is in [`packages/connector/connector.yaml`](../../packages/connector/connector.yaml):

```yaml
- name: aviation-weather
  transport: stdio
  command: [npx, "--yes", aviation-weather-mcp]
  dir: ./examples/aviation-weather-mcp
```

`dir:` points the connector at this folder so per-folder `.env` (if any)
gets loaded into the child process. This server needs nothing from .env;
the file is here as the Type 2 template for servers that *do* need creds.
