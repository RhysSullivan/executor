import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient } from "effect/unstable/http";
import { addGroup } from "@executor-js/api";
import { getBaseUrl } from "@executor-js/react/api/base-url";
import { GraphqlGroup } from "../api/group";

// ---------------------------------------------------------------------------
// GraphQL-aware client — core routes + graphql routes
// ---------------------------------------------------------------------------

const GraphqlApi = addGroup(GraphqlGroup);

export const GraphqlClient = AtomHttpApi.Service<"GraphqlClient">()("GraphqlClient", {
  api: GraphqlApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: getBaseUrl(),
});
