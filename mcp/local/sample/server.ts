import { createMcpHttpServer } from "@mcp-shim/connector/sdk";
import { now } from "./tools/now.js";
import { uuid } from "./tools/uuid.js";
import { weather } from "./tools/weather.js";
import { slowEcho } from "./tools/slow-echo.js";
import { weatherBriefing } from "./prompts/weather-briefing.js";
import { uuidsRecent } from "./resources/uuids-recent.js";

await createMcpHttpServer({
  name: "sample-mcp-server",
  tools: [now, uuid, weather, slowEcho],
  prompts: [weatherBriefing],
  resources: [uuidsRecent],
});
