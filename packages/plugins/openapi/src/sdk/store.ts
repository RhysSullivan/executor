import { Effect, Schema } from "effect";

import {
  defineSchema,
  ScopeId,
  StorageError,
  type StorageDeps,
  type StorageFailure,
} from "@executor/sdk";

import {
  ConfiguredHeaderValue,
  ConfiguredHeaderBinding,
  HeaderValue,
  OAuth2Auth,
  OAuth2SourceConfig,
  OpenApiOAuthSession,
  OpenApiSourceBindingInput,
  OpenApiSourceBindingRef,
  OpenApiSourceBindingValue,
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
  openapi_source_binding: {
    fields: {
      id: { type: "string", required: true },
      source_id: { type: "string", required: true, index: true },
      source_scope_id: { type: "string", required: true, index: true },
      // Intentionally NOT named `scope_id`: this row is visible across
      // scope stacks and is filtered manually by source/target scope.
      // The target scope is credential ownership data, not adapter row
      // ownership. Source owners must be able to delete all descendant
      // bindings when a shared source is removed.
      target_scope_id: { type: "string", required: true, index: true },
      slot: { type: "string", required: true, index: true },
      value: { type: "json", required: true },
      created_at: { type: "date", required: true },
      updated_at: { type: "date", required: true },
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
  readonly headers?: Record<string, ConfiguredHeaderValue>;
  readonly oauth2?: OAuth2SourceConfig;
}

export interface StoredSource {
  readonly namespace: string;
  /** Executor scope id this source row lives in. Writes stamp this on
   *  `scope_id`; reads return whichever scope's row the adapter's
   *  fall-through filter sees first. */
  readonly scope: string;
  readonly name: string;
  readonly config: SourceConfig;
  readonly legacy?: {
    readonly headers?: Record<string, HeaderValue>;
    readonly oauth2?: OAuth2Auth;
  };
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
      Schema.Record({ key: Schema.String, value: ConfiguredHeaderValue }),
    ),
    // Canonical source-owned OAuth config. Concrete client credentials
    // and connection ids live in OpenAPI-owned scoped binding rows.
    oauth2: Schema.optional(OAuth2SourceConfig),
  }),
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

const decodeOAuth2 = Schema.decodeUnknownSync(OAuth2Auth);
const encodeOAuth2SourceConfig = Schema.encodeSync(OAuth2SourceConfig);
const encodeSourceBindingValue = Schema.encodeSync(OpenApiSourceBindingValue);
const decodeSourceBindingValue = Schema.decodeUnknownSync(OpenApiSourceBindingValue);

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

const slugifySlotPart = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";

export const headerBindingSlot = (headerName: string): string =>
  `header:${slugifySlotPart(headerName)}`;

export const oauth2ClientIdSlot = (securitySchemeName: string): string =>
  `oauth2:${slugifySlotPart(securitySchemeName)}:client-id`;

export const oauth2ClientSecretSlot = (securitySchemeName: string): string =>
  `oauth2:${slugifySlotPart(securitySchemeName)}:client-secret`;

export const oauth2ConnectionSlot = (securitySchemeName: string): string =>
  `oauth2:${slugifySlotPart(securitySchemeName)}:connection`;

const normalizeStoredHeaders = (
  value: unknown,
): {
  readonly headers: Record<string, ConfiguredHeaderValue>;
  readonly legacy: Record<string, HeaderValue>;
} => {
  const raw = decodeHeaders(value);
  const headers: Record<string, ConfiguredHeaderValue> = {};
  const legacy: Record<string, HeaderValue> = {};
  for (const [name, header] of Object.entries(raw)) {
    if (typeof header === "string") {
      headers[name] = header;
      legacy[name] = header;
      continue;
    }
    if (
      header &&
      typeof header === "object" &&
      "kind" in header &&
      (header as { kind?: unknown }).kind === "binding"
    ) {
      headers[name] = header as unknown as ConfiguredHeaderValue;
      continue;
    }
    legacy[name] = header;
    headers[name] = new ConfiguredHeaderBinding({
      kind: "binding",
      slot: headerBindingSlot(name),
      prefix: header.prefix,
    });
  }
  return { headers, legacy };
};

