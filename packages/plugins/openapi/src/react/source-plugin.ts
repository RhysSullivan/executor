import { lazy } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";
import { openApiPresets } from "../sdk/presets";

const importAdd = () => import("./AddOpenApiSource");
const importEdit = () => import("./EditOpenApiSource");
const importSummary = () => import("./OpenApiSourceSummary");
const importAccounts = () => import("./OpenApiAccountsPanel");

export const openApiIntegrationPlugin: IntegrationPlugin = {
  key: "openapi",
  label: "OpenAPI",
  add: lazy(importAdd),
  edit: lazy(importEdit),
  summary: lazy(importSummary),
  accounts: lazy(importAccounts),
  presets: openApiPresets,
  preload: () => {
    void importAdd();
    void importEdit();
    void importSummary();
    void importAccounts();
  },
};
