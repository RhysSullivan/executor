// ---------------------------------------------------------------------------
// Executor API base URL
// ---------------------------------------------------------------------------
//
// The base URL points at the executor HTTP API. For cloud, the shell calls
// `setOrgSlug(slug)` during render once auth resolves. The ExecutorApiClient
// reads the current slug per-request via `transformClient` and rewrites the
// URL from `/api/...` to `/api/o/${slug}/...` so every request is URL-pinned
// to a specific org. The server's api middleware peels the slug back off
// and uses it instead of the session cookie for authorization — this makes
// cross-tab fetches independent and removes the need for a
// `switchOrganization` round-trip when a bookmarked URL doesn't match the
// active session cookie.
//
// For local there is no org, so `setOrgSlug` is never called and requests
// go to `${origin}/api`.

const DEFAULT_BASE_URL = "http://127.0.0.1:4000";

const rootBase =
  typeof window !== "undefined" && typeof window.location?.origin === "string"
    ? `${window.location.origin}/api`
    : `${DEFAULT_BASE_URL}/api`;

let baseUrl = rootBase;

export const getBaseUrl = (): string => baseUrl;

export const setBaseUrl = (url: string): void => {
  baseUrl = url;
};

// Current org slug, read per-request by the api client's transformClient.
// We can't bake the slug into `baseUrl` because AtomHttpApi captures baseUrl
// once at class construction time; instead we keep it in a mutable ref that
// the transform reads on each request.
let currentOrgSlug: string | null = null;

export const getCurrentOrgSlug = (): string | null => currentOrgSlug;

/**
 * Pin subsequent API requests to an org slug. Pass `null` to return to the
 * unscoped root (e.g., during logout).
 */
export const setOrgSlug = (slug: string | null): void => {
  currentOrgSlug = slug;
};
