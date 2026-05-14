import { Effect, Schema } from "effect";

import {
  ConfiguredCredentialBinding,
  type FumaTables,
  jsonColumn,
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
  OperationBinding,
  type ConfiguredGraphqlCredentialValue,
  type GraphqlSourceAuth,
} from "./types";

// ---------------------------------------------------------------------------
// Schema — four tables:
//   - graphql_source: endpoint + auth structure + display name per source.
//     Auth carries a connection slot; concrete per-user/per-workspace
//     connection ids live in core credential_binding rows.
//   - graphql_source_header / graphql_source_query_param: one row per
//     header/param entry. `kind` discriminates literal text from a
//     credential slot binding. PK is `(scope_id, id)` where id is a JSON
//     tuple `[source_id,name]` so user-provided separators cannot collide.
//   - graphql_operation: per-tool OperationBinding blob. Operation
//     bindings don't reference secrets/connections, so they stay as
//     JSON — that's a legit JSON case (the binding shape is plugin-
//     internal opaque data).
// ---------------------------------------------------------------------------

export const graphqlSchema = {
  graphql_source: scopedExecutorTable("graphql_source", {
    name: textColumn("name"),
    endpoint: textColumn("endpoint"),
    auth_kind: textColumn("auth_kind").defaultTo("none"),
    auth_connection_slot: nullableTextColumn("auth_connection_slot"),
  }),
  graphql_source_header: scopedExecutorTable("graphql_source_header", {
    source_id: textColumn("source_id"),
    name: textColumn("name"),
    kind: textColumn("kind"),
    text_value: nullableTextColumn("text_value"),
    slot_key: nullableTextColumn("slot_key"),
    prefix: nullableTextColumn("prefix"),
  }),
  graphql_source_query_param: scopedExecutorTable("graphql_source_query_param", {
    source_id: textColumn("source_id"),
    name: textColumn("name"),
    kind: textColumn("kind"),
    text_value: nullableTextColumn("text_value"),
    slot_key: nullableTextColumn("slot_key"),
    prefix: nullableTextColumn("prefix"),
  }),
  graphql_operation: scopedExecutorTable("graphql_operation", {
    source_id: textColumn("source_id"),
    binding: jsonColumn("binding"),
  }),
} satisfies FumaTables;

export type GraphqlSchema = typeof graphqlSchema;

// ---------------------------------------------------------------------------
// In-memory value shapes
// ---------------------------------------------------------------------------

export interface StoredGraphqlSource {
  readonly namespace: string;
  /** Executor scope id this source row lives in. Writes stamp this on
   *  `scope_id`; reads choose scope explicitly in the FumaDB query. */
  readonly scope: string;
  readonly name: string;
  readonly endpoint: string;
  readonly headers: Record<string, ConfiguredGraphqlCredentialValue>;
  readonly queryParams: Record<string, ConfiguredGraphqlCredentialValue>;
  readonly auth: GraphqlSourceAuth;
}

export interface StoredOperation {
  readonly toolId: string;
  readonly sourceId: string;
  readonly binding: OperationBinding;
}

const OperationBindingFromJsonString = Schema.fromJsonString(OperationBinding);
const decodeOperationBindingFromJsonString = Schema.decodeUnknownSync(
  OperationBindingFromJsonString,
);
const decodeOperationBinding = Schema.decodeUnknownSync(OperationBinding);

const decodeBinding = (value: unknown): OperationBinding => {
  if (typeof value === "string") {
    return decodeOperationBindingFromJsonString(value);
  }
  return decodeOperationBinding(value);
};

const encodeBinding = Schema.encodeSync(OperationBinding);

const toJsonRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const SourceRow = Schema.Struct({
  id: Schema.String,
  scope_id: Schema.String,
  name: Schema.String,
  endpoint: Schema.String,
  auth_kind: Schema.Literals(["none", "oauth2"]),
  auth_connection_slot: Schema.NullOr(Schema.String).pipe(Schema.optionalKey),
});

const ChildValueRow = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["text", "binding"]),
  text_value: Schema.NullOr(Schema.String).pipe(Schema.optionalKey),
  slot_key: Schema.NullOr(Schema.String).pipe(Schema.optionalKey),
  prefix: Schema.NullOr(Schema.String).pipe(Schema.optionalKey),
});

const OperationRow = Schema.Struct({
  id: Schema.String,
  source_id: Schema.String,
  binding: Schema.Unknown,
});

