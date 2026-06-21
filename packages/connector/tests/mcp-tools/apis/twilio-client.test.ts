import { describe, it, expect } from "vitest";

import { createTwilioClient } from "@mcp/bundled/twilio/twilio-client.js";

// Pin the bundle's auth shape: AuthToken-only. The API-Key branch was
// removed (commit on 2026-06-21) to keep the bundle aligned with the
// controller's `creds-response` auto-fill — see CLAUDE.md
// "mcp/bundled/twilio" entry and docs/MCP-PROTOCOL.md "Twilio-bundled
// auto-fill". Reintroducing an apiKeySid/apiKeySecret branch here without
// updating the auto-fill table would create a silent name mismatch.

describe("twilio bundle createTwilioClient", () => {
  it("returns a client when both TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are set", () => {
    const client = createTwilioClient({
      TWILIO_ACCOUNT_SID: "ACtestaccountsidvaluefortest12345",
      TWILIO_AUTH_TOKEN: "test_auth_token_value",
    } as NodeJS.ProcessEnv);
    expect(client).toBeDefined();
    expect(client.messages).toBeDefined();
  });

  it("throws when TWILIO_ACCOUNT_SID is missing", () => {
    expect(() =>
      createTwilioClient({ TWILIO_AUTH_TOKEN: "test_auth_token" } as NodeJS.ProcessEnv),
    ).toThrow(/TWILIO_ACCOUNT_SID/);
  });

  it("throws when TWILIO_AUTH_TOKEN is missing", () => {
    expect(() =>
      createTwilioClient({
        TWILIO_ACCOUNT_SID: "ACtestaccountsidvaluefortest12345",
      } as NodeJS.ProcessEnv),
    ).toThrow(/TWILIO_AUTH_TOKEN/);
  });

  it("ignores TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET — bundle is AuthToken-only", () => {
    expect(() =>
      createTwilioClient({
        TWILIO_ACCOUNT_SID: "ACtestaccountsidvaluefortest12345",
        TWILIO_API_KEY_SID: "SKtestapikeysidvalue1234567890",
        TWILIO_API_KEY_SECRET: "test_api_key_secret_value",
      } as NodeJS.ProcessEnv),
    ).toThrow(/TWILIO_AUTH_TOKEN/);
  });
});
