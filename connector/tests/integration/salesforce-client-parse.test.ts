import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";

// MCP-AUDIT #19 — sfFetch's JSON.parse was unguarded, so a non-JSON body threw a
// raw SyntaxError and surfaced as an opaque tool failure instead of the structured
// envelope every other path in this module produces. Realistic sources: a proxy's
// HTML error page, a WAF block, a maintenance interstitial.

const SF = resolve(__dirname, "../../..", "examples/demos/salesforce");

let sfFetch: (path: string, init?: RequestInit) => Promise<{ status: number; ok: boolean; body: unknown }>;

const TOKEN_BODY = { access_token: "tok", instance_url: "https://example.my.salesforce.com" };

// Route the token request to a canned response and the data request to `impl`.
function stubFetch(impl: (url: string) => { status: number; text: string }): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/services/oauth2/token")) {
      return { ok: true, status: 200, json: async () => TOKEN_BODY } as unknown as Response;
    }
    const { status, text } = impl(u);
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => text,
      json: async () => JSON.parse(text),
    } as unknown as Response;
  }));
}

beforeEach(async () => {
  vi.resetModules();
  process.env.SF_CLIENT_ID = "id";
  process.env.SF_CLIENT_SECRET = "secret";
  const mod = await import(`${SF}/lib/client.ts?v=${Date.now()}`);
  sfFetch = mod.sfFetch;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SF_CLIENT_ID;
  delete process.env.SF_CLIENT_SECRET;
});

describe("MCP-AUDIT #19 — a non-JSON upstream body does not throw", () => {
  it("returns the raw text instead of a SyntaxError for an HTML error page", async () => {
    const html = "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>";
    stubFetch(() => ({ status: 502, text: html }));

    const r = await sfFetch("/sobjects/Contact/003");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    expect((r.body as { raw: string }).raw).toContain("502 Bad Gateway");
  });

  it("truncates a very large non-JSON body — it reaches the model as tool output", async () => {
    stubFetch(() => ({ status: 503, text: "x".repeat(50_000) }));
    const r = await sfFetch("/query?q=SELECT+Id+FROM+Contact");
    const raw = (r.body as { raw: string }).raw;
    expect(raw.length).toBeLessThan(2100);
    expect(raw).toContain("truncated");
  });

  it("still parses a normal JSON body", async () => {
    stubFetch(() => ({ status: 200, text: JSON.stringify({ records: [{ Id: "003" }], totalSize: 1, done: true }) }));
    const r = await sfFetch("/query?q=SELECT+Id+FROM+Contact");
    expect(r.ok).toBe(true);
    expect((r.body as { totalSize: number }).totalSize).toBe(1);
  });

  it("still parses Salesforce's array-shaped error body", async () => {
    // salesforceError depends on this shape surviving.
    const errs = [{ message: "Required field missing", errorCode: "REQUIRED_FIELD_MISSING", fields: ["LastName"] }];
    stubFetch(() => ({ status: 400, text: JSON.stringify(errs) }));
    const r = await sfFetch("/sobjects/Contact", { method: "POST", body: "{}" });
    expect(Array.isArray(r.body)).toBe(true);
    expect((r.body as Array<{ errorCode: string }>)[0].errorCode).toBe("REQUIRED_FIELD_MISSING");
  });

  it("still returns undefined body for 204 No Content (the DELETE path)", async () => {
    stubFetch(() => ({ status: 204, text: "" }));
    const r = await sfFetch("/sobjects/Contact/003", { method: "DELETE" });
    expect(r.ok).toBe(true);
    expect(r.body).toBeUndefined();
  });

  it("treats an empty 200 body as undefined rather than throwing", async () => {
    stubFetch(() => ({ status: 200, text: "" }));
    const r = await sfFetch("/sobjects/Contact/003");
    expect(r.body).toBeUndefined();
  });
});
