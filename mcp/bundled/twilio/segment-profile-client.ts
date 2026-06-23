import { createLogger } from "@mcp-shim/connector/sdk";

// Segment Profile API client. There is no official Profile-API SDK on npm —
// only @segment/analytics-node, which covers the Tracking API. The Profile
// API is a small surface (3 endpoints we care about) over plain HTTPS Basic
// auth, so we hand-roll a fetch wrapper rather than pulling in axios.
//
// Auth shape: HTTP Basic with the PAT as the username and an EMPTY password.
// (Segment's convention — the trailing colon in `${pat}:` matters.)
//
// Hostnames are region-specific: profiles.segment.com (US — default) and
// profiles.euw1.segment.com (EU). v1 hardcodes US; if an EU customer shows
// up we'll add SEGMENT_PROFILE_HOST as an optional env var (see plan).

const log = createLogger("segment-profile");

const DEFAULT_HOST = "https://profiles.segment.com";

export type IdType = "phone" | "email" | "user_id" | "anonymous_id";

export interface SegmentProfileClient {
  getTraits(idType: IdType, value: string, opts?: ProfileQuery): Promise<TraitsResponse | null>;
  getEvents(idType: IdType, value: string, opts?: EventsQuery): Promise<EventsResponse | null>;
  getExternalIds(idType: IdType, value: string): Promise<ExternalIdsResponse | null>;
}

export interface ProfileQuery {
  limit?: number;
  include?: string;
  next?: string;
}

export interface EventsQuery extends ProfileQuery {
  // Same shape as ProfileQuery for now; kept distinct so tool authors see
  // intent at the call site and we can grow events-specific options later
  // (e.g. `?start=` / `?end=`) without breaking traits callers.
}

// Profile API response shapes are intentionally loose — the Profile API
// returns customer-defined trait keys / event names / external-id types,
// none of which we can pin in a static schema. Tool-level zod schemas
// describe the shape of the WRAPPER we hand back; the inner data stays
// `unknown` for procedure authors to project as they see fit.
export interface TraitsResponse {
  traits: Record<string, unknown>;
  cursor?: { has_more: boolean; next?: string };
}

export interface EventsResponse {
  events: Array<{ event: string; timestamp: string; properties?: Record<string, unknown> }>;
  cursor?: { has_more: boolean; next?: string };
}

export interface ExternalIdsResponse {
  externalIds: Array<{
    type: string;
    id: string;
    source_id?: string;
    collection?: string;
    created_at?: string;
    encoding?: string;
  }>;
  cursor?: { has_more: boolean; next?: string };
}

interface ProfileApiPayload {
  data?: unknown;
  cursor?: { has_more: boolean; next?: string };
}

export function createSegmentProfileClient(env: NodeJS.ProcessEnv = process.env): SegmentProfileClient {
  const spaceId = env.SEGMENT_SPACE_ID;
  const pat = env.SEGMENT_PROFILE_PAT;

  if (!spaceId) {
    throw new Error("SEGMENT_SPACE_ID must be set");
  }
  if (!pat) {
    throw new Error("SEGMENT_PROFILE_PAT must be set");
  }

  const host = env.SEGMENT_PROFILE_HOST || DEFAULT_HOST;
  const authHeader = `Basic ${Buffer.from(`${pat}:`).toString("base64")}`;

  log.info({ host, spaceId }, "segment profile client ready");

  async function get(path: string, query?: Record<string, string | number | undefined>): Promise<ProfileApiPayload | null> {
    const url = new URL(`${host}/v1/spaces/${encodeURIComponent(spaceId!)}/collections/users/profiles/${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
      }
    }

    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: authHeader, Accept: "application/json" },
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`segment profile API ${response.status}: ${body || response.statusText}`);
    }
    return (await response.json()) as ProfileApiPayload;
  }

  function profilePath(idType: IdType, value: string, suffix: string): string {
    return `${idType}:${encodeURIComponent(value)}/${suffix}`;
  }

  return {
    async getTraits(idType, value, opts) {
      const payload = await get(profilePath(idType, value, "traits"), {
        limit: opts?.limit,
        include: opts?.include,
        next: opts?.next,
      });
      if (!payload) return null;
      // Profile API returns { traits: { key: value, ... }, cursor }.
      const data = (payload.data ?? payload) as { traits?: Record<string, unknown> };
      return {
        traits: data.traits ?? {},
        cursor: payload.cursor,
      };
    },

    async getEvents(idType, value, opts) {
      const payload = await get(profilePath(idType, value, "events"), {
        limit: opts?.limit,
        include: opts?.include,
        next: opts?.next,
      });
      if (!payload) return null;
      const data = (payload.data ?? []) as Array<{ event: string; timestamp: string; properties?: Record<string, unknown> }>;
      return {
        events: data,
        cursor: payload.cursor,
      };
    },

    async getExternalIds(idType, value) {
      const payload = await get(profilePath(idType, value, "external_ids"));
      if (!payload) return null;
      const data = (payload.data ?? []) as ExternalIdsResponse["externalIds"];
      return {
        externalIds: data,
        cursor: payload.cursor,
      };
    },
  };
}
