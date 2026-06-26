import { describe, it, expect, vi } from "vitest";

// Stub the connector SDK so getDefaultStatusCallback doesn't try to bind
// the inspector loopback. The tool's only SDK touchpoint is the singleton
// webhook endpoint factory; everything else is the twilio client.
vi.mock("@mcp-shim/connector/sdk", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  createWebhookEndpoint: vi.fn(async () => ({
    url: "https://controller.test/api/webhook/c1/t1",
    on: vi.fn(),
    off: vi.fn(),
    stop: vi.fn(async () => {}),
  })),
}));

import { agentPayStart } from "@mcp/bundled/twilio/voice/tools/agent_pay_start.js";
import type { TwilioClient } from "@mcp/bundled/twilio/twilio-client.js";
import { captureRegistration, asZodObject, asToolResult } from "../../../helpers/register-tool.js";

// Mirror Twilio's chained API: client.calls(callSid).payments.create({...})
function fakeClient(): { client: TwilioClient; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue({ sid: "PKxyz" });
  const client = {
    calls: (callSid: string) => ({
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _callSid: callSid,
      payments: { create },
    }),
  } as unknown as TwilioClient;
  return { client, create };
}

describe("apis.agent_pay_start handler", () => {
  it("creates a Payments session with an allocated statusCallback and returns { paymentSid, callSid, status }", async () => {
    const { client, create } = fakeClient();
    const reg = captureRegistration(agentPayStart(client));
    const result = asToolResult(
      await reg.handler({
        callSid: "CAabc",
        chargeAmount: 10,
        currency: "USD",
        paymentConnector: "Stripe_Default",
      }),
    );

    const parsed = asZodObject(reg.outputSchema).parse(result.structuredContent) as {
      paymentSid: string;
      callSid: string;
      status: string;
    };
    expect(parsed.paymentSid).toBe("PKxyz");
    expect(parsed.callSid).toBe("CAabc");
    expect(parsed.status).toBe("in-progress");

    // Twilio require both idempotencyKey and statusCallback on every call —
    // pin that the tool builds them.
    expect(create).toHaveBeenCalledTimes(1);
    const [opts] = create.mock.calls[0];
    expect(opts.statusCallback).toBe("https://controller.test/api/webhook/c1/t1");
    expect(typeof opts.idempotencyKey).toBe("string");
    expect(opts.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(opts.chargeAmount).toBe(10);
    expect(opts.currency).toBe("USD");
    expect(opts.paymentConnector).toBe("Stripe_Default");
  });
});
