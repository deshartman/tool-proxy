import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMcpHttpServer, LOOPBACK_BIND } from "../../src/sdk/http-server.js";
import type { Tool } from "../../src/sdk/tool.js";

// MCP-AUDIT #1 — every Type 1 MCP child must bind loopback only.
//
// `/mcp` carries the MCP's whole tool surface with no authentication of any kind
// (the trust boundary is per MCP *server* — which servers the customer runs —
// not anything on the wire), and `/envkeys` names the creds it wants. Omitting
// the host argument to http.listen makes Node bind `::`/`0.0.0.0`, which put
// that surface on every interface: the LAN in dev, every sibling in the
// container's network namespace in production.
//
// Nothing needs the wider bind — mcp-supervisor's spawnChild stamps
// `http://127.0.0.1:<port>/mcp` onto the spec, and fetchEnvKeys derives its URL
// from that same endpoint.
//
// WHY WE ASSERT handle.address AND NOT A BIND PROBE: the obvious behavioural
// test — hold the port, then try to bind it elsewhere — cannot discriminate
// portably. Node sets SO_REUSEADDR, and BSD/macOS then permits a
// specific-address bind over a held wildcard bind while Linux refuses it. So
// "can I bind 127.0.0.1 again" discriminates on macOS but not Linux, and "can I
// bind the external interface" is the reverse. Measured, not assumed: with the
// bug reintroduced on macOS, re-binding 127.0.0.1 returned `bound`. Asserting
// the socket's own reported address is exact on every platform.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "../../src/sdk/http-server.ts"), "utf8");

const noopTool: Tool = {
  name: "noop",
  register(server) {
    server.registerTool("noop", { description: "test" }, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
  },
};

describe("MCP-AUDIT #1 — Type 1 MCP children bind loopback only", () => {
  it("binds 127.0.0.1, not a wildcard address", async () => {
    const handle = await createMcpHttpServer({ name: "bind-test", tools: [noopTool], port: 0 });
    try {
      expect(handle.address).toBe("127.0.0.1");
      // Spell out the failure modes so a regression names itself.
      expect(handle.address).not.toBe("0.0.0.0");
      expect(handle.address).not.toBe("::");
    } finally {
      await handle.close();
    }
  });

  it("still serves /envkeys on the address the supervisor dials", async () => {
    const handle = await createMcpHttpServer({ name: "bind-test-fn", tools: [noopTool], port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/envkeys`);
      expect(res.ok).toBe(true);
      expect(await res.json()).toEqual({ envKeys: [] });
    } finally {
      await handle.close();
    }
  });

  it("passes the loopback constant to http.listen (source trip-wire)", () => {
    expect(LOOPBACK_BIND).toBe("127.0.0.1");
    expect(SRC).toMatch(/http\.listen\(\s*requestedPort\s*,\s*LOOPBACK_BIND\s*,/);
    // No bare two-arg listen(port, callback).
    expect(SRC).not.toMatch(/http\.listen\(\s*requestedPort\s*,\s*\(\)/);
  });
});
