import { Effect, Option, Schema } from "effect";

import {
  defineSchema,
  type StorageDeps,
  type StorageFailure,
} from "@executor/sdk";

import {
  AnnotationPolicy,
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
      // Origin URL the spec was fetched from. Set when `addSpec` was
      // invoked with an http(s) URL; null when the caller passed raw
      // spec text. Drives `canRefresh` on the core source row and
      // is the address re-fetched on `refreshSource`.
      source_url: { type: "string", required: false },
      base_url: { type: "string", required: false },
      headers: { type: "json", required: false },
      oauth2: { type: "json", required: false },
      annotation_policy: { type: "json", required: false },
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
  /** Origin URL when the spec was fetched from http(s). Absent for
   *  raw-text adds. Persisted so `refreshSource` can re-fetch. */
  readonly sourceUrl?: string;
  readonly baseUrl?: string;
  readonly namespace?: string;
  readonly headers?: Record<string, HeaderValue>;
  readonly oauth2?: OAuth2Auth;
  readonly annotationPolicy?: AnnotationPolicy;
}

export interface StoredSource {
  readonly namespace: string;
  /** Executor scope id this source row lives in. Writes stamp this on
   *  `scope_id`; reads return whichever scope's row the adapter's
   *  fall-through filter sees first. */
  readonly scope: string;
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
    sourceUrl: Schema.optional(Schema.String),
    baseUrl: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    headers: Schema.optional(
      Schema.Record({ key: Schema.String, value: HeaderValue }),
    ),
    // Exposed so the UI can render a per-user "Connections" pane for
    // sources onboarded with an OAuth2 preset — one OAuth2Auth per
    // securitySchemeName, with the secret ids that back its tokens.
    oauth2: Schema.optional(OAuth2Auth),
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

// Every method routes through the typed adapter (`ctx.storage.adapter`)
// so the typed error channel is `StorageFailure`. Schema-decode failures
// inside `Effect.gen` land as defects, not typed errors, and are caught
// by the HTTP edge's observability middleware.
//
// Every read/write that targets a single row pins BOTH the natural id
// (namespace, toolId, sessionId) AND the owning `scope_id`. The store
// runs behind the scoped adapter (which auto-injects `scope_id IN
// (stack)`), so a bare `{id}` filter resolves to any matching row in
// the stack in adapter-iteration order. For shadowed rows (same id at
// multiple scopes — e.g. an org-level openapi source with a per-user
// override), that's a scope-isolation bug: updates and deletes can
// land on the wrong scope's row. Callers thread the resolved scope in
// (typically `path.scopeId` for HTTP, `toolRow.scope_id` /
// `input.scope` for invokeTool/lifecycle) so every keyed mutation
// targets exactly one row.
export interface OpenapiStore {
  readonly upsertSource: (
    input: StoredSource,
    operations: readonly StoredOperation[],
  ) => Effect.Effect<void, StorageFailure>;

  readonly updateSourceMeta: (
    namespace: string,
    scope: string,
    patch: {
      readonly name?: string;
      readonly baseUrl?: string;
      readonly headers?: Record<string, HeaderValue>;
      readonly oauth2?: OAuth2Auth;
    },
  ) => Effect.Effect<void, StorageFailure>;

  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<StoredSource | null, StorageFailure>;

  readonly listSources: () => Effect.Effect<readonly StoredSource[], StorageFailure>;

  readonly getOperationByToolId: (
    toolId: string,
    scope: string,
  ) => Effect.Effect<StoredOperation | null, StorageFailure>;

  readonly listOperationsBySource: (
    sourceId: string,
    scope: string,
  ) => Effect.Effect<readonly StoredOperation[], StorageFailure>;

  readonly removeSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;

  readonly putOAuthSession: (
    sessionId: string,
    session: OpenApiOAuthSession,
  ) => Effect.Effect<void, StorageFailure>;

  readonly getOAuthSession: (
    sessionId: string,
  ) => Effect.Effect<OpenApiOAuthSession | null, StorageFailure>;

  readonly deleteOAuthSession: (sessionId: string) => Effect.Effect<void, StorageFailure>;
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
      scope: row.scope_id as string,
      name: row.name as string,
      config: {
        spec: row.spec as string,
        sourceUrl: (row.source_url as string | null | undefined) ?? undefined,
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

  const deleteSource = (namespace: string, scope: string) =>
    Effect.gen(function* () {
      yield* adapter.deleteMany({
        model: "openapi_operation",
        where: [
          { field: "source_id", value: namespace },
          { field: "scope_id", value: scope },
        ],
      });
      yield* adapter.delete({
        model: "openapi_source",
        where: [
          { field: "id", value: namespace },
          { field: "scope_id", value: scope },
        ],
      });
    });

  return {
    upsertSource: (input, operations) =>
      Effect.gen(function* () {
        yield* deleteSource(input.namespace, input.scope);
        yield* adapter.create({
          model: "openapi_source",
          data: {
            id: input.namespace,
            scope_id: input.scope,
            name: input.name,
            spec: input.config.spec,
            source_url: input.config.sourceUrl ?? undefined,
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
              scope_id: input.scope,
              source_id: op.sourceId,
              binding: encodeBinding(op.binding) as unknown as Record<string, unknown>,
            })),
            forceAllowId: true,
          });
        }
      }),

    updateSourceMeta: (namespace, scope, patch) =>
      Effect.gen(function* () {
        const existingRow = yield* adapter.findOne({
          model: "openapi_source",
          where: [
            { field: "id", value: namespace },
            { field: "scope_id", value: scope },
          ],
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
          where: [
            { field: "id", value: namespace },
            { field: "scope_id", value: scope },
          ],
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

    getSource: (namespace, scope) =>
      adapter
        .findOne({
          model: "openapi_source",
          where: [
            { field: "id", value: namespace },
            { field: "scope_id", value: scope },
          ],
        })
        .pipe(Effect.map((row) => (row ? rowToSource(row) : null))),

    listSources: () =>
      adapter
        .findMany({ model: "openapi_source" })
        .pipe(Effect.map((rows) => rows.map(rowToSource))),

    getOperationByToolId: (toolId, scope) =>
      adapter
        .findOne({
          model: "openapi_operation",
          where: [
            { field: "id", value: toolId },
            { field: "scope_id", value: scope },
          ],
        })
        .pipe(Effect.map((row) => (row ? rowToOperation(row) : null))),

    listOperationsBySource: (sourceId, scope) =>
      adapter
        .findMany({
          model: "openapi_operation",
          where: [
            { field: "source_id", value: sourceId },
            { field: "scope_id", value: scope },
          ],
        })
        .pipe(Effect.map((rows) => rows.map(rowToOperation))),

    removeSource: (namespace, scope) => deleteSource(namespace, scope),

    putOAuthSession: (sessionId, session) =>
      Effect.gen(function* () {
        // Defensive overwrite — sessionIds are UUIDs so collisions are
        // negligible, but pin to the target scope so a hypothetical
        // collision with a session in another scope of this stack
        // can't wipe the wrong row.
        yield* adapter.delete({
          model: "openapi_oauth_session",
          where: [
            { field: "id", value: sessionId },
            { field: "scope_id", value: session.tokenScope },
          ],
        });
        yield* adapter.create({
          model: "openapi_oauth_session",
          data: {
            id: sessionId,
            // Session row lives at the same scope the completed tokens
            // will land in — keeps in-flight sessions visible only to
            // the executor that started them (user stacks can see
            // their own sessions but not another user's).
            scope_id: session.tokenScope,
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
