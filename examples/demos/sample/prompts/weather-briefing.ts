import { z } from "zod";
import type { Prompt } from "@mcp-shim/connector/sdk";

// Worked example for the v1.2 SDK Prompt surface — combines the `weather`
// and `now` tools into one parameterised briefing template. Customer
// authors copy this shape into their own MCPs to ship versioned, opinionated
// prompts the controller's procedure UI picks up.
//
// Authors register prompts the same way they register tools: one module per
// prompt, exported as a `Prompt` object, with a `register(server)` that
// calls the SDK's `registerPrompt`. Args use zod schemas for validation +
// auto-generated descriptions in `prompts/list`.
export const weatherBriefing: Prompt = {
  name: "weather_briefing",
  register(server) {
    server.registerPrompt(
      "weather_briefing",
      {
        description: "Compose a short weather briefing for an Australian location, framing the latest forecast against the current time.",
        argsSchema: {
          location: z.string().describe("Australian city name, optionally with state to disambiguate (e.g. \"Sydney\" or \"Perth, WA\"). Weather data is AU-only."),
        },
      },
      ({ location }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Use the sample-mcp-server.weather tool to fetch the forecast for "${location}". `
                + `The tool takes an Australian city name; if it returns "No Australian location found", `
                + `ask the user which state they meant (e.g. "Perth, WA" vs "Perth, TAS") and retry. `
                + `Use sample-mcp-server.now to anchor the result to the current server time. `
                + `Compose a one-paragraph briefing (no bullet list) that calls out the temperature trend `
                + `and any precipitation in the next 24 hours.`,
            },
          },
        ],
      }),
    );
  },
};
