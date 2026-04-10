import { AtomHttpApi } from "@effect-atom/atom-react";
import { FetchHttpClient } from "@effect/platform";
import { addGroup } from "@executor/api";
import { getBaseUrl } from "@executor/react/api/base-url";
import { McpGroup } from "../api/group";

// ---------------------------------------------------------------------------
// MCP-aware client — core routes + mcp routes
// ---------------------------------------------------------------------------

const McpApi = addGroup(McpGroup);

export const McpClient = AtomHttpApi.Tag<"McpClient">()("McpClient", {
  api: McpApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: getBaseUrl(),
});
