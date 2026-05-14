import { Effect, Option, Schema } from "effect";

import {
  defineSchema,
  jsonColumn,
  nullableJsonColumn,
  nullableTextColumn,
  scopedExecutorTable,
  type AnyColumn,
  type Condition,
  type ConditionBuilder,
  type StorageDeps,
  type StorageFailure,
  textColumn,
} from "@executor-js/sdk/core";

import {
  ConfiguredHeaderValue,
  ConfiguredHeaderBinding,
  OAuth2SourceConfig,
  OperationBinding,
} from "./types";

// ---------------------------------------------------------------------------
// Schema:
//   - openapi_source: one row per onboarded spec (baseUrl, oauth2, ...)
//   - openapi_operation: one row per operation binding keyed by tool id
// ---------------------------------------------------------------------------

// Each of the source-owned credential-structure child tables (`openapi_source_header`,
// `openapi_source_query_param`,
// `openapi_source_spec_fetch_header`,
// `openapi_source_spec_fetch_query_param`) shares the same column shape:
// id/scope_id/source_id/name plus a `kind` enum that discriminates a
// literal text value from a credential slot binding (with optional prefix).
// The fields are inlined per-table because `defineSchema`'s type
// narrowing relies on the literal types staying on the original
// declaration site.

export const openapiSchema = defineSchema({
  openapi_source: scopedExecutorTable("openapi_source", {
    name: textColumn("name"),
    spec: textColumn("spec"),
    // Origin URL the spec was fetched from. Set when `addSpec` was
    // invoked with an http(s) URL; null when the caller passed raw
    // spec text. Drives `canRefresh` on the core source row and
    // is the address re-fetched on `refreshSource`.
    source_url: nullableTextColumn("source_url"),
    base_url: nullableTextColumn("base_url"),
    // OAuth2 stays JSON because it is one typed source-owned config object
    // carrying slot names, not concrete secret/connection ids.
    oauth2: nullableJsonColumn("oauth2"),
  }),
  openapi_operation: scopedExecutorTable("openapi_operation", {
    source_id: textColumn("source_id"),
    binding: jsonColumn("binding"),
  }),
  openapi_source_header: scopedExecutorTable("openapi_source_header", {
    source_id: textColumn("source_id"),
    name: textColumn("name"),
    kind: textColumn("kind"),
    text_value: nullableTextColumn("text_value"),
    slot_key: nullableTextColumn("slot_key"),
    prefix: nullableTextColumn("prefix"),
  }),
  openapi_source_query_param: scopedExecutorTable("openapi_source_query_param", {
    source_id: textColumn("source_id"),
    name: textColumn("name"),
    kind: textColumn("kind"),
    text_value: nullableTextColumn("text_value"),
    slot_key: nullableTextColumn("slot_key"),
    prefix: nullableTextColumn("prefix"),
  }),
  openapi_source_spec_fetch_header: scopedExecutorTable("openapi_source_spec_fetch_header", {
    source_id: textColumn("source_id"),
    name: textColumn("name"),
    kind: textColumn("kind"),
    text_value: nullableTextColumn("text_value"),
    slot_key: nullableTextColumn("slot_key"),
    prefix: nullableTextColumn("prefix"),
  }),
  openapi_source_spec_fetch_query_param: scopedExecutorTable(
    "openapi_source_spec_fetch_query_param",
    {
      source_id: textColumn("source_id"),
      name: textColumn("name"),
      kind: textColumn("kind"),
      text_value: nullableTextColumn("text_value"),
      slot_key: nullableTextColumn("slot_key"),
      prefix: nullableTextColumn("prefix"),
    },
  ),
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
  readonly queryParams?: Record<string, ConfiguredHeaderValue>;
  readonly specFetchCredentials?: OpenApiSpecFetchCredentials;
  readonly oauth2?: OAuth2SourceConfig;
}

export interface OpenApiSpecFetchCredentials {
  readonly headers?: Record<string, ConfiguredHeaderValue>;
  readonly queryParams?: Record<string, ConfiguredHeaderValue>;
}

export interface StoredSource {
  readonly namespace: string;
  /** Executor scope id this source row lives in. Writes stamp this on
   *  `scope_id`; reads choose scope explicitly in the FumaDB query. */
  readonly scope: string;
  readonly name: string;
  readonly config: SourceConfig;
}

// ---------------------------------------------------------------------------
// Schema-class mirror of StoredSource for the API layer, where we need
// an encodable/decodable shape for HTTP responses.
// ---------------------------------------------------------------------------

export const StoredSourceSchema = Schema.Struct({
  namespace: Schema.String,
  scope: Schema.String,
  name: Schema.String,
  config: Schema.Struct({
    spec: Schema.String,
    sourceUrl: Schema.optional(Schema.String),
    baseUrl: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    headers: Schema.optional(Schema.Record(Schema.String, ConfiguredHeaderValue)),
    queryParams: Schema.optional(Schema.Record(Schema.String, ConfiguredHeaderValue)),
    specFetchCredentials: Schema.optional(
      Schema.Struct({
        headers: Schema.optional(Schema.Record(Schema.String, ConfiguredHeaderValue)),
        queryParams: Schema.optional(Schema.Record(Schema.String, ConfiguredHeaderValue)),
      }),
    ),
    // Canonical source-owned OAuth config. Concrete client credentials
    // and connection ids live in OpenAPI-owned scoped binding rows.
    oauth2: Schema.optional(OAuth2SourceConfig),
  }),
}).annotate({ identifier: "OpenApiStoredSource" });
export type StoredSourceSchema = typeof StoredSourceSchema.Type;

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
const decodeBindingJson = Schema.decodeUnknownSync(Schema.fromJsonString(OperationBinding));

const decodeOAuth2SourceConfigOption = Schema.decodeUnknownOption(OAuth2SourceConfig);
const decodeOAuth2SourceConfigJsonOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(OAuth2SourceConfig),
);
const encodeOAuth2SourceConfig = Schema.encodeSync(OAuth2SourceConfig);

