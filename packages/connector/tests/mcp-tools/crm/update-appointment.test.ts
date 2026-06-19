import { describe, it, expect, afterEach, vi } from "vitest";

import { updateAppointment } from "../../../../../mcp/local/crm/tools/update-appointment.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../helpers/register-tool.js";

// update_appointment branches on res.ok — 200 carries the success
// Appointment shape (structuredContent populated); 409 carries an error
// envelope (content[] only). The res.ok gate is the regression to pin:
// without it the SDK would try to validate the error envelope against
// the success schema and the procedure would see a schema-rejection.

describe("crm.update_appointment handler", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns structuredContent matching outputSchema on the 200 success path", async () => {
    const reg = captureRegistration(updateAppointment);
    expect(reg.outputSchema).toBeDefined();

    const updated = {
      appointmentId: "apt_xyz999",
      customerPhone: "+15551239999",
      customerName: "Ada",
      agentName: "Sam Reyes",
      start: "2026-06-23T10:00:00.000Z",
      end: "2026-06-23T11:00:00.000Z",
      status: "rescheduled",
      rescheduledAt: "2026-06-19T11:00:00.000Z",
      rescheduledFrom: "2026-06-22T14:00:00.000Z",
    };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(updated), { status: 200 }),
    ) as typeof globalThis.fetch;

    const result = asToolResult(
      await reg.handler({
        appointmentId: updated.appointmentId,
        newStart: updated.start,
      }),
    );
    expect(result.structuredContent).toEqual(updated);
    const schema = asZodObject(reg.outputSchema);
    expect(() => schema.parse(result.structuredContent)).not.toThrow();
  });

  it("does NOT set structuredContent on 409 slot_taken", async () => {
    const reg = captureRegistration(updateAppointment);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "slot_taken" }), { status: 409 }),
    ) as typeof globalThis.fetch;

    const result = asToolResult(
      await reg.handler({
        appointmentId: "apt_xyz999",
        newStart: "2026-06-23T10:00:00.000Z",
      }),
    );
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain("slot_taken");
  });
});
