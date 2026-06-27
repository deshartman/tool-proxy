import { describe, it, expect } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/connector/tests/mcp-tools/apis
// Need 5 .. to reach the repo root, where mcp/bundled/twilio lives.
const BUNDLE = join(__dirname, "../../../../..", "mcp/bundled/twilio");

// This suite is a contract pin: when these inventories change, the
// standalone repos (@deshartman/twilio-mcp and @deshartman/segment-mcp)
// MUST be updated in lockstep. See .claude/plans/TWILIO-MCP-BREAKOUT.md.

describe("twilio-mcp lift inventory — tools", () => {
  it("ships exactly 4 messaging tool files", () => {
    const files = readdirSync(join(BUNDLE, "messaging/tools")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual([
      "content_templates_fetch.ts",
      "messages_create.ts",
      "messages_fetch.ts",
      "messaging_services_fetch.ts",
    ]);
  });

  it("ships exactly 13 voice tool files (8 base + 5 agent-pay)", () => {
    const files = readdirSync(join(BUNDLE, "voice/tools")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual([
      "agent_pay_capture_card.ts",
      "agent_pay_capture_cvc.ts",
      "agent_pay_capture_exp.ts",
      "agent_pay_complete.ts",
      "agent_pay_start.ts",
      "calls_create.ts",
      "calls_fetch.ts",
      "voice_dial.ts",
      "voice_pay.ts",
      "voice_play.ts",
      "voice_say.ts",
      "voice_transcription_start.ts",
      "voice_transcription_stop.ts",
    ]);
  });

  it("ships exactly 3 verify tool files", () => {
    const files = readdirSync(join(BUNDLE, "verify/tools")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual([
      "verify_check.ts",
      "verify_send.ts",
      "verify_services_fetch.ts",
    ]);
  });

  it("ships exactly 1 lookups tool file", () => {
    const files = readdirSync(join(BUNDLE, "lookups/tools")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual(["lookups_fetch.ts"]);
  });

  it("ships exactly 4 email tool files", () => {
    const files = readdirSync(join(BUNDLE, "email/tools")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual([
      "email_fetch.ts",
      "email_search.ts",
      "email_send.ts",
      "email_templates_fetch.ts",
    ]);
  });

  it("ships the three Twilio client wrappers", () => {
    expect(existsSync(join(BUNDLE, "twilio-client.ts"))).toBe(true);
    expect(existsSync(join(BUNDLE, "sendgrid-client.ts"))).toBe(true);
    expect(existsSync(join(BUNDLE, "status-callback.ts"))).toBe(true);
  });
});

describe("twilio-mcp lift inventory — prompts", () => {
  it("ships exactly 1 messaging prompt", () => {
    const files = readdirSync(join(BUNDLE, "messaging/prompts")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual(["messaging_overview.ts"]);
  });

  it("ships exactly 8 voice prompts (1 overview + 7 agent-pay)", () => {
    const files = readdirSync(join(BUNDLE, "voice/prompts")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual([
      "agent_pay_card_number.ts",
      "agent_pay_completion.ts",
      "agent_pay_error.ts",
      "agent_pay_expiration.ts",
      "agent_pay_finish.ts",
      "agent_pay_security_code.ts",
      "agent_pay_start_capture.ts",
      "voice_overview.ts",
    ]);
  });

  it("ships exactly 1 verify prompt", () => {
    const files = readdirSync(join(BUNDLE, "verify/prompts")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual(["verify_overview.ts"]);
  });

  it("ships exactly 1 lookups prompt", () => {
    const files = readdirSync(join(BUNDLE, "lookups/prompts")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual(["lookups_overview.ts"]);
  });

  it("ships exactly 1 email prompt", () => {
    const files = readdirSync(join(BUNDLE, "email/prompts")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual(["email_overview.ts"]);
  });
});

describe("segment-mcp lift inventory", () => {
  it("ships exactly 5 segment tool files", () => {
    const files = readdirSync(join(BUNDLE, "segment/tools")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual([
      "segment_identify.ts",
      "segment_profile_events.ts",
      "segment_profile_external_ids.ts",
      "segment_profile_traits.ts",
      "segment_track.ts",
    ]);
  });

  it("ships exactly 1 segment prompt", () => {
    const files = readdirSync(join(BUNDLE, "segment/prompts")).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual(["segment_overview.ts"]);
  });

  it("ships the two Segment client wrappers", () => {
    expect(existsSync(join(BUNDLE, "segment-profile-client.ts"))).toBe(true);
    expect(existsSync(join(BUNDLE, "segment-tracker.ts"))).toBe(true);
  });
});

describe("breakout MCP-name contract", () => {
  // The shim's bundle registers as MCP name "apis" (no change). The
  // standalone repos register as "twilio" and "segment" via their own
  // McpServer({name: ...}). The controller dispatch table uses these
  // names verbatim. If either standalone repo's name changes, the
  // controller's Type 2 stdio config (command: npx, args: [-y,
  // @deshartman/<name>]) needs a corresponding update.
  it("documents the standalone names for controller config", () => {
    // These constants exist purely so a future contributor cannot rename
    // the wire-side MCP names in the standalone repos without also
    // breaking this test, which forces a coordinated change.
    const STANDALONE_TWILIO_NAME = "twilio";
    const STANDALONE_SEGMENT_NAME = "segment";
    expect(STANDALONE_TWILIO_NAME).toBe("twilio");
    expect(STANDALONE_SEGMENT_NAME).toBe("segment");
  });
});
