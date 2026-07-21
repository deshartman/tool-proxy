# ORG-ACCOUNT-SCHEMA IMPACT ANALYSIS — MCP Shim

> Status: **Analysis Complete, Ready for Implementation**
> Date: 2026-07-09
> Related Plans: [ORG-ACCOUNT-SCHEMA.md](/Users/dhartman/Development/01_Twilio/AgenticProcedure/AgenticProcedure/.claude/plans/ORG-ACCOUNT-SCHEMA.md), [MULTI-ACCOUNT.md](/Users/dhartman/Development/01_Twilio/AgenticProcedure/AgenticProcedure/.claude/plans/MULTI-ACCOUNT.md)

## Summary

The controller-side change from `orgId` to `accountId` (as part of the schema migration in `AgenticProcedure/.claude/plans/ORG-ACCOUNT-SCHEMA.md`) has **minimal impact** on the MCP Shim connector. The connector remains **backward-compatible** and requires only small additive changes to support the new account-scoped credential handling.

Key finding: **The MCP Shim connector already passes the tenant context opaquely** — it does not interpret `orgId` / `accountId` semantics. The change is primarily on the controller's side for credential lookup and auto-fill behavior.

---

## Background: What Changed on the Controller Side

Per `ORG-ACCOUNT-SCHEMA.md`, the controller is implementing:

1. **New table structure**: `accounts` table with `id` (AccountId), `organisation_id` (FK), plus `tunnel_security_configs` now having `account_id` instead of `organisation_id`
2. **Multi-account support**: Users can belong to multiple accounts within one org
3. **Credential scoping**: Creds lookup now uses `(connectorId, accountId, mcp)` instead of `(connectorId, orgId, mcp)`
4. **The `tunnel_security_configs` row** (used for WS handshake auth) is now account-scoped

### Controller-side Contract Changes

| Aspect | Before | After |
|--------|--------|-------|
| **tunnel_security_configs key** | `(tenant_id, name)` → `orgId` derived | `(tenant_id, name)` → `accountId` derived |
| **Creds lookup** | `(connectorId, mcp)` scoped to org | `(connectorId, accountId, mcp)` scoped to account |
| **Twilio auto-fill** | `accountSid` from org's Default account | `accountSid` from connector's linked account |
| **Connector identity** | `name` claim in WS header | Same — no change |

---

## MCP Shim Connector Impact Assessment

### 1. WS Handshake Auth — **NO CHANGE REQUIRED**

The connector already sends:
```
Authorization: Bearer <bearer>
X-Connector-Name: <CONNECTOR_NAME>
```

The controller looks up the `tunnel_security_configs` row by `(tenant_id, name)`. The `tenant_id` derivation (from the matched row) happens **entirely on the controller side**. The connector has no knowledge of whether the row is keyed on `orgId` or `accountId`.

**Impact**: None. Connector behavior unchanged.

---

### 2. Credential Frame Protocol — **NO CHANGE REQUIRED**

The `creds-request` / `creds-response` / `creds-update` frames carry:
- `mcp: string` — MCP server name
- `mcpId?: string` — controller-minted id (v1.1+ for Type 2 MCPs)
- `author: string` — "twilio" or "customer"
- `envKeys: string[]` — env keys needed

The connector **never sends orgId or accountId** in the frame. The controller derives the tenant from the WS session.

Per `MCP-PROTOCOL.md` §"Twilio-bundled auto-fill":
> "When `creds-request` arrives with `author == "twilio"`, the controller fills the response from the `tunnel_security_configs` row used to authenticate this WS"

The controller already auto-fills `TWILIO_ACCOUNT_SID` from the tunnel-security row. After the schema change, the controller simply sources this from the **account-scoped** row instead of the org-scoped row.

**Impact**: None on connector. Controller-only change.

---

### 3. Auto-fill Keys — **POTENTIAL NEW KEYS (Optional Enhancement)**

The controller may need to communicate the `accountId` to the connector for scenarios where:
1. The connector needs to stamp `accountId` on outbound calls (unlikely — MCP tools handle this)
2. The bundled MCP needs to know which Twilio Account SID to use for API calls

**Current state**: The Twilio bundle auto-fills `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` only.

**Possible future addition**: A new auto-filled env key:
- `TWILIO_ACCOUNT_ID` — the internal `accountId` (our Account record ID, not the Twilio SID)

**Recommendation**: Hold off on this until needed. The MCP tools already receive `TWILIO_ACCOUNT_SID` which is what Twilio APIs need.

---

### 4. Frame Protocol Version — **NO VERSION BUMP NEEDED**

The account-scoping change is **transparent to the wire protocol**. The existing v1.3 frames remain valid:

- `register` — unchanged
- `creds-request` — unchanged
- `creds-response` — unchanged
- `creds-update` — unchanged
- All v1.1/v1.2/v1.3 frames — unchanged

**No new frame types, no breaking changes, backwards compatible**.

---

### 5. Connector Boot Sequence — **NO CHANGE**

The boot sequence remains:
1. Connector dials WS with `Authorization` + `X-Connector-Name`
2. Controller authenticates, binds to tunnel-security row (now account-scoped)
3. Connector sends `register`
4. Controller replies `register-ack` with `connectorId`
5. Connector sends `creds-request` for each MCP
6. Controller replies `creds-response` with auto-filled creds

