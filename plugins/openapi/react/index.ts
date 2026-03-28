import { defineExecutorFrontendPlugin } from "@executor/react/plugins";

import {
  OpenApiAddSourcePage,
  OpenApiDetailRoute,
  OpenApiEditRoute,
} from "./components";

export const OpenApiReactPlugin = defineExecutorFrontendPlugin({
  key: "openapi",
  displayName: "OpenAPI",
  routes: [
    {
      key: "add",
      path: "add",
      component: OpenApiAddSourcePage,
    },
    {
      key: "detail",
      path: "sources/$sourceId",
      component: OpenApiDetailRoute,
    },
    {
      key: "edit",
      path: "sources/$sourceId/edit",
      component: OpenApiEditRoute,
    },
  ],
});
