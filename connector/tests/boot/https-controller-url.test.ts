import { describe, it, expect } from "vitest";
import { isHttpsControllerUrl } from "../../src/boot/require-env.js";

// C5 — refuse plaintext CONTROLLER_URL. Only https:// (or wss://) survives,
// except for loopback (127.0.0.1, ::1, localhost) which is allowed on any
// scheme so tests dialling a mock controller in-process work without
// TLS certs.

describe("isHttpsControllerUrl — C5 plaintext refusal", () => {
  const passing = [
    "https://controller.example.com",
    "https://controller.example.com/mcp-tunnel",
    "https://sub.domain.example.com:8443",
    "wss://controller.example.com",
    // Loopback allowed on any scheme
    "http://127.0.0.1:3001",
    "http://localhost:3001",
    "http://[::1]:3001",
    "ws://127.0.0.1:3001",
  ];

  const failing = [
    "http://controller.example.com",
    "http://controller.example.com/mcp-tunnel",
    "ws://controller.example.com",
    "http://192.168.1.10:3001",  // private IP is NOT loopback
    "not-a-url",
    "",
    "https://",  // no host
  ];

  for (const url of passing) {
    it(`accepts ${url}`, () => {
      expect(isHttpsControllerUrl(url)).toBe(true);
    });
  }

  for (const url of failing) {
    it(`refuses ${url}`, () => {
      expect(isHttpsControllerUrl(url)).toBe(false);
    });
  }
});
