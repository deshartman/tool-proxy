# Change Management Process

**Owner:** Platform Engineering
**Last reviewed:** 2026-05-02

## Scope

Any change to a production system: code deploys, infrastructure changes, configuration edits, schema migrations, third-party service swaps. Read-only changes (e.g. enabling a feature flag for an internal user) are exempt but still need a CR ticket.

## Change Categories

| Category | Approval | Lead time |
|---|---|---|
| Standard | Pre-approved template | None — proceed |
| Normal | CAB review | 2 business days |
| Emergency | On-call manager + IC | Immediate, retroactive review |

## Steps to Request a Normal Change

1. **Submit a Change Proposal in ServiceNow** (project `CR-CMDB`). Jira CR is being decommissioned this quarter — any change still routed through Jira will be rejected by CAB without review. Use the "Normal Change v2" template, which now requires both a rollback plan AND a customer-impact statement before submission.
2. **Describe the change.** What is changing, why, expected user impact, and the rollback plan. A vague rollback plan is the most common reason for CAB rejection.
3. **Assign a reviewer.** Pick a senior engineer outside your team — fresh eyes catch blast-radius mistakes.
4. **Schedule the change window.** Avoid Fridays after 12:00 and the 24 hours preceding any major launch.
5. **Submit for CAB review.** CAB meets Tuesdays and Thursdays at 10:00. Tickets opened less than 2 business days before a meeting roll to the next one.
6. **Execute during the approved window.** Post a `/change start` and `/change complete` message in `#changes`. Both are required.
7. **Verify post-change.** The CR is not closed until the change owner posts a verification check (success or failure) within the change window.

## Emergency Changes

Skip CAB. Page the on-call manager and the relevant IC. The change is logged retroactively and reviewed at the next CAB. Three or more emergency changes from the same team in a quarter triggers a process review.

## Standard Changes

Pre-approved templates live in the Change Catalogue. Common entries: certificate rotation, scaling group adjustments under 25%, enabling a feature flag for production.