const decodeSourceRow = Schema.decodeUnknownSync(SourceRow);
const decodeChildValueRow = Schema.decodeUnknownSync(ChildValueRow);
const decodeOperationRow = Schema.decodeUnknownSync(OperationRow);

// Header / query-param rows: collapse the flat columns back into a source
// structure map keyed by header/param name. Concrete credential values are
// resolved through core credential_binding rows at invocation time.
const rowsToValueMap = (
  rows: readonly Record<string, unknown>[],
): Record<string, ConfiguredGraphqlCredentialValue> => {
  const out: Record<string, ConfiguredGraphqlCredentialValue> = {};
  for (const rawRow of rows) {
    const row = decodeChildValueRow(rawRow);
    const name = row.name;
    if (row.kind === "binding" && typeof row.slot_key === "string") {
      out[name] =
        typeof row.prefix === "string"
          ? ConfiguredCredentialBinding.make({
              kind: "binding",
              slot: row.slot_key,
              prefix: row.prefix,
            })
          : ConfiguredCredentialBinding.make({
              kind: "binding",
              slot: row.slot_key,
            });
    } else if (row.kind === "text" && typeof row.text_value === "string") {
      out[name] = row.text_value;
    }
  }
  return out;
};

// Encode one entry of a source credential map into a child row. Used by the
// writer for both `graphql_source_header` and `graphql_source_query_param`.
// Returns a `Record<string, unknown>` so it can be passed straight to FumaDB.
const valueToChildRow = (
  sourceId: string,
  scope: string,
  name: string,
  value: ConfiguredGraphqlCredentialValue,
): Record<string, unknown> => {
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
};

const rowToAuth = (row: typeof SourceRow.Type): GraphqlSourceAuth => {
  if (row.auth_kind === "oauth2" && typeof row.auth_connection_slot === "string") {
    return { kind: "oauth2", connectionSlot: row.auth_connection_slot };
  }
  return { kind: "none" };
};

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

// Every read/write that targets a single row pins BOTH the natural id
// (namespace, toolId) AND the owning `scope_id`. Scope is a normal FumaDB
// predicate here, not hidden behavior.
export interface GraphqlStore {
  readonly upsertSource: (
    input: StoredGraphqlSource,
    operations: readonly StoredOperation[],
  ) => Effect.Effect<void, StorageFailure>;

  readonly updateSourceMeta: (
    namespace: string,
    scope: string,
    patch: {
      readonly name?: string;
      readonly endpoint?: string;
      readonly headers?: Record<string, ConfiguredGraphqlCredentialValue>;
      readonly queryParams?: Record<string, ConfiguredGraphqlCredentialValue>;
      readonly auth?: GraphqlSourceAuth;
    },
  ) => Effect.Effect<void, StorageFailure>;

  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<StoredGraphqlSource | null, StorageFailure>;

  readonly listSources: () => Effect.Effect<readonly StoredGraphqlSource[], StorageFailure>;

  readonly getOperationByToolId: (
    toolId: string,
    scope: string,
  ) => Effect.Effect<StoredOperation | null, StorageFailure>;

  readonly listOperationsBySource: (
    sourceId: string,
    scope: string,
  ) => Effect.Effect<readonly StoredOperation[], StorageFailure>;

