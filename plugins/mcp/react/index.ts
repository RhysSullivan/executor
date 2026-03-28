import { defineExecutorFrontendPlugin } from "@executor/react/plugins";

import {
  McpAddPage,
  McpDetailRoute,
  McpEditRoute,
} from "./components";

export const McpReactPlugin = defineExecutorFrontendPlugin({
  key: "mcp",
  displayName: "MCP",
  description: "Connect remote or local MCP servers.",
  routes: [
    {
      key: "add",
      path: "add",
      component: McpAddPage,
    },
    {
      key: "detail",
      path: "sources/$sourceId",
      component: McpDetailRoute,
    },
    {
      key: "edit",
      path: "sources/$sourceId/edit",
      component: McpEditRoute,
    },
  ],
});
