// The tunnel protocol version, and the handshake rule (shim plan §2.4).
//
// PROTOCOL_VERSION is what this package speaks, as "<major>.<minor>". It is
// carried on the wire as `register.tunnelProtocol` (connector → controller);
// the controller echoes its supported range as
// `register-ack.supportedTunnelProtocol`. The package's own semver major.minor
// tracks it exactly, so `~<major>.<minor>.0` pins one protocol minor.
//
// Named `tunnelProtocol`, deliberately NOT `protocolVersion` — that name is
// already the negotiated MCP era on ServerDescriptor ("2026-07-28").
//
// 1.0 is today's wire, exactly. It becomes 2.0 when D′ naming changes the tool
// name shape (`<shimId>.<server>.<tool>`), which is breaking. A register with
// no `tunnelProtocol` at all is a 1.x peer that predates the field.

export const PROTOCOL_VERSION = "1.0";

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

// Decide whether a peer's version is acceptable to us. A different major is
// refused; any minor of our major is accepted (newer minors parse tolerantly,
// see parse.ts). A peer that sent no version is treated as 1.0.
export function isCompatible(self: ProtocolVersion, peer: ProtocolVersion | undefined): boolean {
  const effective = peer ?? { major: 1, minor: 0 };
  return effective.major === self.major;
}
