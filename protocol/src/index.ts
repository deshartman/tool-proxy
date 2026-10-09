// @gtmi/toolproxy-protocol — the connector ⇄ controller tunnel wire protocol.
//
// The connector (mcp-shim) owns this package; controllers depend on it and
// never define frames of their own (decision D7). See README.md.

export * from "./schemas.js";
export type * from "./types.js";
export * from "./version.js";
export { parseFrame, type Direction, type ParseOptions, type ParseResult } from "./parse.js";
