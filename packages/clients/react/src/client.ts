import { AtomHttpApi } from "@effect-atom/atom-react";
import { FetchHttpClient } from "@effect/platform";
import { ExecutorApi } from "@executor/api";

import { getBaseUrl } from "./base-url";

// ---------------------------------------------------------------------------
// Core API client — tools + secrets
// ---------------------------------------------------------------------------

class ExecutorApiClient extends AtomHttpApi.Tag<ExecutorApiClient>()(
  "ExecutorApiClient",
  {
    api: ExecutorApi,
    httpClient: FetchHttpClient.layer,
    baseUrl: getBaseUrl(),
  },
) {}

export { ExecutorApiClient };
