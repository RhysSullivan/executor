import { defineExecutorFrontendPlugin } from "@executor/react/plugins";

import {
  LocalToolsAddPage,
  LocalToolsDetailRoute,
} from "./components";

export const LocalToolsReactPlugin = defineExecutorFrontendPlugin({
  key: "local-tools",
  displayName: "Local Tools",
  description: "Inspect file-backed tools from .executor/tools as a first-class source.",
  routes: [
    {
      key: "add",
      path: "add",
      component: LocalToolsAddPage,
    },
    {
      key: "detail",
      path: "sources/$sourceId",
      component: LocalToolsDetailRoute,
    },
  ],
});