  readonly removeSource: (namespace: string, scope: string) => Effect.Effect<void, StorageFailure>;
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

export const makeDefaultGraphqlStore = ({ fuma }: StorageDeps<GraphqlSchema>): GraphqlStore => {
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

  const create = (
    table: string,
    row: Record<string, unknown>,
  ): Effect.Effect<Record<string, unknown>, StorageFailure> =>
    fuma.use(`${table}.create`, (db) => asStoreDb(db).create(table, row));

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

  const loadHeaders = (sourceId: string, scope: string) =>
    findMany("graphql_source_header", { where: bySourceScope(sourceId, scope) }).pipe(
      Effect.map(rowsToValueMap),
    );

  const loadQueryParams = (sourceId: string, scope: string) =>
    findMany("graphql_source_query_param", { where: bySourceScope(sourceId, scope) }).pipe(
      Effect.map(rowsToValueMap),
    );

  const rowToSourceWithChildren = (
    row: Record<string, unknown>,
  ): Effect.Effect<StoredGraphqlSource, StorageFailure> =>
    Effect.gen(function* () {
      const source = decodeSourceRow(row);
      const sourceId = source.id;
      const scope = source.scope_id;
      const headers = yield* loadHeaders(sourceId, scope);
      const queryParams = yield* loadQueryParams(sourceId, scope);
      return {
        namespace: sourceId,
        scope,
        name: source.name,
        endpoint: source.endpoint,
        headers,
        queryParams,
        auth: rowToAuth(source),
      };
    });

  const rowToOperation = (row: Record<string, unknown>): StoredOperation => {
    const operation = decodeOperationRow(row);
    return {
      toolId: operation.id,
      sourceId: operation.source_id,
      binding: decodeBinding(operation.binding),
    };
  };

  // Replace child rows for a source by deleting then bulk-inserting. Used
  // by both upsertSource (full rewrite) and updateSourceMeta (partial
  // patch when headers/queryParams is supplied).
  const replaceChildren = (
    tableName: "graphql_source_header" | "graphql_source_query_param",
    sourceId: string,
    scope: string,
    values: Record<string, ConfiguredGraphqlCredentialValue>,
  ) =>
    Effect.gen(function* () {
      yield* deleteMany(tableName, { where: bySourceScope(sourceId, scope) });
      const entries = Object.entries(values);
      if (entries.length === 0) return;
      yield* createMany(
        tableName,
        entries.map(([name, value]) => valueToChildRow(sourceId, scope, name, value)),
      );
    });

  const deleteSource = (namespace: string, scope: string) =>
    Effect.gen(function* () {
      yield* deleteMany("graphql_operation", { where: bySourceScope(namespace, scope) });
      yield* deleteMany("graphql_source_header", { where: bySourceScope(namespace, scope) });
      yield* deleteMany("graphql_source_query_param", { where: bySourceScope(namespace, scope) });
      yield* deleteMany("graphql_source", { where: byScopedId(namespace, scope) });
    });

  return {
    upsertSource: (input, operations) =>
      Effect.gen(function* () {
        yield* deleteSource(input.namespace, input.scope);
        yield* create("graphql_source", {
          id: input.namespace,
          scope_id: input.scope,
          name: input.name,
          endpoint: input.endpoint,
          auth_kind: input.auth.kind,
          auth_connection_slot: input.auth.kind === "oauth2" ? input.auth.connectionSlot : null,
        });
        yield* replaceChildren(
          "graphql_source_header",
          input.namespace,
          input.scope,
          input.headers,
        );
        yield* replaceChildren(
          "graphql_source_query_param",
          input.namespace,
          input.scope,
          input.queryParams,
        );
        if (operations.length > 0) {
          yield* createMany(
            "graphql_operation",
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
        const existing = yield* findFirst("graphql_source", {
          where: byScopedId(namespace, scope),
        });
        if (!existing) return;
        const update: Record<string, unknown> = {};
        if (patch.name !== undefined) update.name = patch.name;
        if (patch.endpoint !== undefined) update.endpoint = patch.endpoint;
        if (patch.auth !== undefined) {
          update.auth_kind = patch.auth.kind;
          update.auth_connection_slot =
            patch.auth.kind === "oauth2" ? patch.auth.connectionSlot : null;
        }
        if (Object.keys(update).length > 0) {
          yield* updateMany("graphql_source", {
            where: byScopedId(namespace, scope),
            set: update,
          });
        }
        if (patch.headers !== undefined) {
          yield* replaceChildren("graphql_source_header", namespace, scope, patch.headers);
        }
        if (patch.queryParams !== undefined) {
          yield* replaceChildren("graphql_source_query_param", namespace, scope, patch.queryParams);
        }
      }),

    getSource: (namespace, scope) =>
      Effect.gen(function* () {
        const row = yield* findFirst("graphql_source", { where: byScopedId(namespace, scope) });
        if (!row) return null;
        return yield* rowToSourceWithChildren(row);
      }),

    listSources: () =>
      Effect.gen(function* () {
        const rows = yield* findMany("graphql_source");
        return yield* Effect.forEach(rows, rowToSourceWithChildren, {
          concurrency: "unbounded",
        });
      }),

    getOperationByToolId: (toolId, scope) =>
      findFirst("graphql_operation", { where: byScopedId(toolId, scope) }).pipe(
        Effect.map((row) => (row ? rowToOperation(row) : null)),
      ),

    listOperationsBySource: (sourceId, scope) =>
      findMany("graphql_operation", { where: bySourceScope(sourceId, scope) }).pipe(
        Effect.map((rows) => rows.map(rowToOperation)),
      ),

    removeSource: (namespace, scope) => deleteSource(namespace, scope),
  };
};
