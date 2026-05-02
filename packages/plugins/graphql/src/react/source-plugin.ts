import { lazy } from "react";
import type { SourcePlugin } from "@executor-js/sdk/client";
import { graphqlPresets } from "../sdk/presets";

export const graphqlSourcePlugin: SourcePlugin = {
  key: "graphql",
  label: "GraphQL",
  add: lazy(() => import("./AddGraphqlSource")),
  edit: lazy(() => import("./EditGraphqlSource")),
  summary: lazy(() => import("./GraphqlSourceSummary")),
  signIn: lazy(() => import("./GraphqlSignInButton")),
  presets: graphqlPresets,
};
