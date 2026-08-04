# salesforce — Type 1 bundled MCP

Twilio-authored Type 1 drop-in living under `bundled-mcps/salesforce/` — auto-discovered at
connector boot (`MCP_BUNDLED_DIR`), non-gated (`author: "twilio"`), ships in the connector
image automatically via the Dockerfile's blanket `COPY bundled-mcps bundled-mcps`. No `cp -r`
step, no Dockerfile edit — unlike the reference-only demos under `examples/demos/`.

Gives an LLM/procedure real read+write access to a Salesforce org via the REST API,
authenticated with OAuth 2.0 **Client Credentials Flow** — a client_id + client_secret the
customer provides, no browser login, no CLI session state.

## Shape

Type 1 drop-in. Folder ships `tools/`, `prompts/`, `resources/`, and a `lib/` folder (not
scanned by the drop-in discoverer — shared helpers only). No `server.ts`, no `package.json`,
no yaml entry — same discovery path as every other Type 1 bundle
([`connector/src/dropin.ts`](../../connector/src/dropin.ts), synthesized child runtime in
[`connector/src/sdk/dropin-runner.ts`](../../connector/src/sdk/dropin-runner.ts)).

## Surface

### Tools

| Tool | Purpose |
|---|---|
| `query` | Run a SOQL query. |
| `search` | Run a SOSL full-text search — use when you don't know which field/object holds a value. |
| `describe_object` | List field names/labels/types for an object. Populates the `schema_cache` resource. |
| `get_record` | Fetch a record by object + id (all fields). |
| `create_record` | Create a record. |
| `update_record` | Update fields on an existing record. |
| `delete_record` | Delete a record. |

### Prompts

| Prompt | Purpose |
|---|---|
| `find_record_by_field` | Discover-then-query workflow — resolves a plain-English field hint (e.g. "phone number") to the real field API name via `describe_object` before querying/searching, instead of guessing. |
| `safe_write_record` | Discover-then-write workflow — confirms field API names + required fields via `describe_object` before `create_record`/`update_record`. |

### Resources

| Resource | URI | Purpose |
|---|---|---|
| `recent_records` | `salesforce://records/recent` | Last 16 records touched by `get_record`/`create_record`/`update_record`/`delete_record` (in-process, newest first). |
| `schema_cache` | `salesforce://schema/{objectName}` | Cached `describe_object` result per object. Empty for an object until `describe_object` has been called for it at least once this session. |

## Auth model

OAuth 2.0 **Client Credentials Flow**: `SF_CLIENT_ID` + `SF_CLIENT_SECRET` exchange for a
short-lived access token ([`lib/client.ts`](lib/client.ts)'s `sfFetch`/`getToken`), cached in
memory per child process. Client Credentials responses may omit `expires_in`, so the cache
uses a conservative 15-minute heuristic TTL; a 401 on any API call forces one token refresh +
retry.

This was chosen over Salesforce's official `@salesforce/mcp` package, which persists org auth
to `~/.sfdx` via the Salesforce CLI — a shape that doesn't fit this connector's env-var-based
creds pipeline (`dir/.env` → `creds-request`/`creds-response` → `applyControllerEnv`) and can't
survive a container restart without a bootstrap step this repo has no primitive for.

## Salesforce-side setup

Do this once per org, before setting the env vars below:

1. **Setup → App Manager → New External Client App.** (Salesforce restricts creating new
   *Connected Apps* as of Spring '26 — External Client Apps are the current path.)
2. **Enable OAuth Settings**, add scope `api` (minimum needed for the REST Data API).
3. **Enable Client Credentials Flow** on the app.
4. **Set a Run As user** — this determines the effective permissions, field-level security,
   and sharing rules every API call runs under. Use a dedicated integration user, not a
   personal login.
5. **Save**, then retrieve the **Consumer Key** (`SF_CLIENT_ID`) and **Consumer Secret**
   (`SF_CLIENT_SECRET`) from the app's API details.
6. Note your org's **My Domain URL** (`SF_LOGIN_URL`) — most orgs require My Domain enabled
   for Client Credentials Flow to work. Use `https://test.salesforce.com` for a sandbox
   instead.

## Getting it running

Bundled MCPs are always on — no copy step. Fill in `.env` (copy from `.env.example`) with the
three values above, then restart the connector (or click **Refresh local MCPs**). `salesforce`
appears in the inspector immediately; tools flip to **Ready** once the env values resolve
(dev: paste session creds via the inspector; production: controller-pushed via
`creds-response`).

## Wire-format tool names

Through the controller, tools appear as `salesforce.<tool>` (e.g. `salesforce.query`). The
`salesforce` segment comes from the folder name — rename the folder and the wire names change
with it.
