// Machine API: credential → workspace (MULTI-PLATFORM-MCP §5.6).
//
// The /v1/* paths are unchanged (so NON_LOOPBACK_ALLOWED_PATHS and its
// exhaustive test are untouched); what changed is which tunnel a call rides.
// A credential is bound to exactly one controller entry, and the call goes
// out on that entry's workspace or nowhere:
//
//   * self-issued (HS256) — the token's `sub` is an API client, and the client
//     carries the `controllerId` it was minted for;
//   * federated (RS256) — the token carries no client mapping, so the entry is
//     the one whose trusted issuer matches its `iss` + `aud`. The configure
//     step refuses the same pair on two entries, so the match is unique.
//
// The federated case needs care. The issuer to verify AGAINST depends on the
// token's own unverified claims, so the claims only ever CHOOSE an issuer.
// The signature is then checked with that entry's JWKS, and the verified
// claims re-derive the entry — a forged `iss`/`aud` names a JWKS the forger
// does not hold, and fails there.

import type { AccessTokenClaims, JwtVerifierConfig } from "../auth/jwt.js";
import type { ConfigStore } from "../config-store/index.js";
import type { ControllerApiCoordinator } from "../tunnel/controller-api-coordinator.js";
import type { Logger } from "../logger.js";

export interface MachineApiRoutingDeps {
  store: Pick<ConfigStore, "findControllerByIssuer" | "getTrustedIssuerConfig" | "apiClientController" | "getControllerById">;
  signingKey: Buffer;
  /** The live coordinator of a workspace, or undefined when it has no tunnel. */
  coordinatorOf: (controllerId: string) => ControllerApiCoordinator | undefined;
  log: Logger;
}

export function createMachineApiRouting(deps: MachineApiRoutingDeps) {
  return {
    async getVerifierConfig(token: string): Promise<JwtVerifierConfig> {
      const claimed = peekIssuer(token);
      const controllerId = claimed ? await deps.store.findControllerByIssuer(claimed.iss, claimed.aud) : undefined;
      const trustedIssuer = controllerId ? await deps.store.getTrustedIssuerConfig(controllerId) : undefined;
      return { selfIssuedSigningKey: deps.signingKey, ...(trustedIssuer ? { trustedIssuer } : {}) };
    },

    async getCoordinator(claims: AccessTokenClaims): Promise<ControllerApiCoordinator | undefined> {
      const controllerId = await controllerFor(claims);
      // A client bound to a REMOVED entry keeps its controllerId, so check the
      // entry still exists rather than trusting the workspace map to be empty:
      // the binding itself must be live for the call to go anywhere.
      if (!controllerId || !(await deps.store.getControllerById(controllerId))) {
        deps.log.warn({ sub: claims.sub }, `machine-API credential is bound to no live controller entry — refusing`);
        return undefined;
      }
      return deps.coordinatorOf(controllerId);
    },
  };

  // A federated token is identified by carrying iss + aud (verifyRs256WithJwks
  // has already checked both against the entry's config); a self-issued one
  // carries neither, and resolves through its client.
  function controllerFor(claims: AccessTokenClaims): Promise<string | undefined> {
    return typeof claims.iss === "string" && typeof claims.aud === "string"
      ? deps.store.findControllerByIssuer(claims.iss, claims.aud)
      : deps.store.apiClientController(claims.sub);
  }
}

// The unverified `iss` + `aud` of a JWT — used only to CHOOSE which entry's
// issuer to verify it against. Never trusted for anything else.
function peekIssuer(token: string): { iss: string; aud: string } | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { iss?: unknown; aud?: unknown };
    return typeof payload.iss === "string" && typeof payload.aud === "string" ? { iss: payload.iss, aud: payload.aud } : undefined;
  } catch {
    return undefined;
  }
}
