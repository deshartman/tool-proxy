import { describe, it, expect } from "vitest";
import { parseFrame } from "../src/parse.js";
import { parseVersion, isCompatible, PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION } from "../src/version.js";
import { isSupportedPeer, SUPPORTED_MAJORS } from "../src/parse.js";

// The version-aware parsing rule (shim plan §2.3): strict at the same minor,
// strip unknowns from a newer minor of the same major. And the property that
// matters most for safety: an error never carries a field VALUE, because frames
// carry credentials and tool arguments.

const self = { major: 1, minor: 0 };
const newer = { major: 1, minor: 3 };

const manifest = {
  connectorId: "",
  environment: "dev",
  version: "dev",
  servers: [
    {
      name: "crm",
      transport: "http",
      author: "customer",
      tools: [{ name: "get", description: "d", inputSchema: { type: "object", anything: true }, allowed: true }],
    },
  ],
};

describe("parseFrame — strict at the same minor", () => {
  it("accepts a well-formed frame", () => {
    const r = parseFrame("connector-to-controller", JSON.stringify({ type: "register", manifest, name: "x" }), { self });
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown TOP-LEVEL field", () => {
    const r = parseFrame("connector-to-controller", JSON.stringify({ type: "heartbeat", ts: 1, extra: 1 }), { self });
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown field NESTED deep in the manifest (drift hides there too)", () => {
    const deep = structuredClone(manifest);
    (deep.servers[0].tools[0] as Record<string, unknown>).typo = true;
    const r = parseFrame("connector-to-controller", JSON.stringify({ type: "register", manifest: deep }), { self });
    expect(r.ok).toBe(false);
    if (!r.ok && !r.ignored) expect(r.issues.join(" ")).toMatch(/servers\.0\.tools\.0/);
  });

  it("leaves opaque fields alone (a tool's JSON Schema is not ours to police)", () => {
    // inputSchema carries arbitrary keys — must still parse strictly elsewhere.
    const r = parseFrame("connector-to-controller", JSON.stringify({ type: "register", manifest }), { self });
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown frame type", () => {
    const r = parseFrame("controller-to-connector", JSON.stringify({ type: "brand-new-frame" }), { self });
    expect(r).toMatchObject({ ok: false, type: "brand-new-frame" });
    expect((r as { ignored?: boolean }).ignored).toBeFalsy();
  });

  it("rejects a frame sent in the wrong direction", () => {
    // creds-response is controller → connector only.
    const r = parseFrame("connector-to-controller", JSON.stringify({ type: "creds-response", requestId: "r" }), { self });
    expect(r.ok).toBe(false);
  });

  it("rejects a missing required field and an out-of-enum value", () => {
    expect(parseFrame("controller-to-connector", JSON.stringify({ type: "mcp-config-resync" }), { self }).ok).toBe(false);
    const badStatus = { type: "mcp-enable-ack", mcp: "crm", status: "maybe" };
    expect(parseFrame("connector-to-controller", JSON.stringify(badStatus), { self }).ok).toBe(false);
  });

  it("treats an absent peer version as strict (unknown peer is not a free pass)", () => {
    expect(parseFrame("connector-to-controller", JSON.stringify({ type: "heartbeat", ts: 1, extra: 1 })).ok).toBe(false);
  });
});

describe("parseFrame — tolerant from a newer minor", () => {
  it("strips an unknown field instead of rejecting", () => {
    const r = parseFrame("connector-to-controller", JSON.stringify({ type: "heartbeat", ts: 1, future: "x" }), { self, peer: newer });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.frame).toEqual({ type: "heartbeat", ts: 1 });
  });

  it("strips unknown NESTED fields too", () => {
    const deep = structuredClone(manifest);
    (deep.servers[0] as Record<string, unknown>).futureField = 1;
    const r = parseFrame("connector-to-controller", JSON.stringify({ type: "register", manifest: deep }), { self, peer: newer });
    expect(r.ok).toBe(true);
    if (r.ok && r.frame.type === "register") expect("futureField" in r.frame.manifest.servers[0]).toBe(false);
  });

  it("ignores (does not error on) an unknown frame type", () => {
    const r = parseFrame("controller-to-connector", JSON.stringify({ type: "brand-new-frame" }), { self, peer: newer });
    expect(r).toEqual({ ok: false, ignored: true, type: "brand-new-frame" });
  });

  it("still rejects a frame whose KNOWN fields are wrong", () => {
    const r = parseFrame("connector-to-controller", JSON.stringify({ type: "heartbeat", ts: "soon" }), { self, peer: newer });
    expect(r.ok).toBe(false);
  });

  it("is NOT tolerant toward an OLDER minor", () => {
    const r = parseFrame("connector-to-controller", JSON.stringify({ type: "heartbeat", ts: 1, extra: 1 }), {
      self: { major: 1, minor: 3 },
      peer: { major: 1, minor: 0 },
    });
    expect(r.ok).toBe(false);
  });
});

