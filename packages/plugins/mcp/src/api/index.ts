import { definePlugin } from "@executor-js/sdk/core";

import { mcpPlugin, type McpPluginOptions } from "../sdk/plugin";
import { McpGroup } from "./group";
import { McpHandlers, McpExtensionService } from "./handlers";

export { McpGroup } from "./group";
export { McpHandlers, McpExtensionService } from "./handlers";

// HTTP-augmented variant of `mcpPlugin`. The returned plugin carries
// the HTTP `routes`, `handlers`, and `extensionService` so a host can
// mount the MCP HTTP surface. Hosts that compose an `HttpApi` should
// import this. SDK-only consumers stay on `@executor-js/plugin-mcp`
// and never load `@executor-js/api`.
export const mcpHttpPlugin = definePlugin((options?: McpPluginOptions) => ({
  ...mcpPlugin(options),
  routes: () => McpGroup,
  handlers: () => McpHandlers,
  extensionService: McpExtensionService,
}));
