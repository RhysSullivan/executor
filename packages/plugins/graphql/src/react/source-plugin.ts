import { lazy } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";
import { graphqlPresets } from "../sdk/presets";

const importAdd = () => import("./AddGraphqlSource");
const importEdit = () => import("./EditGraphqlSource");
const importSummary = () => import("./GraphqlSourceSummary");
const importAccounts = () => import("./GraphqlAccountsPanel");

export const graphqlIntegrationPlugin: IntegrationPlugin = {
  key: "graphql",
  label: "GraphQL",
  add: lazy(importAdd),
  edit: lazy(importEdit),
  summary: lazy(importSummary),
  accounts: lazy(importAccounts),
  presets: graphqlPresets,
  preload: () => {
    void importAdd();
    void importEdit();
    void importSummary();
    void importAccounts();
  },
};
