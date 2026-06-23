import { describe, it, expect, vi, beforeEach } from "vitest";

import type { WebhookEvent } from "@connector/sdk/webhook.js";

let capturedCallback: ((event: WebhookEvent) => void) | undefined;

vi.mock("@mcp-shim/connector/sdk", () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
  createWebhookEndpoint: vi.fn(async () => ({
    url: "https://controller.test/api/webhook/c1/t1",
    on: vi.fn((event: string, handler: (e: WebhookEvent) => void) => {
      if (event === "callback") capturedCallback = handler;
    }),
    off: vi.fn(),
    stop: vi.fn(async () => {}),
  })),
}));

function syntheticEvent(fields: Record<string, string>): WebhookEvent {
  return {
    body: fields,
    queryParameters: {},
    receivedAt: 1_700_000_000_000,
  };
}

async function freshModule() {
  vi.resetModules();
  capturedCallback = undefined;
  return import("@mcp/bundled/twilio/status-callback.js");
}

async function waitForCapture() {
  await vi.waitFor(() => expect(capturedCallback).toBeDefined(), { timeout: 200 });
}

describe("waitForStatus", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the status from the first matching SID event", async () => {
    const { waitForStatus } = await freshModule();
    const pending = waitForStatus("SMabc", { timeout: 1_000 });
    await waitForCapture();

    capturedCallback!(syntheticEvent({ MessageSid: "SMabc", MessageStatus: "delivered" }));

    await expect(pending).resolves.toBe("delivered");
  });

  it("ignores callbacks for unrelated SIDs", async () => {
    const { waitForStatus } = await freshModule();
    const pending = waitForStatus("SMabc", { timeout: 1_000 });
    await waitForCapture();

    capturedCallback!(syntheticEvent({ MessageSid: "SMother", MessageStatus: "delivered" }));
    capturedCallback!(syntheticEvent({ MessageSid: "SMabc", MessageStatus: "queued" }));

    await expect(pending).resolves.toBe("queued");
  });

  it("filters non-final statuses when `until` is provided", async () => {
    const { waitForStatus } = await freshModule();
    const pending = waitForStatus("SMabc", {
      timeout: 1_000,
      until: (s) => s === "delivered" || s === "failed",
    });
    await waitForCapture();

    capturedCallback!(syntheticEvent({ MessageSid: "SMabc", MessageStatus: "queued" }));
    capturedCallback!(syntheticEvent({ MessageSid: "SMabc", MessageStatus: "sent" }));
    capturedCallback!(syntheticEvent({ MessageSid: "SMabc", MessageStatus: "delivered" }));

    await expect(pending).resolves.toBe("delivered");
  });

  it("rejects with code='timeout' when no matching event arrives", async () => {
    vi.useFakeTimers();
    const { waitForStatus } = await freshModule();
    const pending = waitForStatus("SMabc", { timeout: 5_000 });
    await waitForCapture();

    vi.advanceTimersByTime(5_000);

    await expect(pending).rejects.toMatchObject({ code: "timeout" });
  });

  it("delivers the same event to concurrent awaiters of the same SID", async () => {
    const { waitForStatus } = await freshModule();
    const a = waitForStatus("SMabc", { timeout: 1_000 });
    const b = waitForStatus("SMabc", { timeout: 1_000, until: (s) => s === "delivered" });
    await waitForCapture();

    capturedCallback!(syntheticEvent({ MessageSid: "SMabc", MessageStatus: "queued" }));
    capturedCallback!(syntheticEvent({ MessageSid: "SMabc", MessageStatus: "delivered" }));

    await expect(a).resolves.toBe("queued");
    await expect(b).resolves.toBe("delivered");
  });
});
