import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient } from "effect/unstable/http";
import { addGroup } from "@executor-js/api";
import { getBaseUrl } from "@executor-js/react/api/base-url";
import { GoogleDiscoveryGroup } from "../api/group";

const GoogleDiscoveryApi = addGroup(GoogleDiscoveryGroup);

export const GoogleDiscoveryClient = AtomHttpApi.Service<"GoogleDiscoveryClient">()(
  "GoogleDiscoveryClient",
  {
    api: GoogleDiscoveryApi,
    httpClient: FetchHttpClient.layer,
    baseUrl: getBaseUrl(),
  },
);