const normalizeStoredOAuth2 = (
  value: unknown,
): {
  readonly oauth2?: OAuth2SourceConfig;
  readonly legacy?: OAuth2Auth;
} => {
  if (value == null) return {};
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed && typeof parsed === "object" && "connectionSlot" in parsed) {
    return {
      oauth2: Schema.decodeUnknownSync(OAuth2SourceConfig)(parsed),
    };
  }
  const legacy = decodeOAuth2(parsed);
  return {
    legacy,
    oauth2: new OAuth2SourceConfig({
      kind: "oauth2",
      securitySchemeName: legacy.securitySchemeName,
      flow: legacy.flow,
      tokenUrl: legacy.tokenUrl,
      authorizationUrl: legacy.authorizationUrl,
      clientIdSlot: oauth2ClientIdSlot(legacy.securitySchemeName),
      clientSecretSlot: legacy.clientSecretSecretId
        ? oauth2ClientSecretSlot(legacy.securitySchemeName)
        : null,
      connectionSlot: oauth2ConnectionSlot(legacy.securitySchemeName),
      scopes: [...legacy.scopes],
    }),
  };
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
      readonly headers?: Record<string, ConfiguredHeaderValue>;
      readonly oauth2?: OAuth2SourceConfig;
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

  readonly listSourceBindings: (
    sourceId: string,
    sourceScope: string,
  ) => Effect.Effect<readonly OpenApiSourceBindingRef[], StorageFailure>;

  readonly resolveSourceBinding: (
    sourceId: string,
    sourceScope: string,
    slot: string,
  ) => Effect.Effect<OpenApiSourceBindingRef | null, StorageFailure>;

  readonly setSourceBinding: (
    input: OpenApiSourceBindingInput,
  ) => Effect.Effect<OpenApiSourceBindingRef, StorageFailure>;

  readonly removeSourceBinding: (
    sourceId: string,
    sourceScope: string,
    slot: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;
}

// ---------------------------------------------------------------------------
// Default store implementation
// ---------------------------------------------------------------------------

