import { describe, it, expect, afterEach, vi } from "vitest";

import { getAppointment } from "../../../../../mcp/local/crm/tools/get-appointment.js";
import {
  captureRegistration,
  asZodObject,
  asToolResult,
} from "../../helpers/register-tool.js";

describe("crm.get_appointment handler", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns structuredContent matching outputSchema on success", async () => {
    const reg = captureRegistration(getAppointment);
    expect(reg.outputSchema).toBeDefined();

    const appointment = {
      appointmentId: "apt_xyz999",
      customerPhone: "+15551239999",
      customerName: "Ada",
      agentName: "Sam Reyes",
      start: "2026-06-22T14:00:00.000Z",
      end: "2026-06-22T15:00:00.000Z",
      status: "scheduled",
    };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(appointment), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof globalThis.fetch;

    const result = asToolResult(await reg.handler({ phone: "+15551239999" }));
    expect(result.structuredContent).toEqual(appointment);
    const schema = asZodObject(reg.outputSchema);
    expect(() => schema.parse(result.structuredContent)).not.toThrow();
  });

  it("does NOT set structuredContent on no_appointment", async () => {
    const reg = captureRegistration(getAppointment);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "no_appointment" }), { status: 404 }),
    ) as typeof globalThis.fetch;

    const result = asToolResult(await reg.handler({ phone: "+15550001111" }));
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain("no_appointment");
  });
});
