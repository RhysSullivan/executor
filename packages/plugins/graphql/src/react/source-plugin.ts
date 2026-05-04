import { lazy } from "react";
import type { SourcePlugin } from "@executor-js/sdk/client";
import { graphqlPresets } from "../sdk/presets";

const importAdd = () => import("./AddGraphqlSource");
const importEdit = () => import("./EditGraphqlSource");
const importSummary = () => import("./GraphqlSourceSummary");
const importSignIn = () => import("./GraphqlSignInButton");

export const graphqlSourcePlugin: SourcePlugin = {
  key: "graphql",
  label: "GraphQL",
  add: lazy(importAdd),
  edit: lazy(importEdit),
  summary: lazy(importSummary),
  signIn: lazy(importSignIn),
  presets: graphqlPresets,
  preload: () => {
    void importAdd();
    void importEdit();
    void importSummary();
    void importSignIn();
  },
};
