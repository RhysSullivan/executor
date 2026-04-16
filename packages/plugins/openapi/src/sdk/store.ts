import { Effect, Option, Schema } from "effect";

import { defineSchema, type StorageDeps } from "@executor/sdk";

import {
  HeaderValue,
  InvocationConfig,
  OAuth2Auth,
  OpenApiOAuthSession,
  OperationBinding,
} from "./types";

// ---------------------------------------------------------------------------
// Schema — three tables:
//   - openapi_source: one row per onboarded spec (baseUrl, headers, oauth2, ...)
//   - openapi_operation: one row per operation binding keyed by tool id
//   - openapi_oauth_session: transient session rows used during oauth onboarding
// ---------------------------------------------------------------------------

export const openapiSchema = defineSchema({
  openapi_source: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      spec: { type: "string", required: true },
      base_url: { type: "string", required: false },
      headers: { type: "json", required: false },
      oauth2: { type: "json", required: false },
      invocation_config: { type: "json", required: true },
    },
  },
  openapi_operation: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      binding: { type: "json", required: true },
    },
  },
  openapi_oauth_session: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      session: { type: "json", required: true },
      created_at: { type: "date", required: true },
    },
  },
});

export type OpenapiSchema = typeof openapiSchema;

// ---------------------------------------------------------------------------
// In-memory shapes
// ---------------------------------------------------------------------------

export interface SourceConfig {
  readonly spec: string;
  readonly baseUrl?: string;
  readonly namespace?: string;
  readonly headers?: Record<string, HeaderValue>;
  readonly oauth2?: OAuth2Auth;
}

export interface StoredSource {
  readonly namespace: string;
  readonly name: string;
  readonly config: SourceConfig;
  readonly invocationConfig: InvocationConfig;
}

// ---------------------------------------------------------------------------
// Schema-class mirror of StoredSource for the API layer, where we need
// an encodable/decodable shape for HTTP responses.
// ---------------------------------------------------------------------------

export class StoredSourceSchema extends Schema.Class<StoredSourceSchema>(
  "OpenApiStoredSource",
)({
  namespace: Schema.String,
  name: Schema.String,
  config: Schema.Struct({
    spec: Schema.String,
    baseUrl: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    headers: Schema.optional(
      Schema.Record({ key: Schema.String, value: HeaderValue }),
    ),
  }),
  // TODO(migration): make required once all rows have been migrated to
  // carry invocationConfig. Left optional for decode compat with rows
  // written before the source-level invocationConfig refactor.
  invocationConfig: Schema.optional(InvocationConfig),
}) {}

export type StoredSourceSchemaType = typeof StoredSourceSchema.Type;

export interface StoredOperation {
  readonly toolId: string;
  readonly sourceId: string;
  readonly binding: OperationBinding;
}

// ---------------------------------------------------------------------------
// Schema encode/decode — OperationBinding has Option fields, so we must use
// Schema.encode/decode rather than plain JSON to round-trip correctly.
// ---------------------------------------------------------------------------

const encodeBinding = Schema.encodeSync(OperationBinding);
const decodeBinding = Schema.decodeUnknownSync(OperationBinding);

const encodeInvocationConfig = Schema.encodeSync(InvocationConfig);
const decodeInvocationConfig = Schema.decodeUnknownSync(InvocationConfig);

const encodeOAuth2 = Schema.encodeSync(OAuth2Auth);
const decodeOAuth2 = Schema.decodeUnknownSync(OAuth2Auth);

const encodeOAuthSession = Schema.encodeSync(OpenApiOAuthSession);
const decodeOAuthSession = Schema.decodeUnknownSync(OpenApiOAuthSession);

const asJsonObject = (value: unknown): Record<string, unknown> => {
  if (value == null) return {};
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return value as Record<string, unknown>;
};

const decodeHeaders = (value: unknown): Record<string, HeaderValue> => {
  if (value == null) return {};
  if (typeof value === "string") return JSON.parse(value) as Record<string, HeaderValue>;
  return value as Record<string, HeaderValue>;
};

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface OpenapiStore {
  readonly upsertSource: (
    input: StoredSource,
    operations: readonly StoredOperation[],
  ) => Effect.Effect<void, Error>;

  readonly updateSourceMeta: (
    namespace: string,
    patch: {
      readonly name?: string;
      readonly baseUrl?: string;
      readonly headers?: Record<string, HeaderValue>;
      readonly oauth2?: OAuth2Auth;
    },
  ) => Effect.Effect<void, Error>;

  readonly getSource: (
    namespace: string,
  ) => Effect.Effect<StoredSource | null, Error>;

  readonly listSources: () => Effect.Effect<readonly StoredSource[], Error>;

  readonly getOperationByToolId: (
    toolId: string,
  ) => Effect.Effect<StoredOperation | null, Error>;

  readonly listOperationsBySource: (
    sourceId: string,
  ) => Effect.Effect<readonly StoredOperation[], Error>;

  readonly removeSource: (namespace: string) => Effect.Effect<void, Error>;

  readonly putOAuthSession: (
    sessionId: string,
    session: OpenApiOAuthSession,
  ) => Effect.Effect<void, Error>;

  readonly getOAuthSession: (
    sessionId: string,
  ) => Effect.Effect<OpenApiOAuthSession | null, Error>;

  readonly deleteOAuthSession: (sessionId: string) => Effect.Effect<void, Error>;
}

// ---------------------------------------------------------------------------
// Default store implementation
// ---------------------------------------------------------------------------

