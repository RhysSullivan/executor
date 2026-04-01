import { lazy } from "react";
import type { SourcePlugin } from "@executor/react";

// ---------------------------------------------------------------------------
// OpenAPI source plugin — lazy-loaded components
// ---------------------------------------------------------------------------

export const openApiSourcePlugin: SourcePlugin = {
  key: "openapi",
  label: "OpenAPI",
  add: lazy(() => import("./AddOpenApiSource")),
  edit: lazy(() => import("./EditOpenApiSource")),
  summary: lazy(() => import("./OpenApiSourceSummary")),
};