const NullableString = Schema.NullOr(Schema.String);
const OptionalNullableString = Schema.optional(NullableString);

const ChildStorageRow = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["text", "binding"]),
  text_value: OptionalNullableString,
  slot_key: OptionalNullableString,
  prefix: OptionalNullableString,
});
const decodeChildStorageRowOption = Schema.decodeUnknownOption(ChildStorageRow);

const SourceStorageRow = Schema.Struct({
  id: Schema.String,
  scope_id: Schema.String,
  name: Schema.String,
  spec: Schema.String,
  source_url: OptionalNullableString,
  base_url: OptionalNullableString,
  oauth2: Schema.optional(Schema.Unknown),
});
const decodeSourceStorageRow = Schema.decodeUnknownSync(SourceStorageRow);

const OperationStorageRow = Schema.Struct({
  id: Schema.String,
  source_id: Schema.String,
  binding: Schema.Unknown,
});
const decodeOperationStorageRow = Schema.decodeUnknownSync(OperationStorageRow);

interface ChildRow {
  readonly id: string;
  readonly scope_id: string;
  readonly source_id: string;
  readonly name: string;
  readonly kind: "text" | "binding";
  readonly text_value?: string;
  readonly slot_key?: string;
  readonly prefix?: string;
  readonly [k: string]: unknown;
}

// Collapse a structural credential map into the flat child-table column
// shape used by openapi_source_header, openapi_source_query_param, and
// the two openapi_source_spec_fetch_* tables. Returns one record per entry.
const valueMapToChildRows = (
  sourceId: string,
  scope: string,
  values: Record<string, ConfiguredHeaderValue> | undefined,
): readonly ChildRow[] => {
  if (!values) return [];
  return Object.entries(values).map(([name, value]) => {
    const id = JSON.stringify([sourceId, name]);
    if (typeof value === "string") {
      return {
        id,
        scope_id: scope,
        source_id: sourceId,
        name,
        kind: "text",
        text_value: value,
      };
    }
    return {
      id,
      scope_id: scope,
      source_id: sourceId,
      name,
      kind: "binding",
      slot_key: value.slot,
      prefix: value.prefix,
    };
  });
};

