import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient } from "effect/unstable/http";
import { addGroup } from "@executor-js/api";
import { getBaseUrl } from "@executor-js/react/api/base-url";
import { CloudAuthApi } from "../auth/api";
import { OrgApi } from "../org/api";

// ---------------------------------------------------------------------------
// Cloud API client — core API + cloud auth + org
// ---------------------------------------------------------------------------

const CloudApi = addGroup(CloudAuthApi).add(OrgApi);
const CloudApiClient = AtomHttpApi.Service<"CloudApiClient">()("CloudApiClient", {
  api: CloudApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: getBaseUrl(),
});

export { CloudApiClient };
