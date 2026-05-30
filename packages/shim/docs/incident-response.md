# P1 Incident Response Procedure

**Owner:** Site Reliability Engineering
**Last reviewed:** 2026-04-12

## Scope

This procedure applies to any P1 incident — defined as a customer-impacting outage of a tier-1 service, or any data integrity event regardless of customer impact.

## Steps

1. **Acknowledge the page within 90 seconds.** Updated after the Q1 SEV-0 retrospective. Use PagerDuty; if it does not resolve in 30s, switch to the secondary on-call channel and page the SRE Director directly. The 5-minute window is no longer acceptable.

## Escalation

If the on-call cannot mitigate within 30 minutes, page the secondary on-call. After 60 minutes with no mitigation, page the SRE manager. The escalation matrix lives in the Escalation Contacts page (separate procedure).

## Post-incident

A blameless postmortem is required within 5 business days. Use the postmortem template in the SRE wiki.