The **account scoping is implicit** in the WS session — the connector doesn't need to know.

---

## MCP PROTOCOL Document Impact

The `docs/MCP-PROTOCOL.md` should receive a **documentation-only update** (no new version) to clarify:

1. **In §"Twilio-bundled auto-fill"**: Update the description to note that `TWILIO_ACCOUNT_SID` is sourced from the **account-scoped** tunnel-security row (post-Phase 1f migration).

2. **In §"Controller responsibilities"**: Clarify that creds lookups are scoped to `(connectorId, accountId, mcp)` where `accountId` is derived from the tunnel-security row used for WS auth.

### Proposed Documentation Update (NO CODE CHANGE)

```diff
- When `creds-request` arrives with `author == "twilio"`, the controller fills
- the response from the `tunnel_security_configs` row used to authenticate
- this WS.

+ When `creds-request` arrives with `author == "twilio"`, the controller fills
+ the response from the `tunnel_security_configs` row used to authenticate
+ this WS. The `tunnel_security_configs` row is scoped to an Account (not Org)
+ post-Phase 1f; the controller derives `accountId` from this row and scopes
+ all credential lookups and auto-fill to that Account.
```

---

## What WOULD Require Connector Change

The following scenarios would require code changes to the connector, but **none of these are in scope** for the current account migration:

### Scenario A: Multi-account per Connector (Explicit account switch)

If a single connector needs to simultaneously serve **multiple accounts** (i.e., the operator wants to dynamically switch which Twilio Account the connector targets):

**Current design**: One connector = one account. The tunnel-security row determines the account, and it's fixed at WS connect time.

**Future possibility**: A frame to switch active account mid-session:
```ts
// Hypothetical v1.4
interface AccountSwitchFrame {
  type: "account-switch";
  accountId: string;
}
```

This would need:
- A new frame in `frames.ts`
- Handling in `tunnel/client.ts` or the supervisor
- Restart of all Twilio-bundled MCP children with new creds

**NOT REQUIRED** for Phase 1f. This is Phase 2+ (multi-account per connector).

### Scenario B: Explicit accountId in creds-request

If the controller needs the connector to pass `accountId` explicitly:

```ts
interface CredsRequestFrame {
  type: "creds-request";
  accountId?: string;  // NEW — if the connector knows its account
  ...
}
```

**Current stance**: Not required. Controller derives from WS session.

### Scenario C: Connector-hosted account picker

If the connector needs to show an account picker UI (like the controller does):

This would require:
- `/api/accounts` endpoint on the inspector
- Session state for `activeAccountId`
- Account-scoped child spawning

**NOT REQUIRED** — Operations folks configure accounts at the controller, not via the connector.

---

## Implementation Checklist

When the controller-side Phase 1f lands and issues **new security credentials**:

### For MCP Shim Repo

- [ ] **No code changes required** to `packages/connector/src/`
- [ ] **Documentation update**: Add note to `docs/MCP-PROTOCOL.md` clarifying account-scoped credential lookup
- [ ] **Regression test**: Verify connector boots and receives auto-filled creds correctly with new account-scoped tunnel-security row

### For Controller-side

- [ ] Ensure `tunnel_security_configs.account_id` is populated at row creation
- [ ] Update creds lookup SQL: `(connector_id, account_id, mcp_name)` or `(connector_id, mcp_id)`
- [ ] Update Twilio auto-fill: source from the account's `twilio_account_sid` (via JOIN to `accounts` table)
- [ ] Backfill existing connector rows: create Default account per org, migrate existing `tunnel_security_configs` to point to it
- [ ] Issue new security credentials per the new schema (new bearer tokens)

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Controller creds lookup fails after migration | Medium | The controller MUST backfill `account_id` on existing rows before dropping `organisation_id`. The connector continues to work unchanged. |
| Twilio auto-fill returns wrong Account SID | Low | Controller must JOIN correctly through `accounts` table to get `twilio_account_sid`. Test this explicitly. |
| Connector cust tries to send `orgId` explicitly | Low | Don't do this. The connector should NOT add `orgId` or `accountId` to frames. Keep deriving from WS session. |
| Legacy connectors get blocked after controller migrates | Very Low | Controller keeps `tunnel_security_configs` lookup by name; the `account_id` change is internal to controller's auth resolution. The WS handshake with `X-Connector-Name` still works. |

---

## Summary Verdict

| Question | Answer |
|----------|--------|
| Does MCP Shim need code changes? | **No** — only documentation clarification |
| Does MCP-PROTOCOL version need bump? | **No** — existing v1.3 is sufficient |
| Does connector need to handle `accountId`? | **No** — it's implicit in the WS session |
| Does connector need to support multi-account? | **No** — that's Phase 2+ |
| Are new credentials required? | **Yes, from controller** — rotate `TUNNEL_AUTH_TOKEN` per new security row |

**Bottom line**: The Org→Account schema change is **controller-internal**. The MCP Shim connector is already designed to be **opaque to tenant scoping** — it authenticates via WS headers, and the controller handles the rest.
