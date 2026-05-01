import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient } from "effect/unstable/http";
import { addGroup } from "@executor-js/api";
import { getBaseUrl } from "@executor-js/react/api/base-url";
import { McpGroup } from "../api/group";

// ---------------------------------------------------------------------------
// MCP-aware client — core routes + mcp routes
// ---------------------------------------------------------------------------

const McpApi = addGroup(McpGroup);

export const McpClient = AtomHttpApi.Service<"McpClient">()("McpClient", {
  api: McpApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: getBaseUrl(),
});
