import { describe, it, expect } from "vitest";
import { formatHandshakeFailure } from "../../src/tunnel/format-log.js";

// Pins the regression observed 2026-07-20: recoverable tunnel handshake
// failures (WS 502 during controller restart, dial timeout, ECONNREFUSED,
// DNS blips) were producing 10-line pino stack traces in the operator log
// even though the very next line scheduled an auto-reconnect. The fix
// routed the log payload through this helper so pino's `err`-named-field
// serializer is not triggered.
//
// The regression is subtle to reintroduce: a "helpful" refactor that
// changes `formatHandshakeFailure(error, url)` back to `{ err: error }`
// looks fine at the call site but resurrects the full stack in the log.
// The "no `err` field" test below is the guard.

const URL = "https://controller.example.com";

describe("formatHandshakeFailure", () => {
  it("extracts the message from an Error and pairs it with the url", () => {
    const err = new Error("Tunnel rejected with status 502");
    const payload = formatHandshakeFailure(err, URL);
    expect(payload).toEqual({
      reason: "Tunnel rejected with status 502",
      url: URL,
    });
  });

  it("handles the dial-timeout wording produced by TunnelClient", () => {
    const err = new Error("Tunnel dial timed out after 10000ms");
    const payload = formatHandshakeFailure(err, URL);
    expect(payload.reason).toBe("Tunnel dial timed out after 10000ms");
    expect(payload.url).toBe(URL);
  });

  it("coerces non-Error throws to a string reason", () => {
    expect(formatHandshakeFailure("boom", URL).reason).toBe("boom");
    expect(formatHandshakeFailure(42, URL).reason).toBe("42");
    expect(formatHandshakeFailure({ code: "ECONNREFUSED" }, URL).reason).toBe("[object Object]");
    expect(formatHandshakeFailure(undefined, URL).reason).toBe("undefined");
  });

  it("does NOT include a pino `err` field (the stack-serializer trigger)", () => {
    // Load-bearing: if a future refactor adds `err: error` to the payload,
    // pino's stdSerializers.err inlines the full stack and the noisy
    // multi-line output regresses. This assertion is the tripwire.
    const payload = formatHandshakeFailure(new Error("anything"), URL) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("err");
    // Also guard against a rename that surfaces the raw Error under a
    // different key — the whole payload should be plain-string fields.
    for (const value of Object.values(payload)) {
      expect(value instanceof Error).toBe(false);
    }
  });

  it("returns a plain object with exactly reason + url — no incidental fields", () => {
    const payload = formatHandshakeFailure(new Error("x"), URL);
    expect(Object.keys(payload).sort()).toEqual(["reason", "url"]);
  });
});
