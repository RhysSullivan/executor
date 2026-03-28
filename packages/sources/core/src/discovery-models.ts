import * as Schema from "effect/Schema";

import {
  StringMapSchema,
  SourceTransportSchema,
} from "./source-models";

export const SourceDiscoveryKindSchema = Schema.Literal(
  "plugin",
  "unknown",
);

export const SourceDiscoveryConfidenceSchema = Schema.Literal(
  "low",
  "medium",
  "high",
);

export const SourceDiscoveryAuthKindSchema = Schema.Literal(
  "none",
  "bearer",
  "oauth2",
  "apiKey",
  "basic",
  "unknown",
);

export const SourceDiscoveryAuthParameterLocationSchema = Schema.Literal(
  "header",
  "query",
  "cookie",
);

export const SourceProbeAuthSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("bearer"),
    headerName: Schema.optional(Schema.NullOr(Schema.String)),
    prefix: Schema.optional(Schema.NullOr(Schema.String)),
    token: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("basic"),
    username: Schema.String,
    password: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("headers"),
    headers: StringMapSchema,
  }),
);

export const SourceAuthInferenceSchema = Schema.Struct({
  suggestedKind: SourceDiscoveryAuthKindSchema,
  confidence: SourceDiscoveryConfidenceSchema,
  supported: Schema.Boolean,
  reason: Schema.String,
  headerName: Schema.NullOr(Schema.String),
  prefix: Schema.NullOr(Schema.String),
  parameterName: Schema.NullOr(Schema.String),
  parameterLocation: Schema.NullOr(SourceDiscoveryAuthParameterLocationSchema),
  oauthAuthorizationUrl: Schema.NullOr(Schema.String),
  oauthTokenUrl: Schema.NullOr(Schema.String),
  oauthScopes: Schema.Array(Schema.String),
});

export const SourceDiscoveryResultSchema = Schema.Struct({
  detectedKind: SourceDiscoveryKindSchema,
  confidence: SourceDiscoveryConfidenceSchema,
  endpoint: Schema.String,
  specUrl: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  namespace: Schema.NullOr(Schema.String),
  transport: Schema.NullOr(SourceTransportSchema),
  authInference: SourceAuthInferenceSchema,
  toolCount: Schema.NullOr(Schema.Number),
  warnings: Schema.Array(Schema.String),
});

export type SourceDiscoveryKind = typeof SourceDiscoveryKindSchema.Type;
export type SourceDiscoveryConfidence = typeof SourceDiscoveryConfidenceSchema.Type;
export type SourceDiscoveryAuthKind = typeof SourceDiscoveryAuthKindSchema.Type;
export type SourceDiscoveryAuthParameterLocation =
  typeof SourceDiscoveryAuthParameterLocationSchema.Type;
export type SourceProbeAuth = typeof SourceProbeAuthSchema.Type;
export type SourceAuthInference = typeof SourceAuthInferenceSchema.Type;
export type SourceDiscoveryResult = typeof SourceDiscoveryResultSchema.Type;
