import { AtomHttpApi } from "@effect-atom/atom-react";
import { FetchHttpClient } from "@effect/platform";
import { addGroup } from "@executor/api";
import { getBaseUrl } from "@executor/react/api/base-url";
import { OpenApiGroup } from "../api/group";

// ---------------------------------------------------------------------------
// OpenAPI-aware client — core routes + openapi routes
// ---------------------------------------------------------------------------

const OpenApiApi = addGroup(OpenApiGroup);

export const OpenApiClient = AtomHttpApi.Tag<"OpenApiClient">()("OpenApiClient", {
  api: OpenApiApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: getBaseUrl(),
});
