// @gtmi/toolproxy-protocol — the connector ⇄ controller tunnel wire protocol.
//
// The connector (mcp-shim) owns this package; controllers depend on it and
// never define frames of their own (decision D7). See README.md.
//
// One package carries BOTH protocol majors (negotiated by register's
// tunnelProtocol): `v1` (frozen 1.x wire) and `v2` (the 2.0 deltas). The
// top-level schema exports are the current major's — 1.x until the
// connector's Phase 2b — so 1.x callers keep working unchanged.

export * from "./schemas-v1.js";
export * as v1 from "./schemas-v1.js";
export * as v2 from "./schemas-v2.js";
export type * from "./types.js";
export * from "./version.js";
export * from "./naming.js";
export { parseFrame, isSupportedPeer, SUPPORTED_MAJORS, type Direction, type ParseOptions, type ParseResult } from "./parse.js";
