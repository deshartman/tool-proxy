import { describe, it, expect } from "vitest";

import { notifyAgent } from "../../../../../mcp/local/crm/tools/notify-agent.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../helpers/register-tool.js";

// notify_agent has no failure path (pure mock dispatcher) — every call
// returns structuredContent. Pin that so a future "make it fail-fast on
// empty message" change doesn't silently drop structuredContent.

describe("crm.notify_agent handler", () => {
  it("returns structuredContent that round-trips through outputSchema", async () => {
    const reg = captureRegistration(notifyAgent);
    expect(reg.outputSchema).toBeDefined();

    const result = asToolResult(
      await reg.handler({
        appointmentId: "apt_abc123",
        message: "Reschedule: Ada moved from 14:00 to 15:00.",
      }),
    );

    expect(result.structuredContent).toBeDefined();
    const schema = asZodObject(reg.outputSchema);
    const parsed = schema.parse(result.structuredContent) as {
      notificationId: string;
      appointmentId: string;
      message: string;
      deliveredAt: string;
    };
    expect(parsed.notificationId).toMatch(/^ntf_/);
    expect(parsed.appointmentId).toBe("apt_abc123");
    expect(parsed.message).toContain("Reschedule");
    // ISO 8601 — confirm Date.parse() lands on a real instant.
    expect(Number.isFinite(Date.parse(parsed.deliveredAt))).toBe(true);
  });
});
