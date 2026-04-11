import { AtomHttpApi } from "@effect-atom/atom-react";
import { FetchHttpClient } from "@effect/platform";
import { addGroup } from "@executor/api";
import { getBaseUrl } from "@executor/react/api/base-url";
import { CloudAuthApi } from "../auth/api";
import { OrgApi } from "../org/api";

// ---------------------------------------------------------------------------
// Cloud API client — core API + cloud auth + org
// ---------------------------------------------------------------------------

const CloudApi = addGroup(CloudAuthApi).add(OrgApi);

class CloudApiClient extends AtomHttpApi.Tag<CloudApiClient>()("CloudApiClient", {
  api: CloudApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: getBaseUrl(),
}) {}

export { CloudApiClient };
