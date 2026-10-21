// OAuth 2.0 Client Credentials Flow token cache + a thin fetch wrapper over
// the Salesforce REST API. No CLI, no persisted ~/.sfdx session — see
// README.md "Auth model" for why this bundle rolls its own client instead of
// the official @salesforce/mcp package.

import { envString } from "@gtmi/toolproxy-connector/sdk";

const API_VERSION = "v62.0";
// Client Credentials token responses may omit expires_in, so this is a
// conservative proactive-refresh heuristic. The 401 → forced refresh → retry
// once in sfFetch() is the real correctness backstop, not this TTL.
const TOKEN_TTL_MS = 15 * 60 * 1000;

interface TokenState {
  accessToken: string;
  instanceUrl: string;
  expiresAt: number;
}

let cached: TokenState | undefined;

function loginUrl(): string {
  // envString, not `??` (MCP-AUDIT #21): SF_LOGIN_URL="" is how an operator
  // says "use the default", but `??` treats "" as set and fetch() then throws
  // "Failed to parse URL" on the bare /services/oauth2/token path.
  return envString("SF_LOGIN_URL", "https://login.salesforce.com");
}

async function fetchToken(): Promise<TokenState> {
  const clientId = process.env.SF_CLIENT_ID;
  const clientSecret = process.env.SF_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SF_CLIENT_ID / SF_CLIENT_SECRET are not set");
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(`${loginUrl()}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as {
    access_token?: string;
    instance_url?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token || !data.instance_url) {
    throw new Error(`Salesforce token request failed: ${data.error_description ?? res.status}`);
  }
  return { accessToken: data.access_token, instanceUrl: data.instance_url, expiresAt: Date.now() + TOKEN_TTL_MS };
}

async function getToken(forceRefresh = false): Promise<TokenState> {
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached;
  cached = await fetchToken();
  return cached;
}

function dataApiRequest(token: TokenState, path: string, init: RequestInit): Promise<Response> {
  return fetch(`${token.instanceUrl}/services/data/${API_VERSION}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token.accessToken}`, "content-type": "application/json" },
  });
}

export interface SfFetchResult {
  status: number;
  ok: boolean;
  body: unknown;
}

// path is relative to /services/data/{API_VERSION}, e.g. "/sobjects/Account/001...".
// Retries exactly once on 401 after forcing a token refresh.
export async function sfFetch(path: string, init: RequestInit = {}): Promise<SfFetchResult> {
  let token = await getToken();
  let res = await dataApiRequest(token, path, init);
  if (res.status === 401) {
    token = await getToken(true);
    res = await dataApiRequest(token, path, init);
  }
  if (res.status === 204) {
    return { status: 204, ok: true, body: undefined };
  }
  const text = await res.text();
  // MCP-AUDIT #19: a non-JSON body — a proxy's HTML error page, a WAF block, a
  // maintenance interstitial — used to throw a raw SyntaxError, surfacing as an
  // opaque tool failure instead of the structured envelope every other path in
  // this module produces. Fall back to the raw text so salesforceError can still
  // report something useful.
  return { status: res.status, ok: res.ok, body: parseJsonOrRaw(text) };
}

function parseJsonOrRaw(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Cap it: an HTML error page can be large, and this reaches the controller's
    // model as tool output.
    return { raw: text.length > 2000 ? `${text.slice(0, 2000)}… [truncated]` : text };
  }
}
