// Proxy resolution for the tunnel dial. Regression-driven: these pin the
// var-precedence and empty-string rules, which are the parts that were
// already decided. The NO_PROXY matching policy is a separate judgment call
// (see the TODO in src/tunnel/proxy.ts) and its cases live at the bottom,
// unwritten until that policy is chosen.
//
// Env is injected as a literal map rather than mutated onto process.env —
// same pattern as tests/doctor/run-checks.test.ts.

import { describe, it, expect } from "vitest";
import { resolveProxy } from "../../src/tunnel/proxy.js";

const CONTROLLER = "wss://controller.example.com/mcp-tunnel";

describe("resolveProxy — no proxy in the environment", () => {
  it("dials direct with proxyConfigured false when nothing is set", () => {
    const d = resolveProxy(CONTROLLER, {});
    expect(d.proxyUrl).toBeUndefined();
    expect(d.reason).toBe("none");
    // The diagnostic hinges on this: false means "no proxy here", which is
    // normal. True with reason !== "proxy" is the case worth logging.
    expect(d.proxyConfigured).toBe(false);
  });

  it("treats an empty-string proxy var as not set (connector-wide env rule)", () => {
    // An admin writing `HTTPS_PROXY=` in .env means 'no proxy'. Without the
    // envOptional() indirection this would resolve to the empty URL and the
    // agent would be constructed against garbage.
    const d = resolveProxy(CONTROLLER, { HTTPS_PROXY: "", https_proxy: "" });
    expect(d.proxyUrl).toBeUndefined();
    expect(d.proxyConfigured).toBe(false);
  });

  it("does NOT treat a whitespace-only proxy var as unset", () => {
    // Deliberate, and pinned so nobody 'fixes' it by trimming here: src/env.ts
    // defines blank as `undefined || ""` exactly, not trimmed, and that rule is
    // whole-module. Special-casing whitespace in this one reader would make
    // proxy vars behave differently from every other env var in the connector.
    // A whitespace-only value therefore reaches the agent and fails loudly at
    // construction, which is the right outcome for a typo of this shape.
    const d = resolveProxy(CONTROLLER, { HTTPS_PROXY: " " });
    expect(d.proxyUrl).toBe(" ");
    expect(d.proxyConfigured).toBe(true);
  });

  it("reports no proxy for a malformed controller URL rather than throwing", () => {
    // A bad CONTROLLER_URL is the dial's failure to report, with its own
    // message. Throwing here would replace that with a stack from proxy code.
    const d = resolveProxy("not-a-url", { HTTPS_PROXY: "http://p:3128" });
    expect(d.proxyUrl).toBeUndefined();
    expect(d.reason).toBe("none");
  });
});

describe("resolveProxy — variable precedence", () => {
  it("uses HTTPS_PROXY for a wss:// target", () => {
    // wss is the secure scheme, so it takes the https var — the tunnel URL is
    // wss:// by the time client.ts dials, never https://.
    const d = resolveProxy(CONTROLLER, { HTTPS_PROXY: "http://proxy.corp:3128" });
    expect(d.proxyUrl).toBe("http://proxy.corp:3128");
    expect(d.reason).toBe("proxy");
    expect(d.proxyConfigured).toBe(true);
  });

  it("prefers lowercase over uppercase (curl's convention)", () => {
    const d = resolveProxy(CONTROLLER, {
      https_proxy: "http://lower:3128",
      HTTPS_PROXY: "http://upper:3128",
    });
    expect(d.proxyUrl).toBe("http://lower:3128");
  });

  it("falls back to ALL_PROXY when no scheme-specific var is set", () => {
    const d = resolveProxy(CONTROLLER, { ALL_PROXY: "http://all:3128" });
    expect(d.proxyUrl).toBe("http://all:3128");
  });

  it("ignores HTTP_PROXY for a secure target", () => {
    // HTTP_PROXY must not capture wss traffic — a host that proxies cleartext
    // but not TLS is a real configuration, and honouring it here would send
    // the tunnel somewhere that cannot CONNECT.
    const d = resolveProxy(CONTROLLER, { HTTP_PROXY: "http://cleartext:3128" });
    expect(d.proxyUrl).toBeUndefined();
    expect(d.proxyConfigured).toBe(false);
  });
});

