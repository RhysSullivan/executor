import { Schema } from "effect";
import { ScopeId } from "@executor-js/sdk/core";

import { McpStoredSourceData } from "./types";

// ---------------------------------------------------------------------------
// Stored source — the shape persisted by the binding store and exposed
// via the getSource HTTP endpoint.
// ---------------------------------------------------------------------------

export const McpStoredSourceSchema = Schema.Struct({
  namespace: Schema.String,
  scope: ScopeId,
  name: Schema.String,
  config: McpStoredSourceData,
}).annotate({ identifier: "McpStoredSource" });
export type McpStoredSourceSchema = typeof McpStoredSourceSchema.Type;

export type McpStoredSourceSchemaType = typeof McpStoredSourceSchema.Type;