export const makeDefaultOpenapiStore = ({
  adapter,
  scopes,
}: StorageDeps<OpenapiSchema>): OpenapiStore => {
  const scopeIds = scopes.map((scope) => scope.id as string);
  const scopePrecedence = new Map<string, number>();
  scopeIds.forEach((scope, index) => scopePrecedence.set(scope, index));
  const scopeRank = (scopeId: string): number =>
    scopePrecedence.get(scopeId) ?? Infinity;

  const encodeSyntheticRowIdPart = (value: string): string =>
    encodeURIComponent(value);

  const sourceBindingRowId = (
    sourceId: string,
    sourceScopeId: string,
    slot: string,
    scopeId: string,
  ) =>
    [
      "openapi-source-binding",
      encodeSyntheticRowIdPart(sourceScopeId),
      encodeSyntheticRowIdPart(sourceId),
      encodeSyntheticRowIdPart(slot),
      encodeSyntheticRowIdPart(scopeId),
    ].join("::");

  const rowToSourceBinding = (
    row: Record<string, unknown>,
  ): OpenApiSourceBindingRef =>
    new OpenApiSourceBindingRef({
      sourceId: row.source_id as string,
      sourceScopeId: ScopeId.make(row.source_scope_id as string),
      scopeId: ScopeId.make(row.target_scope_id as string),
      slot: row.slot as string,
      value: decodeSourceBindingValue(asJsonObject(row.value)),
      createdAt:
        row.created_at instanceof Date
          ? row.created_at
          : new Date(row.created_at as string),
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at
          : new Date(row.updated_at as string),
    });

  const validateBindingTarget = (params: {
    readonly sourceId: string;
    readonly sourceScope: string;
    readonly targetScope: string;
  }) =>
    Effect.gen(function* () {
      if (!scopeIds.includes(params.sourceScope)) {
        return yield* Effect.fail(
          new StorageError({
            message:
              `OpenAPI source binding references source scope "${params.sourceScope}" ` +
              `which is not in the executor's scope stack [${scopeIds.join(", ")}].`,
            cause: undefined,
          }),
        );
      }
      if (!scopeIds.includes(params.targetScope)) {
        return yield* Effect.fail(
          new StorageError({
            message:
              `OpenAPI source binding targets scope "${params.targetScope}" which is not ` +
              `in the executor's scope stack [${scopeIds.join(", ")}].`,
            cause: undefined,
          }),
        );
      }
      const source = yield* adapter.findOne({
        model: "openapi_source",
        where: [
          { field: "id", value: params.sourceId },
          { field: "scope_id", value: params.sourceScope },
        ],
      });
      if (!source) {
        return yield* Effect.fail(
          new StorageError({
            message: `OpenAPI source "${params.sourceId}" does not exist at scope "${params.sourceScope}"`,
            cause: undefined,
          }),
        );
      }
      if (scopeRank(params.targetScope) > scopeRank(params.sourceScope)) {
        return yield* Effect.fail(
          new StorageError({
            message:
              `OpenAPI source bindings for "${params.sourceId}" cannot be written at ` +
              `outer scope "${params.targetScope}" because the base source lives at ` +
              `"${params.sourceScope}"`,
            cause: undefined,
          }),
        );
      }
      return source;
    });

  const rowToSource = (row: Record<string, unknown>): StoredSource => {
    const normalizedHeaders = normalizeStoredHeaders(row.headers);
    const normalizedOAuth2 = normalizeStoredOAuth2(row.oauth2);
    return {
      namespace: row.id as string,
      scope: row.scope_id as string,
      name: row.name as string,
      config: {
        spec: row.spec as string,
        sourceUrl: (row.source_url as string | null | undefined) ?? undefined,
        baseUrl: (row.base_url as string | null | undefined) ?? undefined,
        headers: normalizedHeaders.headers,
        oauth2: normalizedOAuth2.oauth2,
      },
      legacy:
        Object.keys(normalizedHeaders.legacy).length > 0 || normalizedOAuth2.legacy
          ? {
              ...(Object.keys(normalizedHeaders.legacy).length > 0
                ? { headers: normalizedHeaders.legacy }
                : {}),
              ...(normalizedOAuth2.legacy ? { oauth2: normalizedOAuth2.legacy } : {}),
            }
          : undefined,
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
      yield* adapter.deleteMany({
        model: "openapi_source_binding",
        where: [
          { field: "source_id", value: namespace },
          { field: "source_scope_id", value: scope },
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
            headers: Object.fromEntries(
              Object.entries(input.config.headers ?? {}).map(([name, value]) => [
                name,
                typeof value === "string"
                  ? value
                  : (value.kind === "binding"
                    ? {
                        kind: value.kind,
                        slot: value.slot,
                        ...(value.prefix ? { prefix: value.prefix } : {}),
                      }
                    : value),
              ]),
            ) as Record<string, unknown>,
            oauth2: input.config.oauth2
              ? (encodeOAuth2SourceConfig(input.config.oauth2) as unknown as Record<string, unknown>)
              : undefined,
            invocation_config: {},
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

        yield* adapter.update({
          model: "openapi_source",
          where: [
            { field: "id", value: namespace },
            { field: "scope_id", value: scope },
          ],
          update: {
            name: nextName,
            base_url: nextBaseUrl ?? undefined,
            headers: Object.fromEntries(
              Object.entries(nextHeaders).map(([name, value]) => [
                name,
                typeof value === "string"
                  ? value
                  : {
                      kind: value.kind,
                      slot: value.slot,
                      ...(value.prefix ? { prefix: value.prefix } : {}),
                    },
              ]),
            ) as Record<string, unknown>,
            oauth2: nextOAuth2
              ? (encodeOAuth2SourceConfig(nextOAuth2) as unknown as Record<string, unknown>)
              : undefined,
            invocation_config: asJsonObject(existingRow.invocation_config),
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

    listSourceBindings: (sourceId, sourceScope) =>
      Effect.gen(function* () {
        yield* validateBindingTarget({
          sourceId,
          sourceScope,
          targetScope: sourceScope,
        });
        const sourceScopeRank = scopeRank(sourceScope);
        const rows = yield* adapter.findMany({
          model: "openapi_source_binding",
          where: [
            { field: "source_id", value: sourceId },
            { field: "source_scope_id", value: sourceScope },
          ],
        });
        return rows
          .filter((row) => scopeRank(row.target_scope_id as string) <= sourceScopeRank)
          .sort(
            (a, b) =>
              scopeRank(a.target_scope_id as string) -
              scopeRank(b.target_scope_id as string),
          )
          .map(rowToSourceBinding);
      }),

    resolveSourceBinding: (sourceId, sourceScope, slot) =>
      Effect.gen(function* () {
        yield* validateBindingTarget({
          sourceId,
          sourceScope,
          targetScope: sourceScope,
        });
        const rows = yield* adapter.findMany({
          model: "openapi_source_binding",
          where: [
            { field: "source_id", value: sourceId },
            { field: "source_scope_id", value: sourceScope },
            { field: "slot", value: slot },
          ],
        });
        const sourceScopeRank = scopeRank(sourceScope);
        const row = rows
          .filter(
            (candidate) =>
              scopeRank(candidate.target_scope_id as string) <= sourceScopeRank,
          )
          .sort(
            (a, b) =>
              scopeRank(a.target_scope_id as string) -
              scopeRank(b.target_scope_id as string),
          )[0];
        return row ? rowToSourceBinding(row) : null;
      }),

    setSourceBinding: (input) =>
      Effect.gen(function* () {
        yield* validateBindingTarget({
          sourceId: input.sourceId,
          sourceScope: input.sourceScope as string,
          targetScope: input.scope as string,
        });
        const id = sourceBindingRowId(
          input.sourceId,
          input.sourceScope as string,
          input.slot,
          input.scope as string,
        );
        const now = new Date();
        yield* adapter.delete({
          model: "openapi_source_binding",
          where: [{ field: "id", value: id }],
        });
        yield* adapter.create({
          model: "openapi_source_binding",
          data: {
            id,
            source_id: input.sourceId,
            source_scope_id: input.sourceScope as string,
            target_scope_id: input.scope as string,
            slot: input.slot,
            value: encodeSourceBindingValue(input.value) as unknown as Record<string, unknown>,
            created_at: now,
            updated_at: now,
          },
          forceAllowId: true,
        });
        return new OpenApiSourceBindingRef({
          sourceId: input.sourceId,
          sourceScopeId: input.sourceScope,
          scopeId: input.scope,
          slot: input.slot,
          value: input.value,
          createdAt: now,
          updatedAt: now,
        });
      }),

    removeSourceBinding: (sourceId, sourceScope, slot, scope) =>
      Effect.gen(function* () {
        yield* validateBindingTarget({
          sourceId,
          sourceScope,
          targetScope: scope,
        });
        yield* adapter.delete({
          model: "openapi_source_binding",
          where: [
            {
              field: "id",
              value: sourceBindingRowId(sourceId, sourceScope, slot, scope),
            },
          ],
        });
      }),
  };
};
