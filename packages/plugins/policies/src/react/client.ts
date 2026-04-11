import { AtomHttpApi } from "@effect-atom/atom-react";
import { FetchHttpClient } from "@effect/platform";
import { addGroup } from "@executor/api";
import { getBaseUrl } from "@executor/react/api/base-url";
import { PoliciesGroup } from "../api/group";

// ---------------------------------------------------------------------------
// Policies-aware client — core routes + policies routes
// ---------------------------------------------------------------------------

const PoliciesApi = addGroup(PoliciesGroup);

export const PoliciesClient = AtomHttpApi.Tag<"PoliciesClient">()("PoliciesClient", {
  api: PoliciesApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: getBaseUrl(),
});
