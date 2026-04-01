import { Schema } from "effect";
import type { JsonSchema7Root } from "effect/JSONSchema";

export class ToolRegistration extends Schema.Class<ToolRegistration>("ToolRegistration")({
  path: Schema.String,
  description: Schema.optional(Schema.String),
  sourceId: Schema.String,
  input: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
}) {}

export class SerializedCatalog extends Schema.Class<SerializedCatalog>("SerializedCatalog")({
  version: Schema.Literal("v4.1"),
  types: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  tools: Schema.Array(ToolRegistration),
}) {}

export interface LiveToolRegistration {
  readonly path: string;
  readonly description?: string;
  readonly sourceId: string;
  readonly input?: Schema.Schema.AnyNoContext;
  readonly output?: Schema.Schema.AnyNoContext;
  readonly error?: Schema.Schema.AnyNoContext;
}

export interface LiveCatalog {
  readonly version: "v4.1";
  readonly types: Record<string, JsonSchema7Root>;
  readonly tools: readonly LiveToolRegistration[];
}
