import { describe, it, expect } from "vitest";
import { diffManifest, diffServers, withServerLifecycle, isEmptyDelta } from "../../src/manifest/diff.js";
import type { ToolManifest, ServerDescriptor } from "../../src/tunnel/frames.js";

// MULTI-PLATFORM-MCP Phase 2b step 3 / §2.5a. Found in the 2c end-to-end test:
// a server whose FIRST appearance is a manifest-delta arrived with no author,
// so the platform labelled an enabled Twilio-bundled server "customer". In 2.x
// the delta carries server lifecycle (addedServers / removedServers) with the
// metadata. It must NEVER reach a 1.x controller, whose strict parse rejects it.

const tool = (name: string) => ({ name, description: "d", inputSchema: {}, allowed: true });
const srv = (name: string, author: string, tools = [tool("t")], extra: Partial<ServerDescriptor> = {}): ServerDescriptor =>
  ({ name, transport: "http", author, tools, ...extra });
const m = (servers: ServerDescriptor[]): ToolManifest => ({ connectorId: "", environment: "dev", version: "dev", servers });

describe("diffServers", () => {
  it("reports an added server with author, transport and protocolVersion", () => {
    const { addedServers, removedServers } = diffServers(m([]), m([srv("sample", "twilio", undefined, { protocolVersion: "2026-07-28" })]));
    expect(addedServers).toEqual([{ name: "sample", transport: "http", author: "twilio", protocolVersion: "2026-07-28" }]);
    expect(removedServers).toEqual([]);
  });

  it("reports a removed server by name", () => {
    expect(diffServers(m([srv("sample", "twilio")]), m([])).removedServers).toEqual(["sample"]);
  });

  it("omits protocolVersion when the server did not report one", () => {
    expect("protocolVersion" in diffServers(m([]), m([srv("crm", "customer")])).addedServers[0]).toBe(false);
  });

  it("reports nothing for a server present on both sides", () => {
    expect(diffServers(m([srv("crm", "customer")]), m([srv("crm", "customer")]))).toEqual({ addedServers: [], removedServers: [] });
  });
});

describe("withServerLifecycle", () => {
  const prev = m([]);
  const next = m([srv("sample", "twilio")]);

  it("leaves a 1.x delta EXACTLY as diffManifest produced it", () => {
    const base = diffManifest(prev, next);
    expect(withServerLifecycle(base, prev, next, 1)).toEqual(base);
    expect("addedServers" in withServerLifecycle(base, prev, next, 1)).toBe(false);
  });

  it("attaches the added server — with its author — on a 2.x session", () => {
    const delta = withServerLifecycle(diffManifest(prev, next), prev, next, 2);
    expect(delta.addedServers).toEqual([{ name: "sample", transport: "http", author: "twilio" }]);
    // The fix for the 2c bug: the receiver no longer infers the author.
    expect(delta.addedServers?.[0].author).toBe("twilio");
  });

  it("omits empty lifecycle arrays, so a 2.x delta with no server change looks like 1.x", () => {
    const same = m([srv("crm", "customer", [tool("a")])]);
    const changed = m([srv("crm", "customer", [tool("a"), tool("b")])]);
    const delta = withServerLifecycle(diffManifest(same, changed), same, changed, 2);
    expect("addedServers" in delta).toBe(false);
    expect("removedServers" in delta).toBe(false);
  });
});

describe("isEmptyDelta and server lifecycle", () => {
  it("a TOOLLESS server appearing is still a delta worth sending under 2.x", () => {
    // No tools → diffManifest sees no tool change; only the server is new.
    const prev = m([]);
    const next = m([srv("pending-creds", "customer", [])]);
    const base = diffManifest(prev, next);
    expect(isEmptyDelta(base)).toBe(true); // 1.x: genuinely nothing to send
    expect(isEmptyDelta(withServerLifecycle(base, prev, next, 2))).toBe(false); // 2.x: send it
  });

  it("a toolless server vanishing is likewise sent under 2.x", () => {
    const prev = m([srv("gone", "customer", [])]);
    const delta = withServerLifecycle(diffManifest(prev, m([])), prev, m([]), 2);
    expect(delta.removedServers).toEqual(["gone"]);
    expect(isEmptyDelta(delta)).toBe(false);
  });
});