describe("parseFrame — never leaks values", () => {
  it("a malformed creds-response reports paths, not the secret", () => {
    const secret = "sk_live_DO_NOT_LEAK_123";
    const frame = { type: "creds-response", requestId: "r", env: { API_KEY: secret }, source: "bogus" };
    const r = parseFrame("controller-to-connector", JSON.stringify(frame), { self });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(secret);
    if (!r.ok && !r.ignored) expect(r.issues.join(" ")).toMatch(/source/);
  });

  it("garbage input never throws", () => {
    for (const text of ["", "not json", "null", "42", "[]", '{"type":7}', '{"no":"type"}']) {
      expect(() => parseFrame("controller-to-connector", text)).not.toThrow();
      expect(parseFrame("controller-to-connector", text).ok).toBe(false);
    }
  });
});

describe("mcp-discovered — the gated-everything contract", () => {
  const base = { type: "mcp-discovered", mcp: "sample", author: "twilio", envKeys: [], tools: [], discoveredAt: "x" };

  it.each(["bundled", "dropin", "yaml", "local"])("accepts source %s (local = legacy synonym for dropin)", (source) => {
    expect(parseFrame("connector-to-controller", JSON.stringify({ ...base, source }), { self }).ok).toBe(true);
  });

  it("accepts kind: example and rejects any other kind", () => {
    expect(parseFrame("connector-to-controller", JSON.stringify({ ...base, source: "bundled", kind: "example" }), { self }).ok).toBe(true);
    expect(parseFrame("connector-to-controller", JSON.stringify({ ...base, source: "bundled", kind: "demo" }), { self }).ok).toBe(false);
  });
});

describe("version handshake", () => {
  it("parses <major>.<minor> and rejects anything else", () => {
    expect(parseVersion("1.0")).toEqual({ major: 1, minor: 0 });
    expect(parseVersion("12.34")).toEqual({ major: 12, minor: 34 });
    for (const bad of ["1", "1.0.0", "v1.0", "", undefined, 1]) expect(parseVersion(bad)).toBeUndefined();
  });

  // Negotiated majors: a build that carries both majors talks to a peer on
  // either. This used to pin "another major is refused", which was the rule
  // when the package carried one major only.
  it("accepts every major the package carries, refuses others, reads absent as 1.0", () => {
    expect(isSupportedPeer({ major: 1, minor: 9 })).toBe(true);
    expect(isSupportedPeer({ major: 2, minor: 0 })).toBe(true);
    expect(isSupportedPeer({ major: 3, minor: 0 })).toBe(true);
    expect(isSupportedPeer({ major: 4, minor: 0 })).toBe(false);
    expect(isSupportedPeer(undefined)).toBe(true);
  });

  it("isCompatible takes its supported set from the caller, so it has one source", () => {
    expect(isCompatible({ major: 2, minor: 0 }, [1])).toBe(false);
    expect(isCompatible({ major: 2, minor: 0 }, [1, 2])).toBe(true);
  });

  it("the supported majors are exactly the schema tables parseFrame has", () => {
    expect([...SUPPORTED_MAJORS].sort()).toEqual([1, 2, 3]);
  });

  it("the package carries 2.0 but a connector still SPEAKS 1.0 by default", () => {
    // Shipping the 2.x schemas and flipping what a connector sends are
    // separate steps; the connector's Phase 2b flips PROTOCOL_VERSION.
    expect(PROTOCOL_VERSION).toBe("1.0");
    expect(LATEST_PROTOCOL_VERSION).toBe("3.0");
  });
});
