import { describe, it, expect } from "vitest";
import { parseFrame } from "../src/parse.js";
import { qualifyToolName, parseQualifiedToolName, isShimId, isServerName } from "../src/naming.js";
import * as v1 from "../src/schemas-v1.js";
import * as v2 from "../src/schemas-v2.js";

// Protocol 2.0 — the deltas agreed with the platform (AgenticProcedure plan
// §9.0), plus the property that makes the negotiated-major model safe: 1.x
// parsing is unchanged when the package also carries 2.x.

const V1 = { major: 1, minor: 0 };
const V2 = { major: 2, minor: 0 };
const SHIM = "k3f9x2qa";

const server = (name: string) => ({
  name,
  transport: "http",
  author: "twilio",
  tools: [{ name: "get", description: "d", inputSchema: {}, allowed: true }],
});
const manifest = (servers: unknown[]) => ({ connectorId: "", environment: "dev", version: "dev", servers });

describe("qualified tool names — the two-step parse", () => {
  it("composes <shimId>.<server>.<tool>", () => {
    expect(qualifyToolName(SHIM, "crm", "get_customer")).toBe("k3f9x2qa.crm.get_customer");
  });

  it("keeps further dots in the TOOL, never in the server", () => {
    // The case the one-step rule got wrong: it read server "crm.get".
    expect(parseQualifiedToolName("k3f9x2qa.crm.get.customer")).toEqual({
      shimId: SHIM,
      server: "crm",
      tool: "get.customer",
    });
  });

  it("round-trips, including tool names with dots", () => {
    for (const tool of ["t", "get_customer", "a.b.c", "x-y.z"]) {
      expect(parseQualifiedToolName(qualifyToolName(SHIM, "crm", tool))).toEqual({ shimId: SHIM, server: "crm", tool });
    }
  });

  it("rejects malformed names without throwing (input comes off the wire)", () => {
    for (const bad of [
      "",
      "crm.get",                // 1.x bare form: no shimId
      "k3f9x2qa",               // id only
      "k3f9x2qa.crm",           // no tool
      "k3f9x2qa.crm.",          // empty tool
      "k3f9x2qa..get",          // empty server
      "BADID123.crm.get",       // not lowercase Crockford
      "k3f9x2qi.crm.get",       // 'i' is excluded from Crockford
      "k3f9x2qa.-crm.get",      // server must start alphanumeric
    ]) {
      expect(() => parseQualifiedToolName(bad)).not.toThrow();
      expect(parseQualifiedToolName(bad)).toBeUndefined();
    }
  });

  it("qualifyToolName refuses to compose a name that would not round-trip", () => {
    expect(() => qualifyToolName("BAD", "crm", "t")).toThrow(/shimId/);
    expect(() => qualifyToolName(SHIM, "crm.sales", "t")).toThrow(/server name/);
    expect(() => qualifyToolName(SHIM, "crm", "")).toThrow(/empty/);
  });

  it("isShimId / isServerName match the connector's own rules", () => {
    expect(isShimId("cra85py8")).toBe(true); // a real id minted by the connector
    expect(isShimId("cra85py")).toBe(false);
    expect(isServerName("agentic-memory")).toBe(true);
    expect(isServerName("crm.sales")).toBe(false);
  });
});

describe("register in 2.x", () => {
  const base = { type: "register", manifest: manifest([server("crm")]), name: "x" };

  it("requires shimId and tunnelProtocol", () => {
    expect(parseFrame("connector-to-controller", JSON.stringify({ ...base, shimId: SHIM, tunnelProtocol: "2.0" }), { peer: V2 }).ok).toBe(true);
    expect(parseFrame("connector-to-controller", JSON.stringify({ ...base, tunnelProtocol: "2.0" }), { peer: V2 }).ok).toBe(false);
    expect(parseFrame("connector-to-controller", JSON.stringify({ ...base, shimId: SHIM }), { peer: V2 }).ok).toBe(false);
  });

  it("rejects a malformed shimId", () => {
    const r = parseFrame("connector-to-controller", JSON.stringify({ ...base, shimId: "NOT-AN-ID", tunnelProtocol: "2.0" }), { peer: V2 });
    expect(r.ok).toBe(false);
  });

  it("rejects a dotted server name in the manifest", () => {
    const frame = { ...base, manifest: manifest([server("crm.sales")]), shimId: SHIM, tunnelProtocol: "2.0" };
    expect(parseFrame("connector-to-controller", JSON.stringify(frame), { peer: V2 }).ok).toBe(false);
  });
});

