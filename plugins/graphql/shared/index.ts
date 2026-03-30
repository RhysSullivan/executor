import * as Schema from "effect/Schema";

import {
  SecretRefSchema,
  StringMapSchema,
} from "@executor/platform-sdk/schema";
import {
  defaultNameFromEndpoint,
  namespaceFromSourceName,
} from "@executor/source-core";

export { getFaviconUrlForRemoteUrl } from "@executor/source-core";

export const GraphqlConnectionAuthSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("bearer"),
    tokenSecretRef: SecretRefSchema,
    headerName: Schema.NullOr(Schema.String),
    prefix: Schema.NullOr(Schema.String),
  }),
);

export const GraphqlConnectInputSchema = Schema.Struct({
  name: Schema.String,
  iconUrl: Schema.optional(Schema.String),
  endpoint: Schema.String,
  defaultHeaders: Schema.NullOr(StringMapSchema),
  auth: GraphqlConnectionAuthSchema,
});

export const GraphqlSourceConfigPayloadSchema = GraphqlConnectInputSchema;

export const GraphqlUpdateSourceInputSchema = Schema.Struct({
  sourceId: Schema.String,
  config: GraphqlSourceConfigPayloadSchema,
});

export const GraphqlStoredSourceDataSchema = Schema.Struct({
  endpoint: Schema.String,
  defaultHeaders: Schema.NullOr(StringMapSchema),
  auth: GraphqlConnectionAuthSchema,
});

export type GraphqlConnectionAuth = typeof GraphqlConnectionAuthSchema.Type;
export type GraphqlConnectInput = typeof GraphqlConnectInputSchema.Type;
export type GraphqlSourceConfigPayload =
  typeof GraphqlSourceConfigPayloadSchema.Type;
export type GraphqlStoredSourceData =
  typeof GraphqlStoredSourceDataSchema.Type;
export type GraphqlUpdateSourceInput =
  typeof GraphqlUpdateSourceInputSchema.Type;

export const deriveGraphqlNamespace = (input: {
  endpoint: string;
  title?: string | null;
}): string | null => {
  if (input.title && input.title.trim().length > 0) {
    return namespaceFromSourceName(input.title);
  }

  try {
    return namespaceFromSourceName(defaultNameFromEndpoint(input.endpoint));
  } catch {
    return null;
  }
};
