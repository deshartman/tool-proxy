// How tool and prompt names look on the wire for ONE tunnel session.
//
// The shape depends on the protocol major negotiated with that controller
// (MULTI-PLATFORM-MCP Phase 2b, decisions D1 + D8 + D11):
//
//   1.x  `<server>.<name>`             — split on the first dot
//   2.x  `<shimId>.<server>.<name>`    — the package's two-step parse; the name
//                                         keeps any further dots
//
// The Dispatcher is handed one of these per session and never branches on a
// version itself, so it cannot mix the two forms. The rule lives in
// @gtmi/toolproxy-protocol's naming helpers; this file only selects it.

import { parseQualifiedToolName, qualifyToolName } from "@gtmi/toolproxy-protocol";

export type ParsedName =
  | { ok: true; server: string; name: string }
  // Well-formed but addressed to a different shim. Distinct from malformed so
  // the dispatcher can log a misroute, while replying exactly as it would for
  // an unknown server (no existence oracle).
  | { ok: false; reason: "foreign-shim"; shimId: string }
  | { ok: false; reason: "malformed" };

export interface WireNaming {
  /** "1" or "2" — which form this session uses. */
  readonly major: 1 | 2;
  compose(server: string, name: string): string;
  parse(wireName: string): ParsedName;
  /** Human-readable form, for the error a malformed name gets. */
  readonly shape: string;
}

export function bareNaming(): WireNaming {
  return {
    major: 1,
    shape: "${server}.${name}",
    compose: (server, name) => `${server}.${name}`,
    parse: (wireName) => {
      const dot = wireName.indexOf(".");
      if (dot <= 0 || dot === wireName.length - 1) return { ok: false, reason: "malformed" };
      return { ok: true, server: wireName.slice(0, dot), name: wireName.slice(dot + 1) };
    },
  };
}

export function qualifiedNaming(shimId: string): WireNaming {
  return {
    major: 2,
    shape: "${shimId}.${server}.${name}",
    compose: (server, name) => qualifyToolName(shimId, server, name),
    parse: (wireName) => {
      const parsed = parseQualifiedToolName(wireName);
      if (!parsed) return { ok: false, reason: "malformed" };
      if (parsed.shimId !== shimId) return { ok: false, reason: "foreign-shim", shimId: parsed.shimId };
      return { ok: true, server: parsed.server, name: parsed.tool };
    },
  };
}

// The session's major and naming, from what we are willing to speak and what
// the controller advertised in register-ack. min(ours, theirs): 2.x only when
// BOTH speak 2. A controller that advertised nothing (predates the field) is
// 1.x. Pure, so every (ceiling, controller) pair is unit-testable without a
// tunnel — a live test only exercises whichever ceiling is shipped.
export function negotiateNaming(
  speakMajor: number,
  controllerMax: { major: number } | undefined,
  shimId: string,
): WireNaming {
  const sessionMajor = Math.min(speakMajor, controllerMax?.major ?? 1);
  return sessionMajor >= 2 ? qualifiedNaming(shimId) : bareNaming();
}
