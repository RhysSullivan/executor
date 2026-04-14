import { AtomHttpApi } from "@effect-atom/atom-react";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform";
import { ExecutorApi } from "@executor/api";

import { getBaseUrl, getCurrentOrgSlug } from "./base-url";

// ---------------------------------------------------------------------------
// Core API client — tools + secrets
// ---------------------------------------------------------------------------
//
// `baseUrl` is captured once at class construction, so we can't bake the
// org slug into it. Instead we read the current slug per-request via
// `transformClient` and rewrite `/api/...` to `/api/o/${slug}/...`. The
// server's api middleware peels the slug off and uses it for authorization
// independent of the session cookie. See `base-url.tsx` for why this lives
// in a mutable module-level ref.

const injectOrgSlug = (url: string): string => {
  const slug = getCurrentOrgSlug();
  if (!slug) return url;
  // `/api` may be followed by `/`, `?`, `#`, or end-of-string — match all.
  return url.replace(/\/api(?=\/|$|\?|#)/, `/api/o/${slug}`);
};

class ExecutorApiClient extends AtomHttpApi.Tag<ExecutorApiClient>()("ExecutorApiClient", {
  api: ExecutorApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: getBaseUrl(),
  transformClient: (client) =>
    HttpClient.mapRequest(client, HttpClientRequest.updateUrl(injectOrgSlug)),
}) {}

export { ExecutorApiClient };