describe("manifest-delta in 2.x — server lifecycle", () => {
  const delta = (extra: object) => ({ type: "manifest-delta", delta: { added: [], removed: [], changed: [], ...extra } });

  it("accepts addedServers carrying author and transport", () => {
    const frame = delta({ addedServers: [{ name: "sample", transport: "http", author: "twilio" }] });
    expect(parseFrame("connector-to-controller", JSON.stringify(frame), { peer: V2 }).ok).toBe(true);
  });

  it("accepts removedServers", () => {
    expect(parseFrame("connector-to-controller", JSON.stringify(delta({ removedServers: ["sample"] })), { peer: V2 }).ok).toBe(true);
  });

  it("requires author on an added server (the gap 2.0 exists to close)", () => {
    const frame = delta({ addedServers: [{ name: "sample", transport: "http" }] });
    expect(parseFrame("connector-to-controller", JSON.stringify(frame), { peer: V2 }).ok).toBe(false);
  });

  it("is NOT accepted by a 1.x parse (strict 1.0 has no such field)", () => {
    const frame = delta({ addedServers: [{ name: "sample", transport: "http", author: "twilio" }] });
    expect(parseFrame("connector-to-controller", JSON.stringify(frame), { peer: V1 }).ok).toBe(false);
  });
});

describe("mcp-notification", () => {
  const frame = { type: "mcp-notification", server: "crm", payload: {} };

  it("still parses under 1.x", () => {
    expect(parseFrame("connector-to-controller", JSON.stringify(frame), { peer: V1 }).ok).toBe(true);
  });

  it("is gone in 2.x", () => {
    const r = parseFrame("connector-to-controller", JSON.stringify(frame), { peer: V2 });
    expect(r).toMatchObject({ ok: false, type: "mcp-notification" });
  });
});

describe("negotiated majors", () => {
  it("1.x parsing is unchanged when the package also carries 2.x", () => {
    // A 1.0 register — no shimId — must still be valid for a 1.x peer.
    const r = parseFrame("connector-to-controller", JSON.stringify({ type: "register", manifest: manifest([server("crm")]) }), { peer: V1 });
    expect(r.ok).toBe(true);
  });

  it("refuses a major the package carries no schemas for", () => {
    const r = parseFrame("connector-to-controller", JSON.stringify({ type: "heartbeat", ts: 1 }), { peer: { major: 3, minor: 0 } });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok && !r.ignored) expect(r.error).toMatch(/major 3/);
  });

  it("tolerates a newer 2.x minor, and a newer 1.x minor, independently", () => {
    const hb = JSON.stringify({ type: "heartbeat", ts: 1, future: true });
    expect(parseFrame("connector-to-controller", hb, { peer: { major: 2, minor: 4 } }).ok).toBe(true);
    expect(parseFrame("connector-to-controller", hb, { peer: { major: 1, minor: 4 } }).ok).toBe(true);
    expect(parseFrame("connector-to-controller", hb, { peer: V2 }).ok).toBe(false);
    expect(parseFrame("connector-to-controller", hb, { peer: V1 }).ok).toBe(false);
  });

  it("v2 reuses v1's schema OBJECTS for every frame 2.0 did not change", () => {
    // Shared by identity, not copied, so the majors cannot drift by accident.
    expect(v2.HeartbeatFrameSchema).toBe(v1.HeartbeatFrameSchema);
    expect(v2.CredsResponseFrameSchema).toBe(v1.CredsResponseFrameSchema);
    expect(v2.McpDiscoveredFrameSchema).toBe(v1.McpDiscoveredFrameSchema);
    expect(v2.RegisterFrameSchema).not.toBe(v1.RegisterFrameSchema);
  });
});

// 1.0.1 — found by the platform against the PUBLISHED 1.0.0: a strict 1.x
// parse rejected a 2.0 register (`shimId` → unrecognized_keys), so a 2.x
// connector would be locked out of any 1.x controller that enforces validation.
// v1's register now tolerates the next major's handshake field.
describe("cross-major register handshake (1.0.1)", () => {
  const reg2 = { type: "register", manifest: manifest([server("crm")]), name: "x", tunnelProtocol: "2.0", shimId: SHIM };

  it("a STRICT 1.x parse accepts a 2.x connector's register", () => {
    expect(parseFrame("connector-to-controller", JSON.stringify(reg2), { peer: V1 }).ok).toBe(true);
    expect(parseFrame("connector-to-controller", JSON.stringify(reg2)).ok).toBe(true); // no peer → strict 1.x
  });

  it("1.x tolerates shimId without validating it (it is a 2.x field)", () => {
    const odd = { ...reg2, shimId: "NOT-A-VALID-ID" };
    expect(parseFrame("connector-to-controller", JSON.stringify(odd), { peer: V1 }).ok).toBe(true);
  });

  it("1.x still rejects OTHER unknown register fields — the tolerance is exactly one field", () => {
    const extra = { ...reg2, somethingElse: 1 };
    expect(parseFrame("connector-to-controller", JSON.stringify(extra), { peer: V1 }).ok).toBe(false);
  });

  it("2.x still validates shimId strictly (the 1.x tolerance does not leak into v2)", () => {
    const bad = { ...reg2, shimId: "NOT-A-VALID-ID" };
    expect(parseFrame("connector-to-controller", JSON.stringify(bad), { peer: V2 }).ok).toBe(false);
    const missing = { ...reg2 } as Record<string, unknown>;
    delete missing.shimId;
    expect(parseFrame("connector-to-controller", JSON.stringify(missing), { peer: V2 }).ok).toBe(false);
  });
});
