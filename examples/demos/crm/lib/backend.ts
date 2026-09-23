// Shared mock-backend settings for the crm drop-in (MCP-AUDIT #28).
//
// Both constants were duplicated verbatim in eight of the nine tools. They live
// here so the endpoint and the timeout are stated once — and so the `envKeys`
// declaration each tool now carries has exactly one thing to point at.
//
// MOCK_CUSTOMERS_URL is read via envString rather than `??` (MCP-AUDIT #21):
// an operator who clears the value to "" means "use the default", and `??`
// would instead hand `fetch()` a bare path and throw "Failed to parse URL".
//
// Read once at module load, which is correct rather than merely convenient: the
// supervisor restarts the child on every creds-update / session-creds paste, so
// a new value arrives as a fresh process rather than as a mutation of this one
// (see docs/AUTHOR-LOCAL-MCP.md "In-process state is a cache, not the truth").
import { envString } from "@mcp-shim/connector/sdk";

export const MOCK_URL = envString("MOCK_CUSTOMERS_URL", "http://localhost:7400");

// Per-request ceiling for every call into the mock. Each tool wraps its fetch in
// an AbortController armed with this — a hung backend must surface as a tool
// error well inside the controller's own RPC timeout, not hang the dispatcher.
export const REQ_TIMEOUT_MS = 4000;

// A future example slot for the tool schemas' .describe() text, computed fresh
// on every module load (i.e. every drop-in child spawn) instead of a hardcoded
// literal — a baked-in ISO date goes stale exactly like the old in-memory
// fixtures did, and an operator (or model) reading the schema can copy it
// literally, landing on `in_the_past` every time.
export function exampleSlotISO(daysOut: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysOut);
  d.setUTCHours(14, 0, 0, 0);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}
