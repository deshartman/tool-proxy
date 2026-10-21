import { describe, it, expect } from "vitest";
import { parseFrame, SUPPORTED_MAJORS } from "../src/parse.js";
import {
  qualifyProxyToolName,
  parseQualifiedProxyToolName,
  isProxyId,
  PROXY_ID_RE,
  proxyIdSchema,
  SHIM_ID_RE,
  qualifyToolName,
} from "../src/naming.js";
import { negotiateVersion, LATEST_PROTOCOL_VERSION, PROTOCOL_VERSION, parseVersion } from "../src/version.js";
import * as v2 from "../src/schemas-v2.js";
import * as v3 from "../src/schemas-v3.js";
import * as pkg from "../src/index.js";

const V1 = { major: 1, minor: 0 };
const V2 = { major: 2, minor: 0 };
const V3 = { major: 3, minor: 0 };
const PROXY = "k3f9x2qa";

const manifest = {
  connectorId: "",
  environment: "dev",
  version: "dev",
  servers: [{ name: "crm", transport: "http", author: "twilio", tools: [] }],
};
const reg = (extra: Record<string, unknown>) => JSON.stringify({ type: "register", manifest, name: "x", ...extra });

describe("register in 3.x", () => {
  it("accepts proxyId + tunnelProtocol 3.0", () => {
    const r = parseFrame("connector-to-controller", reg({ proxyId: PROXY, tunnelProtocol: "3.0" }), { peer: V3 });
    expect(r.ok).toBe(true);
  });
  it("requires proxyId", () => {
    expect(parseFrame("connector-to-controller", reg({ tunnelProtocol: "3.0" }), { peer: V3 }).ok).toBe(false);
  });
  it("requires tunnelProtocol", () => {
    expect(parseFrame("connector-to-controller", reg({ proxyId: PROXY }), { peer: V3 }).ok).toBe(false);
  });
  it("rejects a malformed proxyId", () => {
    for (const bad of ["", "short", "K3F9X2QA", "k3f9x2qi", "k3f9x2qa1", "k3f9.2qa"]) {
      expect(parseFrame("connector-to-controller", reg({ proxyId: bad, tunnelProtocol: "3.0" }), { peer: V3 }).ok).toBe(false);
    }
  });
  it("rejects the 2.x shimId field under strict 3.x", () => {
    const r = parseFrame("connector-to-controller", reg({ proxyId: PROXY, shimId: PROXY, tunnelProtocol: "3.0" }), { peer: V3 });
    expect(r.ok).toBe(false);
  });
  it("2.x register is still shimId, unchanged", () => {
    expect(parseFrame("connector-to-controller", reg({ shimId: PROXY, tunnelProtocol: "2.0" }), { peer: V2 }).ok).toBe(true);
    expect(parseFrame("connector-to-controller", reg({ proxyId: PROXY, tunnelProtocol: "2.0" }), { peer: V2 }).ok).toBe(false);
  });
  it("a newer 3.x minor is tolerant, a 3.0 peer strict", () => {
    const extra = { proxyId: PROXY, tunnelProtocol: "3.1", future: 1 };
    const self = V3;
    expect(parseFrame("connector-to-controller", reg(extra), { self, peer: { major: 3, minor: 1 } }).ok).toBe(true);
    expect(parseFrame("connector-to-controller", reg(extra), { self, peer: V3 }).ok).toBe(false);
  });
  it("shares every non-register schema with 2.x", () => {
    expect(v3.CONTROLLER_FRAME_SCHEMAS).toBe(v2.CONTROLLER_FRAME_SCHEMAS);
    expect(v3.CONNECTOR_FRAME_SCHEMAS.length).toBe(v2.CONNECTOR_FRAME_SCHEMAS.length);
    expect(v3.HeartbeatFrameSchema).toBe(v2.HeartbeatFrameSchema);
  });
  it("is a supported major", () => {
    expect(SUPPORTED_MAJORS).toContain(3);
    expect(pkg.isSupportedPeer(V3)).toBe(true);
  });
});

describe("3.x tool names", () => {
  it("uses the same id rule as 2.x", () => {
    expect(PROXY_ID_RE).toBe(SHIM_ID_RE);
    expect(isProxyId(PROXY)).toBe(true);
    expect(isProxyId("nope")).toBe(false);
    expect(isProxyId(5)).toBe(false);
    expect(proxyIdSchema.safeParse("nope").success).toBe(false);
  });
  it("composes and parses, keeping dots in the tool", () => {
    expect(qualifyProxyToolName(PROXY, "crm", "get.customer")).toBe("k3f9x2qa.crm.get.customer");
    expect(parseQualifiedProxyToolName("k3f9x2qa.crm.get.customer")).toEqual({ proxyId: PROXY, server: "crm", tool: "get.customer" });
  });
  it("round-trips", () => {
    for (const tool of ["t", "get_customer", "a.b.c"]) {
      expect(parseQualifiedProxyToolName(qualifyProxyToolName(PROXY, "crm", tool))).toEqual({ proxyId: PROXY, server: "crm", tool });
    }
  });
  it("rejects bare and malformed forms", () => {
    for (const bad of ["crm.get_customer", "get_customer", "", "k3f9x2qa.crm", "k3f9x2qa.crm.", "k3f9x2qa..t", "TOOLS12.crm.t", "k3f9x2qa.c m.t"]) {
      expect(parseQualifiedProxyToolName(bad)).toBeUndefined();
    }
  });
  it("throws composing from bad parts", () => {
    expect(() => qualifyProxyToolName("bad", "crm", "t")).toThrow();
    expect(() => qualifyProxyToolName(PROXY, "c.rm", "t")).toThrow();
    expect(() => qualifyProxyToolName(PROXY, "crm", "")).toThrow();
  });
  it("2.x helpers are unchanged and agree on the string form", () => {
    expect(qualifyToolName(PROXY, "crm", "t")).toBe(qualifyProxyToolName(PROXY, "crm", "t"));
  });
});

describe("version negotiation", () => {
  const ours = parseVersion(LATEST_PROTOCOL_VERSION)!;
  it("package constants", () => {
    expect(LATEST_PROTOCOL_VERSION).toBe("3.0");
    expect(PROTOCOL_VERSION).toBe("1.0");
  });
  it("peer advertises nothing -> exact 1.x wire", () => {
    expect(negotiateVersion(ours, undefined)).toEqual(V1);
  });
  it("peer 1.x -> 1.x", () => {
    expect(negotiateVersion(ours, V1)).toEqual(V1);
  });
  it("peer 2.x -> 2.x (shimId wire)", () => {
    expect(negotiateVersion(ours, V2)).toEqual(V2);
    expect(negotiateVersion(ours, { major: 2, minor: 4 })).toEqual({ major: 2, minor: 4 });
  });
  it("peer 3.x -> 3.x, minor is the lower", () => {
    expect(negotiateVersion(ours, V3)).toEqual(V3);
    expect(negotiateVersion(ours, { major: 3, minor: 5 })).toEqual(V3);
  });
  it("peer newer major -> ours", () => {
    expect(negotiateVersion(ours, { major: 4, minor: 0 })).toEqual(ours);
  });
});
