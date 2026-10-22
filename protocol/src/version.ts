// The tunnel protocol version, and the handshake rule (Tool Proxy plan §2.4).
//
// PROTOCOL_VERSION is what this package speaks, as "<major>.<minor>". It is
// carried on the wire as `register.tunnelProtocol` (connector → controller);
// the controller echoes its supported range as
// `register-ack.supportedTunnelProtocol`. The package's own semver major.minor
// equals LATEST_PROTOCOL_VERSION (the newest schemas it carries); it also
// carries every earlier major it still negotiates.
//
// Named `tunnelProtocol`, deliberately NOT `protocolVersion` — that name is
// already the negotiated MCP era on ServerDescriptor ("2026-07-28").
//
// 1.0 is the 1.x wire, exactly. 2.0 adds D′ naming (`<shimId>.<server>.<tool>`),
// which is breaking. This package carries BOTH majors (`v1`, `v2`); a peer's
// major is negotiated from `register.tunnelProtocol`, and a register with no
// `tunnelProtocol` at all is a 1.x peer that predates the field.
//
// PROTOCOL_VERSION is what a connector built on this package SPEAKS by default.
// It stays "1.0" in 3.0.0 of the package on purpose: shipping the 2.x schemas
// and flipping what a connector sends are separate steps (the connector's
// Phase 2b flips it, after a live 1.x ⇄ 2.x test). LATEST_PROTOCOL_VERSION is
// the newest major.minor whose schemas this package carries.

export const PROTOCOL_VERSION = "1.0";
export const LATEST_PROTOCOL_VERSION = "3.0";

export interface ProtocolVersion {
  major: number;
  minor: number;
}

export function parseVersion(value: unknown): ProtocolVersion | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)\.(\d+)$/.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function formatVersion(v: ProtocolVersion): string {
  return `${v.major}.${v.minor}`;
}

// The register-ack error code a controller sends when it refuses a peer's
// major. A connector treats it as a sticky rejection — no auto-reconnect.
export const UNSUPPORTED_TUNNEL_PROTOCOL = "unsupported_tunnel_protocol";

// WebSocket close code a controller uses when it ENFORCES schema validation and
// refuses a frame (reason "frame_schema_mismatch"). A connector must treat it as
// STICKY — no auto-reconnect — because reconnecting re-sends the same frame and
// is refused again: a mismatch is a version/contract problem, not a transient
// one. It is distinct from a register-ack error code: under enforcement a
// refused register gets no ack at all, only this close.
export const FRAME_SCHEMA_MISMATCH_CLOSE = 4422;

// Decide whether a peer's version is acceptable. Any major this package carries
// schemas for is accepted — that is the negotiated-major model: a 2.0-capable
// build still talks to a 1.x peer. A peer that sent no version is treated as
// 1.0. Newer minors of a carried major parse tolerantly (see parse.ts).
//
// The supported set is passed in rather than declared here, so it has ONE
// source: the schema tables in parse.ts (SUPPORTED_MAJORS). A hand-kept list
// here could disagree with what parseFrame can actually parse.
export function isCompatible(
  peer: ProtocolVersion | undefined,
  supportedMajors: readonly number[],
): boolean {
  const effective = peer ?? { major: 1, minor: 0 };
  return supportedMajors.includes(effective.major);
}

// The peer version a receiver should parse with, given the register frame's
// tunnelProtocol. Absent → 1.0 (a peer that predates the field). An
// unparseable value → undefined, which the caller must treat as a refusal.
export function peerVersionFromRegister(tunnelProtocol: unknown): ProtocolVersion | undefined {
  if (tunnelProtocol === undefined) return { major: 1, minor: 0 };
  return parseVersion(tunnelProtocol);
}

// The version a session runs at: min(ours, the peer's advertised max). A peer
// that advertises nothing (a controller that predates register-ack's
// `supportedTunnelProtocol`) is 1.0, so a 3.x speaker produces the exact 1.x
// wire for it, the exact 2.x wire (`shimId`) for a peer whose max is 2.x, and
// the 3.x wire (`proxyId`) only when the peer advertises 3.x. Majors compare
// first; within one major the lower minor wins.
export function negotiateVersion(ours: ProtocolVersion, peerMax: ProtocolVersion | undefined): ProtocolVersion {
  if (!peerMax) return { major: 1, minor: 0 };
  if (peerMax.major !== ours.major) return peerMax.major < ours.major ? peerMax : ours;
  return { major: ours.major, minor: Math.min(ours.minor, peerMax.minor) };
}
