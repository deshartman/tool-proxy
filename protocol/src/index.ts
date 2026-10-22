// @gtmi/toolproxy-protocol — the connector ⇄ controller tunnel wire protocol.
//
// The connector (Tool Proxy) owns this package; controllers depend on it and
// never define frames of their own (decision D7). See README.md.
//
// One package carries ALL protocol majors (negotiated by register's
// tunnelProtocol): `v1` (frozen 1.x wire), `v2` (the 2.0 deltas, `shimId`) and
// `v3` (the 3.0 rename, `proxyId`). The
// top-level schema exports are the current major's — 1.x until the
// connector flips it — so 1.x callers keep working unchanged.

export * from "./schemas-v1.js";
export * as v1 from "./schemas-v1.js";
export * as v2 from "./schemas-v2.js";
export * as v3 from "./schemas-v3.js";
export type * from "./types.js";
export * from "./version.js";
export * from "./naming.js";
export { parseFrame, isSupportedPeer, SUPPORTED_MAJORS, type Direction, type ParseOptions, type ParseResult } from "./parse.js";
