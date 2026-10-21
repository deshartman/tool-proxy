// How tool and prompt names look on the wire for ONE tunnel session.
//
// The shape depends on the protocol major negotiated with that controller
// (MULTI-PLATFORM-MCP Phase 2b, decisions D1 + D8 + D11):
//
//   1.x  `<server>.<name>`             — split on the first dot
//   2.x  `<shimId>.<server>.<name>`  — frozen wire; same string form as 3.x
//   3.x  `<proxyId>.<server>.<name>` — the package's two-step parse; the name
//                                         keeps any further dots
//
// The Dispatcher is handed one of these per session and never branches on a
// version itself, so it cannot mix the two forms. The rule lives in
// @gtmi/toolproxy-protocol's naming helpers; this file only selects it.

import { parseQualifiedToolName, qualifyToolName, parseQualifiedProxyToolName, qualifyProxyToolName } from "@gtmi/toolproxy-protocol";

export type ParsedName =
  | { ok: true; server: string; name: string }
  // Well-formed but addressed to a different proxy. Distinct from malformed so
  // the dispatcher can log a misroute, while replying exactly as it would for
  // an unknown server (no existence oracle).
  | { ok: false; reason: "foreign-proxy"; proxyId: string }
  | { ok: false; reason: "malformed" };

export interface WireNaming {
  /** "1", "2" or "3" — which form this session uses. */
  readonly major: 1 | 2 | 3;
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

export function qualifiedNaming(proxyId: string, major: 2 | 3 = 3): WireNaming {
  // 2.x and 3.x are the same string form; the major only selects which
  // package helper (and so which id vocabulary) parses it.
  const qualify = major === 2 ? qualifyToolName : qualifyProxyToolName;
  return {
    major,
    shape: "${proxyId}.${server}.${name}",
    compose: (server, name) => qualify(proxyId, server, name),
    parse: (wireName) => {
      const id = major === 2
        ? (() => { const p = parseQualifiedToolName(wireName); return p && { id: p.shimId, server: p.server, tool: p.tool }; })()
        : (() => { const p = parseQualifiedProxyToolName(wireName); return p && { id: p.proxyId, server: p.server, tool: p.tool }; })();
      if (!id) return { ok: false, reason: "malformed" };
      if (id.id !== proxyId) return { ok: false, reason: "foreign-proxy", proxyId: id.id };
      return { ok: true, server: id.server, name: id.tool };
    },
  };
}

// The session's major and naming, from what we are willing to speak and what
// the controller advertised in register-ack. min(ours, theirs): qualified only when
// BOTH speak 2 or later. A controller that advertised nothing (predates the field) is
// 1.x. Pure, so every (ceiling, controller) pair is unit-testable without a
// tunnel — a live test only exercises whichever ceiling is shipped.
export function negotiateNaming(
  speakMajor: number,
  controllerMax: { major: number } | undefined,
  proxyId: string,
): WireNaming {
  const sessionMajor = Math.min(speakMajor, controllerMax?.major ?? 1);
  return sessionMajor >= 3 ? qualifiedNaming(proxyId, 3) : sessionMajor === 2 ? qualifiedNaming(proxyId, 2) : bareNaming();
}
