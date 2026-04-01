import { OpenApiClient } from "./client";

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

export const previewOpenApiSpec = OpenApiClient.mutation(
  "openapi",
  "previewSpec",
);

export const addOpenApiSpec = OpenApiClient.mutation("openapi", "addSpec");
