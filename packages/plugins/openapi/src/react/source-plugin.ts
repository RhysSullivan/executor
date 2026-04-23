import { lazy } from "react";
import type { SourcePlugin } from "@executor/react/plugins/source-plugin";
import { openApiPresets } from "../sdk/presets";

export const openApiSourcePlugin: SourcePlugin = {
  key: "openapi",
  label: "OpenAPI",
  add: lazy(() => import("./AddOpenApiSource")),
  edit: lazy(() => import("./EditOpenApiSource")),
  summary: lazy(() => import("./OpenApiSourceSummary")),
  presets: openApiPresets,
};
