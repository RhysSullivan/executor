import { createSelectSchema } from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import { sourceAuthSessionsTable } from "../../persistence/schema";
import { TimestampMsSchema } from "../common";
import {
  AccountIdSchema,
  ExecutionIdSchema,
  ExecutionInteractionIdSchema,
  SourceAuthSessionIdSchema,
  SourceIdSchema,
  WorkspaceIdSchema,
} from "../ids";
import { CredentialSlotSchema } from "./credential";

export const SourceAuthSessionProviderKindSchema = Schema.Literal(
  "mcp_oauth",
  "oauth2_pkce",
);

export const SourceAuthSessionStatusSchema = Schema.Literal(
  "pending",
  "completed",
  "failed",
  "cancelled",
);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | ReadonlyArray<JsonValue>;

export type JsonObject = {
  readonly [key: string]: JsonValue;
};

export const JsonValueSchema: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.String,
    Schema.Number,
    Schema.Boolean,
    Schema.Null,
    Schema.Array(JsonValueSchema),
    Schema.Record({
      key: Schema.String,
      value: JsonValueSchema,
    }),
  )
).annotations({ identifier: "JsonValue" });

export const JsonObjectSchema = Schema.Record({
  key: Schema.String,
  value: JsonValueSchema,
}).annotations({ identifier: "JsonObject" });

export const McpSourceAuthSessionDataSchema = Schema.Struct({
  kind: Schema.Literal("mcp_oauth"),
  endpoint: Schema.String,
  redirectUri: Schema.String,
  scope: Schema.NullOr(Schema.String),
  resourceMetadataUrl: Schema.NullOr(Schema.String),
  authorizationServerUrl: Schema.NullOr(Schema.String),
  resourceMetadata: Schema.NullOr(JsonObjectSchema),
  authorizationServerMetadata: Schema.NullOr(JsonObjectSchema),
  clientInformation: Schema.NullOr(JsonObjectSchema),
  codeVerifier: Schema.NullOr(Schema.String),
  authorizationUrl: Schema.NullOr(Schema.String),
});

export const McpSourceAuthSessionDataJsonSchema = Schema.parseJson(
  McpSourceAuthSessionDataSchema,
);

const sourceAuthSessionSchemaOverrides = {
  id: SourceAuthSessionIdSchema,
  workspaceId: WorkspaceIdSchema,
  sourceId: SourceIdSchema,
  actorAccountId: Schema.NullOr(AccountIdSchema),
  credentialSlot: CredentialSlotSchema,
  executionId: Schema.NullOr(ExecutionIdSchema),
  interactionId: Schema.NullOr(ExecutionInteractionIdSchema),
  providerKind: SourceAuthSessionProviderKindSchema,
  status: SourceAuthSessionStatusSchema,
  completedAt: Schema.NullOr(TimestampMsSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

export const SourceAuthSessionSchema = createSelectSchema(
  sourceAuthSessionsTable,
  sourceAuthSessionSchemaOverrides,
);

export type SourceAuthSessionProviderKind = typeof SourceAuthSessionProviderKindSchema.Type;
export type SourceAuthSessionStatus = typeof SourceAuthSessionStatusSchema.Type;
export type McpSourceAuthSessionData = typeof McpSourceAuthSessionDataSchema.Type;
export type SourceAuthSession = typeof SourceAuthSessionSchema.Type;