export const makeDefaultOpenapiStore = ({
  adapter,
}: StorageDeps<OpenapiSchema>): OpenapiStore => {
  const rowToSource = (row: Record<string, unknown>): StoredSource => {
    const oauth2Raw = row.oauth2;
    const oauth2 =
      oauth2Raw == null
        ? undefined
        : decodeOAuth2(typeof oauth2Raw === "string" ? JSON.parse(oauth2Raw) : oauth2Raw);
    const headers = decodeHeaders(row.headers);
    const invocationConfig = decodeInvocationConfig(
      asJsonObject(row.invocation_config),
    );
    return {
      namespace: row.id as string,
      name: row.name as string,
      config: {
        spec: row.spec as string,
        baseUrl: (row.base_url as string | null | undefined) ?? undefined,
        headers,
        oauth2,
      },
      invocationConfig,
    };
  };

  const rowToOperation = (row: Record<string, unknown>): StoredOperation => ({
    toolId: row.id as string,
    sourceId: row.source_id as string,
    binding: decodeBinding(
      typeof row.binding === "string" ? JSON.parse(row.binding) : row.binding,
    ),
  });

  const deleteSource = (namespace: string) =>
    Effect.gen(function* () {
      yield* adapter.deleteMany({
        model: "openapi_operation",
        where: [{ field: "source_id", value: namespace }],
      });
      yield* adapter.delete({
        model: "openapi_source",
        where: [{ field: "id", value: namespace }],
      });
    });

  return {
    upsertSource: (input, operations) =>
      Effect.gen(function* () {
        yield* deleteSource(input.namespace);
        yield* adapter.create({
          model: "openapi_source",
          data: {
            id: input.namespace,
            name: input.name,
            spec: input.config.spec,
            base_url: input.config.baseUrl ?? undefined,
            headers: (input.config.headers ?? {}) as unknown as Record<string, unknown>,
            oauth2: input.config.oauth2
              ? (encodeOAuth2(input.config.oauth2) as unknown as Record<string, unknown>)
              : undefined,
            invocation_config: encodeInvocationConfig(
              input.invocationConfig,
            ) as unknown as Record<string, unknown>,
          },
          forceAllowId: true,
        });
        if (operations.length > 0) {
          yield* adapter.createMany({
            model: "openapi_operation",
            data: operations.map((op) => ({
              id: op.toolId,
              source_id: op.sourceId,
              binding: encodeBinding(op.binding) as unknown as Record<string, unknown>,
            })),
            forceAllowId: true,
          });
        }
      }),

    updateSourceMeta: (namespace, patch) =>
      Effect.gen(function* () {
        const existingRow = yield* adapter.findOne({
          model: "openapi_source",
          where: [{ field: "id", value: namespace }],
        });
        if (!existingRow) return;
        const existing = rowToSource(existingRow);

        const nextName = patch.name?.trim() || existing.name;
        const nextBaseUrl =
          patch.baseUrl !== undefined ? patch.baseUrl : existing.config.baseUrl;
        const nextHeaders =
          patch.headers !== undefined ? patch.headers : existing.config.headers ?? {};
        const nextOAuth2 =
          patch.oauth2 !== undefined ? patch.oauth2 : existing.config.oauth2;

        const nextInvocationConfig = new InvocationConfig({
          baseUrl: nextBaseUrl ?? existing.invocationConfig.baseUrl,
          headers: nextHeaders,
          oauth2: nextOAuth2 ? Option.some(nextOAuth2) : Option.none(),
        });

        yield* adapter.update({
          model: "openapi_source",
          where: [{ field: "id", value: namespace }],
          update: {
            name: nextName,
            base_url: nextBaseUrl ?? undefined,
            headers: nextHeaders as unknown as Record<string, unknown>,
            oauth2: nextOAuth2
              ? (encodeOAuth2(nextOAuth2) as unknown as Record<string, unknown>)
              : undefined,
            invocation_config: encodeInvocationConfig(
              nextInvocationConfig,
            ) as unknown as Record<string, unknown>,
          },
        });
      }),

    getSource: (namespace) =>
      adapter
        .findOne({
          model: "openapi_source",
          where: [{ field: "id", value: namespace }],
        })
        .pipe(Effect.map((row) => (row ? rowToSource(row) : null))),

    listSources: () =>
      adapter
        .findMany({ model: "openapi_source" })
        .pipe(Effect.map((rows) => rows.map(rowToSource))),

    getOperationByToolId: (toolId) =>
      adapter
        .findOne({
          model: "openapi_operation",
          where: [{ field: "id", value: toolId }],
        })
        .pipe(Effect.map((row) => (row ? rowToOperation(row) : null))),

    listOperationsBySource: (sourceId) =>
      adapter
        .findMany({
          model: "openapi_operation",
          where: [{ field: "source_id", value: sourceId }],
        })
        .pipe(Effect.map((rows) => rows.map(rowToOperation))),

    removeSource: (namespace) => deleteSource(namespace),

    putOAuthSession: (sessionId, session) =>
      Effect.gen(function* () {
        yield* adapter.delete({
          model: "openapi_oauth_session",
          where: [{ field: "id", value: sessionId }],
        });
        yield* adapter.create({
          model: "openapi_oauth_session",
          data: {
            id: sessionId,
            session: encodeOAuthSession(session) as unknown as Record<string, unknown>,
            created_at: new Date(),
          },
          forceAllowId: true,
        });
      }),

    getOAuthSession: (sessionId) =>
      adapter
        .findOne({
          model: "openapi_oauth_session",
          where: [{ field: "id", value: sessionId }],
        })
        .pipe(
          Effect.map((row) => {
            if (!row) return null;
            const raw = row.session;
            return decodeOAuthSession(
              typeof raw === "string" ? JSON.parse(raw) : raw,
            );
          }),
        ),

    deleteOAuthSession: (sessionId) =>
      adapter
        .delete({
          model: "openapi_oauth_session",
          where: [{ field: "id", value: sessionId }],
        })
        .pipe(Effect.asVoid),
  };
};
