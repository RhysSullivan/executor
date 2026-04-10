import { Schema } from "effect";

import { McpStoredSourceData } from "./types";

// ---------------------------------------------------------------------------
// Stored source — the shape persisted by the binding store and exposed
// via the getSource HTTP endpoint.
// ---------------------------------------------------------------------------

export class McpStoredSourceSchema extends Schema.Class<McpStoredSourceSchema>(
  "McpStoredSource",
)({
  namespace: Schema.String,
  name: Schema.String,
  config: McpStoredSourceData,
}) {}

export type McpStoredSourceSchemaType = typeof McpStoredSourceSchema.Type;
