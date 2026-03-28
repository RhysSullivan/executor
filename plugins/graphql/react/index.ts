import { defineExecutorFrontendPlugin } from "@executor/react/plugins";

import {
  GraphqlAddPage,
  GraphqlDetailRoute,
  GraphqlEditRoute,
  GraphqlToolDetailRoute,
} from "./components";

export const GraphqlReactPlugin = defineExecutorFrontendPlugin({
  key: "graphql",
  displayName: "GraphQL",
  description: "Introspect a GraphQL endpoint into typed query and mutation tools.",
  routes: [
    {
      key: "add",
      path: "add",
      component: GraphqlAddPage,
    },
    {
      key: "detail",
      path: "sources/$sourceId",
      component: GraphqlDetailRoute,
    },
    {
      key: "edit",
      path: "sources/$sourceId/edit",
      component: GraphqlEditRoute,
    },
    {
      key: "tool-detail",
      path: "sources/$sourceId/tool/$toolPath",
      component: GraphqlToolDetailRoute,
    },
  ],
});
