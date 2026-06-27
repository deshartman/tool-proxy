import { describe, it, expect, vi } from "vitest";

vi.mock("@mcp-shim/connector/sdk", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  createWebhookEndpoint: vi.fn(async () => ({
    url: "https://controller.test/api/webhook/c1/t1",
    on: vi.fn(),
    off: vi.fn(),
    stop: vi.fn(async () => {}),
  })),
}));

import { agentPayComplete } from "@mcp/bundled/twilio/voice/tools/agent_pay_complete.js";
import type { TwilioClient } from "@mcp/bundled/twilio/twilio-client.js";
import { captureRegistration, asZodObject, asToolResult } from "../../../helpers/register-tool.js";

function fakeClient(): { client: TwilioClient; update: ReturnType<typeof vi.fn> } {
  const update = vi.fn().mockResolvedValue({ sid: "PKxyz" });
  const client = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    calls: (_callSid: string) => ({
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      payments: (_paymentSid: string) => ({ update }),
    }),
  } as unknown as TwilioClient;
  return { client, update };
}

describe("apis.agent_pay_complete handler", () => {
  it("calls update with status='complete' and returns matching outputSchema", async () => {
    const { client, update } = fakeClient();
    const reg = captureRegistration(agentPayComplete(client));
    const result = asToolResult(await reg.handler({ callSid: "CAabc", paymentSid: "PKxyz" }));

    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      paymentSid: string;
      status: string;
    };
    expect(parsed.paymentSid).toBe("PKxyz");
    expect(parsed.status).toBe("complete");

    expect(update).toHaveBeenCalledTimes(1);
    const [opts] = update.mock.calls[0];
    expect(opts.status).toBe("complete");
    expect(opts.statusCallback).toBe("https://controller.test/api/webhook/c1/t1");
    expect(opts.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });
});
