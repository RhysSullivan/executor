import { AtomHttpApi } from "@effect-atom/atom-react";
import { FetchHttpClient } from "@effect/platform";
import { addGroup } from "@executor/api";
import { getBaseUrl } from "@executor/react/api/base-url";
import { GraphqlGroup } from "../api/group";

// ---------------------------------------------------------------------------
// GraphQL-aware client — core routes + graphql routes
// ---------------------------------------------------------------------------

const GraphqlApi = addGroup(GraphqlGroup);

export const GraphqlClient = AtomHttpApi.Tag<"GraphqlClient">()("GraphqlClient", {
  api: GraphqlApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: getBaseUrl(),
});
