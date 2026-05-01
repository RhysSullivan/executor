import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient } from "effect/unstable/http";
import { ExecutorApi } from "@executor-js/api";

import { getBaseUrl } from "./base-url";

// ---------------------------------------------------------------------------
// Core API client — tools + secrets
// ---------------------------------------------------------------------------

const ExecutorApiClient = AtomHttpApi.Service<"ExecutorApiClient">()("ExecutorApiClient", {
  api: ExecutorApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: getBaseUrl(),
});

export { ExecutorApiClient };
