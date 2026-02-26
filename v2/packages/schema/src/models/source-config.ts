import { Schema } from "effect";

export const OpenApiSourceAuthModeSchema = Schema.Literal(
  "none",
  "api_key",
  "bearer",
);

export const OpenApiSourceAuthSchema = Schema.Struct({
  mode: OpenApiSourceAuthModeSchema,
  headerName: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
});

export const OpenApiSourceConfigSchema = Schema.Struct({
  type: Schema.Literal("openapi"),
  auth: Schema.optional(OpenApiSourceAuthSchema),
  staticHeaders: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
});

export type OpenApiSourceAuthMode = typeof OpenApiSourceAuthModeSchema.Type;
export type OpenApiSourceAuth = typeof OpenApiSourceAuthSchema.Type;
export type OpenApiSourceConfig = typeof OpenApiSourceConfigSchema.Type;
