import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient } from "effect/unstable/http";
import { addGroup } from "@executor-js/api";
import { getBaseUrl } from "@executor-js/react/api/base-url";
import { OnePasswordGroup } from "../api/group";

// ---------------------------------------------------------------------------
// 1Password-aware client — core routes + onepassword routes
// ---------------------------------------------------------------------------

const OnePasswordApi = addGroup(OnePasswordGroup);

export const OnePasswordClient = AtomHttpApi.Service<"OnePasswordClient">()("OnePasswordClient", {
  api: OnePasswordApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: getBaseUrl(),
});
