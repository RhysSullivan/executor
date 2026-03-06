import {
  createSelectSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import {
  sourceCredentialBindingsTable,
  sourcesTable,
} from "../../persistence/schema";
import { TimestampMsSchema } from "../common";
import { SourceIdSchema, WorkspaceIdSchema } from "../ids";

export const SourceKindSchema = Schema.Literal(
  "mcp",
  "openapi",
  "graphql",
  "internal",
);

export const SourceStatusSchema = Schema.Literal(
  "draft",
  "probing",
  "auth_required",
  "connected",
  "error",
);

export const SourceTransportSchema = Schema.Literal(
  "auto",
  "streamable-http",
  "sse",
);

export const SecretRefSchema = Schema.Struct({
  providerId: Schema.String,
  handle: Schema.String,
});

export const SourceAuthSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("bearer"),
    headerName: Schema.String,
    prefix: Schema.String,
    token: SecretRefSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth2"),
    headerName: Schema.String,
    prefix: Schema.String,
    accessToken: SecretRefSchema,
    refreshToken: Schema.NullOr(SecretRefSchema),
  }),
);

export const StringMapSchema = Schema.Record({
  key: Schema.String,
  value: Schema.String,
});

const sourceRowSchemaOverrides = {
  workspaceId: WorkspaceIdSchema,
  sourceId: SourceIdSchema,
  kind: SourceKindSchema,
  status: SourceStatusSchema,
  transport: Schema.NullOr(SourceTransportSchema),
  authKind: Schema.Literal("none", "bearer", "oauth2"),
  authHeaderName: Schema.NullOr(Schema.String),
  authPrefix: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

const SourceStorageRowSchema = createSelectSchema(sourcesTable, sourceRowSchemaOverrides);

export const StoredSourceRecordSchema = Schema.transform(
  SourceStorageRowSchema,
  Schema.Struct({
    id: SourceIdSchema,
    workspaceId: WorkspaceIdSchema,
    name: Schema.String,
    kind: SourceKindSchema,
    endpoint: Schema.String,
    status: SourceStatusSchema,
    enabled: Schema.Boolean,
    namespace: Schema.NullOr(Schema.String),
    transport: Schema.NullOr(SourceTransportSchema),
    queryParamsJson: Schema.NullOr(Schema.String),
    headersJson: Schema.NullOr(Schema.String),
    specUrl: Schema.NullOr(Schema.String),
    defaultHeadersJson: Schema.NullOr(Schema.String),
    authKind: Schema.Literal("none", "bearer", "oauth2"),
    authHeaderName: Schema.NullOr(Schema.String),
    authPrefix: Schema.NullOr(Schema.String),
    sourceHash: Schema.NullOr(Schema.String),
    lastError: Schema.NullOr(Schema.String),
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  }),
  {
    strict: false,
    decode: (row, _input) => ({
      id: row.sourceId,
      workspaceId: row.workspaceId,
      name: row.name,
      kind: row.kind,
      endpoint: row.endpoint,
      status: row.status,
      enabled: row.enabled,
      namespace: row.namespace,
      transport: row.transport,
      queryParamsJson: row.queryParamsJson,
      headersJson: row.headersJson,
      specUrl: row.specUrl,
      defaultHeadersJson: row.defaultHeadersJson,
      authKind: row.authKind,
      authHeaderName: row.authHeaderName,
      authPrefix: row.authPrefix,
      sourceHash: row.sourceHash,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
    encode: (source, _output) => ({
      workspaceId: source.workspaceId,
      sourceId: source.id,
      name: source.name,
      kind: source.kind,
      endpoint: source.endpoint,
      status: source.status,
      enabled: source.enabled,
      namespace: source.namespace,
      transport: source.transport,
      queryParamsJson: source.queryParamsJson,
      headersJson: source.headersJson,
      specUrl: source.specUrl,
      defaultHeadersJson: source.defaultHeadersJson,
      authKind: source.authKind,
      authHeaderName: source.authHeaderName,
      authPrefix: source.authPrefix,
      sourceHash: source.sourceHash,
      lastError: source.lastError,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    }),
  },
);

const sourceCredentialBindingSchemaOverrides = {
  workspaceId: WorkspaceIdSchema,
  sourceId: SourceIdSchema,
  tokenProviderId: Schema.NullOr(Schema.String),
  tokenHandle: Schema.NullOr(Schema.String),
  refreshTokenProviderId: Schema.NullOr(Schema.String),
  refreshTokenHandle: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

export const SourceCredentialBindingSchema = createSelectSchema(
  sourceCredentialBindingsTable,
  sourceCredentialBindingSchemaOverrides,
);

export const SourceSchema = Schema.Struct({
  id: SourceIdSchema,
  workspaceId: WorkspaceIdSchema,
  name: Schema.String,
  kind: SourceKindSchema,
  endpoint: Schema.String,
  status: SourceStatusSchema,
  enabled: Schema.Boolean,
  namespace: Schema.NullOr(Schema.String),
  transport: Schema.NullOr(SourceTransportSchema),
  queryParams: Schema.NullOr(StringMapSchema),
  headers: Schema.NullOr(StringMapSchema),
  specUrl: Schema.NullOr(Schema.String),
  defaultHeaders: Schema.NullOr(StringMapSchema),
  auth: SourceAuthSchema,
  sourceHash: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type SourceKind = typeof SourceKindSchema.Type;
export type SourceStatus = typeof SourceStatusSchema.Type;
export type SourceTransport = typeof SourceTransportSchema.Type;
export type SecretRef = typeof SecretRefSchema.Type;
export type SourceAuth = typeof SourceAuthSchema.Type;
export type StoredSourceRecord = typeof StoredSourceRecordSchema.Type;
export type SourceCredentialBinding = typeof SourceCredentialBindingSchema.Type;
export type StringMap = typeof StringMapSchema.Type;
export type Source = typeof SourceSchema.Type;
