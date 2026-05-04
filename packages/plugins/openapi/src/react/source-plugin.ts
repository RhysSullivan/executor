import { lazy } from "react";
import type { SourcePlugin } from "@executor-js/sdk/client";
import { openApiPresets } from "../sdk/presets";

const importAdd = () => import("./AddOpenApiSource");
const importEdit = () => import("./EditOpenApiSource");
const importSummary = () => import("./OpenApiSourceSummary");

export const openApiSourcePlugin: SourcePlugin = {
  key: "openapi",
  label: "OpenAPI",
  add: lazy(importAdd),
  edit: lazy(importEdit),
  summary: lazy(importSummary),
  presets: openApiPresets,
  preload: () => {
    void importAdd();
    void importEdit();
    void importSummary();
  },
};
