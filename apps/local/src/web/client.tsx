import { AtomHttpApi } from "@effect-atom/atom-react";
import { FetchHttpClient } from "@effect/platform";
import { addGroup } from "@executor/api";
import { SecretsUsageApi } from "@executor/react/api/secrets-usage";
import { getBaseUrl } from "@executor/react/api/base-url";

const LocalAppApi = addGroup(SecretsUsageApi);

class LocalApiClient extends AtomHttpApi.Tag<LocalApiClient>()("LocalApiClient", {
  api: LocalAppApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: getBaseUrl(),
}) {}

export { LocalApiClient };