// -- NO_PROXY exemptions: curl semantics + unconditional loopback ----------
// Policy chosen deliberately (see the doc comment on matchesNoProxy): suffix
// matching on a dot boundary, leading dots ignored, ports ignored, loopback
// always exempt. These pin the boundary cases where other tools disagree, so a
// future "simplification" to plain `includes()` or exact-match fails here.
describe("resolveProxy — NO_PROXY exemptions", () => {
  const withProxy = (noProxy: string, target = CONTROLLER) =>
    resolveProxy(target, { HTTPS_PROXY: "http://proxy.corp:3128", NO_PROXY: noProxy });

  it("bypasses the proxy for '*'", () => {
    const d = withProxy("*");
    expect(d.proxyUrl).toBeUndefined();
    expect(d.reason).toBe("excluded");
    // Still true: a proxy IS configured, it just doesn't apply here. The
    // diagnostic depends on telling these apart.
    expect(d.proxyConfigured).toBe(true);
  });

  it("matches a subdomain by suffix, as curl does", () => {
    // controller.example.com vs entry example.com
    expect(withProxy("example.com").reason).toBe("excluded");
  });

  it("does not match a host that merely ends with the entry's text", () => {
    // THE false positive that a naive endsWith() or includes() would allow:
    // "notexample.com" must NOT be exempted by the entry "example.com".
    const d = resolveProxy("wss://notexample.com/mcp-tunnel", {
      HTTPS_PROXY: "http://proxy.corp:3128",
      NO_PROXY: "example.com",
    });
    expect(d.reason).toBe("proxy");
    expect(d.proxyUrl).toBe("http://proxy.corp:3128");
  });

  it("treats a leading dot as identical to no leading dot", () => {
    // curl ignores the dot, so ".example.com" exempts the parent too.
    expect(withProxy(".example.com").reason).toBe("excluded");
    expect(resolveProxy("wss://example.com/mcp-tunnel", {
      HTTPS_PROXY: "http://p:3128", NO_PROXY: ".example.com",
    }).reason).toBe("excluded");
  });

  it("ignores a port qualifier on the entry", () => {
    expect(withProxy("example.com:8443").reason).toBe("excluded");
  });

  it("handles comma, whitespace and mixed-case lists", () => {
    expect(withProxy("foo.internal,  EXAMPLE.COM ,bar.internal").reason).toBe("excluded");
    expect(withProxy("foo.internal bar.internal").reason).toBe("proxy");
  });

  it("exempts loopback even when NO_PROXY is unset entirely", () => {
    // The bug this guards: folding the loopback check into matchesNoProxy
    // would skip it whenever NO_PROXY is absent, because resolveProxy only
    // consults the matcher when the var is set. Spawned children live on
    // 127.0.0.1, so a bare HTTPS_PROXY would send their traffic to the proxy.
    for (const host of ["127.0.0.1", "127.0.0.53", "localhost", "svc.localhost", "[::1]"]) {
      const d = resolveProxy(`http://${host}:7100/mcp`, { HTTP_PROXY: "http://proxy.corp:3128" });
      expect(d.reason, host).toBe("excluded");
      expect(d.proxyUrl, host).toBeUndefined();
    }
  });

  it("still proxies a non-loopback host when NO_PROXY is unset", () => {
    const d = resolveProxy(CONTROLLER, { HTTPS_PROXY: "http://proxy.corp:3128" });
    expect(d.reason).toBe("proxy");
  });

  it("ignores a trailing root dot on the target host", () => {
    const d = resolveProxy("wss://controller.example.com./mcp-tunnel", {
      HTTPS_PROXY: "http://p:3128", NO_PROXY: "example.com",
    });
    expect(d.reason).toBe("excluded");
  });
});
