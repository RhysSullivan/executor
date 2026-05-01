import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient } from "effect/unstable/http";
import { addGroup } from "@executor-js/api";
import { getBaseUrl } from "@executor-js/react/api/base-url";
import { OpenApiGroup } from "../api/group";

// ---------------------------------------------------------------------------
// OpenAPI-aware client — core routes + openapi routes
// ---------------------------------------------------------------------------

const OpenApiApi = addGroup(OpenApiGroup);

export const OpenApiClient = AtomHttpApi.Service<"OpenApiClient">()("OpenApiClient", {
  api: OpenApiApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: getBaseUrl(),
});