const childRowsToValueMap = (
  rows: readonly Record<string, unknown>[],
): Record<string, ConfiguredHeaderValue> => {
  const out: Record<string, ConfiguredHeaderValue> = {};
  for (const row of rows) {
    const decoded = decodeChildStorageRowOption(row);
    if (Option.isSome(decoded)) {
      const child = decoded.value;
      if (child.kind === "binding" && child.slot_key != null) {
        out[child.name] =
          child.prefix != null
            ? ConfiguredHeaderBinding.make({
                kind: "binding",
                slot: child.slot_key,
                prefix: child.prefix,
              })
            : ConfiguredHeaderBinding.make({
                kind: "binding",
                slot: child.slot_key,
              });
      } else if (child.kind === "text" && child.text_value != null) {
        out[child.name] = child.text_value;
      }
    }
  }
  return out;
};

const toJsonRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const slugifySlotPart = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";

export const headerBindingSlot = (headerName: string): string =>
  `header:${slugifySlotPart(headerName)}`;

export const queryParamBindingSlot = (name: string): string =>
  `query_param:${slugifySlotPart(name)}`;

export const oauth2ClientIdSlot = (securitySchemeName: string): string =>
  `oauth2:${slugifySlotPart(securitySchemeName)}:client-id`;

export const oauth2ClientSecretSlot = (securitySchemeName: string): string =>
  `oauth2:${slugifySlotPart(securitySchemeName)}:client-secret`;

export const oauth2ConnectionSlot = (securitySchemeName: string): string =>
  `oauth2:${slugifySlotPart(securitySchemeName)}:connection`;

const normalizeStoredOAuth2 = (value: unknown): OAuth2SourceConfig | undefined => {
  if (value == null) return undefined;
  const sourceConfig =
    typeof value === "string"
      ? decodeOAuth2SourceConfigJsonOption(value)
      : decodeOAuth2SourceConfigOption(value);
  if (Option.isSome(sourceConfig)) {
    return sourceConfig.value;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

// Every read/write that targets a single row pins BOTH the natural id
// (namespace, toolId, sessionId) AND the owning `scope_id`. Scope is a
// normal FumaDB predicate here, not hidden behavior.
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
      readonly queryParams?: Record<string, ConfiguredHeaderValue>;
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

  readonly removeSource: (namespace: string, scope: string) => Effect.Effect<void, StorageFailure>;

  // ---------------------------------------------------------------------
  // Query params and spec-fetch credentials are source-owned structural
  // rows only. Secret/connection ownership and usages live in core
  // `credential_binding`.
}

// ---------------------------------------------------------------------------
// Default store implementation
// ---------------------------------------------------------------------------

type FumaStoreDb = {
  readonly create: (
    table: string,
    row: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  readonly createMany: (
    table: string,
    rows: readonly Record<string, unknown>[],
  ) => Promise<readonly unknown[]>;
  readonly deleteMany: (table: string, options: unknown) => Promise<void>;
  readonly findFirst: (table: string, options: unknown) => Promise<Record<string, unknown> | null>;
  readonly findMany: (
    table: string,
    options?: unknown,
  ) => Promise<readonly Record<string, unknown>[]>;
  readonly updateMany: (table: string, options: unknown) => Promise<void>;
};

const asStoreDb = (db: unknown): FumaStoreDb => db as FumaStoreDb;

type StoreConditionBuilder = ConditionBuilder<Record<string, AnyColumn>>;

const bySourceScope =
  (sourceId: string, scope: string) =>
  (b: StoreConditionBuilder): Condition =>
    b.and(b("source_id", "=", sourceId), b("scope_id", "=", scope)) as Condition;

const byScopedId =
  (id: string, scope: string) =>
  (b: StoreConditionBuilder): Condition =>
    b.and(b("id", "=", id), b("scope_id", "=", scope)) as Condition;

export const makeDefaultOpenapiStore = ({ fuma }: StorageDeps<OpenapiSchema>): OpenapiStore => {
  const findMany = (
    table: string,
    options?: unknown,
  ): Effect.Effect<readonly Record<string, unknown>[], StorageFailure> =>
    fuma.use(`${table}.findMany`, (db) => asStoreDb(db).findMany(table, options));

  const findFirst = (
    table: string,
    options: unknown,
  ): Effect.Effect<Record<string, unknown> | null, StorageFailure> =>
    fuma.use(`${table}.findFirst`, (db) => asStoreDb(db).findFirst(table, options));

  const createMany = (
    table: string,
    rows: readonly Record<string, unknown>[],
  ): Effect.Effect<void, StorageFailure> =>
    rows.length === 0
      ? Effect.void
      : fuma
          .use(`${table}.createMany`, (db) => asStoreDb(db).createMany(table, rows))
          .pipe(Effect.asVoid);

  const deleteMany = (table: string, options: unknown): Effect.Effect<void, StorageFailure> =>
    fuma.use(`${table}.deleteMany`, (db) => asStoreDb(db).deleteMany(table, options));

  const updateMany = (table: string, options: unknown): Effect.Effect<void, StorageFailure> =>
    fuma.use(`${table}.updateMany`, (db) => asStoreDb(db).updateMany(table, options));

  const loadChildValueMap = (
    tableName:
      | "openapi_source_header"
      | "openapi_source_query_param"
      | "openapi_source_spec_fetch_header"
      | "openapi_source_spec_fetch_query_param",
    sourceId: string,
    scope: string,
  ) =>
    findMany(tableName, { where: bySourceScope(sourceId, scope) }).pipe(
      Effect.map(childRowsToValueMap),
    );

  const rowToSource = (row: Record<string, unknown>): Effect.Effect<StoredSource, StorageFailure> =>
    Effect.gen(function* () {
      const sourceRow = decodeSourceStorageRow(row);
      const sourceId = sourceRow.id;
      const scope = sourceRow.scope_id;
      const oauth2 = normalizeStoredOAuth2(sourceRow.oauth2);

      const headers = yield* loadChildValueMap("openapi_source_header", sourceId, scope);
      const queryParams = yield* loadChildValueMap("openapi_source_query_param", sourceId, scope);
      const specFetchHeaders = yield* loadChildValueMap(
        "openapi_source_spec_fetch_header",
        sourceId,
        scope,
      );
      const specFetchQueryParams = yield* loadChildValueMap(
        "openapi_source_spec_fetch_query_param",
        sourceId,
        scope,
      );
      const specFetchCredentials: OpenApiSpecFetchCredentials | undefined =
        Object.keys(specFetchHeaders).length === 0 && Object.keys(specFetchQueryParams).length === 0
          ? undefined
          : {
              ...(Object.keys(specFetchHeaders).length > 0 ? { headers: specFetchHeaders } : {}),
              ...(Object.keys(specFetchQueryParams).length > 0
                ? { queryParams: specFetchQueryParams }
                : {}),
            };

      return {
        namespace: sourceId,
        scope,
        name: sourceRow.name,
        config: {
          spec: sourceRow.spec,
          sourceUrl: sourceRow.source_url ?? undefined,
          baseUrl: sourceRow.base_url ?? undefined,
          headers,
          queryParams,
          specFetchCredentials,
          oauth2,
        },
      };
    });

  const rowToOperation = (row: Record<string, unknown>): StoredOperation => {
    const operationRow = decodeOperationStorageRow(row);
    return {
      toolId: operationRow.id,
      sourceId: operationRow.source_id,
      binding: decodeBinding(
        typeof operationRow.binding === "string"
          ? decodeBindingJson(operationRow.binding)
          : operationRow.binding,
      ),
    };
  };

  // Replace the rows of one child table for a source: delete then bulk
  // insert. Single helper so upsertSource and updateSourceMeta both
  // funnel through the same write path.
  const replaceChildRows = (
    tableName:
      | "openapi_source_header"
      | "openapi_source_query_param"
      | "openapi_source_spec_fetch_header"
      | "openapi_source_spec_fetch_query_param",
    sourceId: string,
    scope: string,
    values: Record<string, ConfiguredHeaderValue> | undefined,
  ) =>
    Effect.gen(function* () {
      yield* deleteMany(tableName, { where: bySourceScope(sourceId, scope) });
      const rows = valueMapToChildRows(sourceId, scope, values);
      if (rows.length === 0) return;
      yield* createMany(tableName, rows);
    });

  const deleteSource = (namespace: string, scope: string) =>
    Effect.gen(function* () {
      yield* deleteMany("openapi_operation", { where: bySourceScope(namespace, scope) });
      // Drop every child table's rows for this source/scope.
      for (const tableName of [
        "openapi_source_header",
        "openapi_source_query_param",
        "openapi_source_spec_fetch_header",
        "openapi_source_spec_fetch_query_param",
      ] as const) {
        yield* deleteMany(tableName, { where: bySourceScope(namespace, scope) });
      }
      yield* deleteMany("openapi_source", { where: byScopedId(namespace, scope) });
    });

  return {
    upsertSource: (input, operations) =>
      Effect.gen(function* () {
        yield* deleteSource(input.namespace, input.scope);
        yield* createMany("openapi_source", [
          {
            id: input.namespace,
            scope_id: input.scope,
            name: input.name,
            spec: input.config.spec,
            source_url: input.config.sourceUrl ?? null,
            base_url: input.config.baseUrl ?? null,
            oauth2: input.config.oauth2
              ? toJsonRecord(encodeOAuth2SourceConfig(input.config.oauth2))
              : null,
          },
        ]);
        yield* replaceChildRows(
          "openapi_source_header",
          input.namespace,
          input.scope,
          input.config.headers,
        );
        yield* replaceChildRows(
          "openapi_source_query_param",
          input.namespace,
          input.scope,
          input.config.queryParams,
        );
        yield* replaceChildRows(
          "openapi_source_spec_fetch_header",
          input.namespace,
          input.scope,
          input.config.specFetchCredentials?.headers,
        );
        yield* replaceChildRows(
          "openapi_source_spec_fetch_query_param",
          input.namespace,
          input.scope,
          input.config.specFetchCredentials?.queryParams,
        );
        if (operations.length > 0) {
          yield* createMany(
            "openapi_operation",
            operations.map((op) => ({
              id: op.toolId,
              scope_id: input.scope,
              source_id: op.sourceId,
              binding: toJsonRecord(encodeBinding(op.binding)),
            })),
          );
        }
      }),

    updateSourceMeta: (namespace, scope, patch) =>
      Effect.gen(function* () {
        const existingRow = yield* findFirst("openapi_source", {
          where: byScopedId(namespace, scope),
        });
        if (!existingRow) return;
        const existing = yield* rowToSource(existingRow);

        const nextName = patch.name?.trim() || existing.name;
        const nextBaseUrl = patch.baseUrl !== undefined ? patch.baseUrl : existing.config.baseUrl;
        const nextOAuth2 = patch.oauth2 !== undefined ? patch.oauth2 : existing.config.oauth2;

        yield* updateMany("openapi_source", {
          where: byScopedId(namespace, scope),
          set: {
            name: nextName,
            base_url: nextBaseUrl ?? null,
            oauth2: nextOAuth2 ? toJsonRecord(encodeOAuth2SourceConfig(nextOAuth2)) : null,
          },
        });
        if (patch.headers !== undefined) {
          yield* replaceChildRows("openapi_source_header", namespace, scope, patch.headers);
        }
        if (patch.queryParams !== undefined) {
          yield* replaceChildRows(
            "openapi_source_query_param",
            namespace,
            scope,
            patch.queryParams,
          );
        }
      }),

    getSource: (namespace, scope) =>
      Effect.gen(function* () {
        const row = yield* findFirst("openapi_source", { where: byScopedId(namespace, scope) });
        if (!row) return null;
        return yield* rowToSource(row);
      }),

    listSources: () =>
      Effect.gen(function* () {
        const rows = yield* findMany("openapi_source");
        return yield* Effect.forEach(rows, rowToSource, {
          concurrency: "unbounded",
        });
      }),

    getOperationByToolId: (toolId, scope) =>
      findFirst("openapi_operation", { where: byScopedId(toolId, scope) }).pipe(
        Effect.map((row) => (row ? rowToOperation(row) : null)),
      ),

    listOperationsBySource: (sourceId, scope) =>
      findMany("openapi_operation", { where: bySourceScope(sourceId, scope) }).pipe(
        Effect.map((rows) => rows.map(rowToOperation)),
      ),

    removeSource: (namespace, scope) => deleteSource(namespace, scope),
  };
};
