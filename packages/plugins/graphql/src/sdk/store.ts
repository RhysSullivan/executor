import { Effect, Option, Predicate, Schema } from "effect";

import {
  ConfiguredCredentialBinding,
  type PluginStorageEntry,
  type StorageDeps,
  type StorageFailure,
} from "@executor-js/sdk/core";

import {
  GraphqlSourceAuth,
  OperationBinding,
  type ConfiguredGraphqlCredentialValue,
} from "./types";

export interface StoredGraphqlSource {
  readonly namespace: string;
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

const SOURCE_COLLECTION = "source";
const OPERATION_COLLECTION = "operation";

const OperationBindingFromJsonString = Schema.fromJsonString(OperationBinding);
const decodeOperationBindingFromJsonString = Schema.decodeUnknownSync(
  OperationBindingFromJsonString,
);
const decodeOperationBinding = Schema.decodeUnknownSync(OperationBinding);
const encodeBinding = Schema.encodeSync(OperationBinding);

const decodeBinding = (value: unknown): OperationBinding => {
  if (typeof value === "string") return decodeOperationBindingFromJsonString(value);
  return decodeOperationBinding(value);
};

const toJsonRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const OptionalNullableString = Schema.optional(Schema.NullOr(Schema.String));
const ConfiguredCredentialBindingStorage = Schema.Struct({
  kind: Schema.Literal("binding"),
  slot: Schema.String,
  prefix: OptionalNullableString,
});
const ConfiguredCredentialValueStorage = Schema.Union([
  Schema.String,
  ConfiguredCredentialBindingStorage,
]);
const CredentialMapStorage = Schema.Record(Schema.String, ConfiguredCredentialValueStorage);
const SourceStorage = Schema.Struct({
  namespace: Schema.String,
  scope: Schema.String,
  name: Schema.String,
  endpoint: Schema.String,
  headers: Schema.optional(CredentialMapStorage),
  queryParams: Schema.optional(CredentialMapStorage),
  auth: GraphqlSourceAuth,
});
const OperationStorage = Schema.Struct({
  toolId: Schema.String,
  sourceId: Schema.String,
  binding: Schema.Unknown,
});
const decodeSourceStorage = Schema.decodeUnknownOption(SourceStorage);
const decodeOperationStorage = Schema.decodeUnknownOption(OperationStorage);

const normalizeCredentialMap = (
  values: Readonly<Record<string, typeof ConfiguredCredentialValueStorage.Type>> | undefined,
): Record<string, ConfiguredGraphqlCredentialValue> => {
  if (!values) return {};
  const normalized: Record<string, ConfiguredGraphqlCredentialValue> = {};
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string") {
      normalized[name] = value;
      continue;
    }
    normalized[name] =
      value.prefix != null
        ? ConfiguredCredentialBinding.make({
            kind: "binding",
            slot: value.slot,
            prefix: value.prefix,
          })
        : ConfiguredCredentialBinding.make({
            kind: "binding",
            slot: value.slot,
          });
  }
  return normalized;
};

const sourceData = (source: StoredGraphqlSource) => ({
  namespace: source.namespace,
  scope: source.scope,
  name: source.name,
  endpoint: source.endpoint,
  headers: source.headers,
  queryParams: source.queryParams,
  auth: source.auth,
});

const operationData = (operation: StoredOperation) => ({
  toolId: operation.toolId,
  sourceId: operation.sourceId,
  binding: toJsonRecord(encodeBinding(operation.binding)),
});

const rowToSource = (row: PluginStorageEntry): StoredGraphqlSource | null => {
  const decoded = decodeSourceStorage(row.data);
  if (Option.isNone(decoded)) return null;
  const source = decoded.value;
  return {
    namespace: source.namespace,
    scope: source.scope,
    name: source.name,
    endpoint: source.endpoint,
    headers: normalizeCredentialMap(source.headers),
    queryParams: normalizeCredentialMap(source.queryParams),
    auth: source.auth,
  };
};

const rowToOperation = (row: PluginStorageEntry): StoredOperation | null => {
  const decoded = decodeOperationStorage(row.data);
  if (Option.isNone(decoded)) return null;
  const operation = decoded.value;
  return {
    toolId: operation.toolId,
    sourceId: operation.sourceId,
    binding: decodeBinding(operation.binding),
  };
};

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

export const makeDefaultGraphqlStore = ({ pluginStorage }: StorageDeps): GraphqlStore => {
  const listOperationRowsForSourceScope = (sourceId: string, scope: string) =>
    pluginStorage
      .list({
        collection: OPERATION_COLLECTION,
        keyPrefix: `${sourceId}.`,
      })
      .pipe(
        Effect.map((rows) =>
          rows.filter((row) => {
            if (String(row.scopeId) !== scope) return false;
            return rowToOperation(row)?.sourceId === sourceId;
          }),
        ),
      );

  const removeOperationsForSourceScope = (sourceId: string, scope: string) =>
    Effect.gen(function* () {
      const rows = yield* listOperationRowsForSourceScope(sourceId, scope);
      for (const row of rows) {
        yield* pluginStorage.remove({
          scope,
          collection: OPERATION_COLLECTION,
          key: row.key,
        });
      }
    });

  const deleteSource = (namespace: string, scope: string) =>
    Effect.gen(function* () {
      yield* removeOperationsForSourceScope(namespace, scope);
      yield* pluginStorage.remove({
        scope,
        collection: SOURCE_COLLECTION,
        key: namespace,
      });
    });

  return {
    upsertSource: (input, operations) =>
      Effect.gen(function* () {
        yield* deleteSource(input.namespace, input.scope);
        yield* pluginStorage.put({
          scope: input.scope,
          collection: SOURCE_COLLECTION,
          key: input.namespace,
          data: sourceData(input),
        });
        for (const operation of operations) {
          yield* pluginStorage.put({
            scope: input.scope,
            collection: OPERATION_COLLECTION,
            key: operation.toolId,
            data: operationData(operation),
          });
        }
      }),

    updateSourceMeta: (namespace, scope, patch) =>
      Effect.gen(function* () {
        const existing = yield* pluginStorage.getAtScope({
          scope,
          collection: SOURCE_COLLECTION,
          key: namespace,
        });
        if (!existing) return;
        const source = rowToSource(existing);
        if (!source) return;
        yield* pluginStorage.put({
          scope,
          collection: SOURCE_COLLECTION,
          key: namespace,
          data: sourceData({
            ...source,
            name: patch.name ?? source.name,
            endpoint: patch.endpoint ?? source.endpoint,
            headers: patch.headers ?? source.headers,
            queryParams: patch.queryParams ?? source.queryParams,
            auth: patch.auth ?? source.auth,
          }),
        });
      }),

    getSource: (namespace, scope) =>
      pluginStorage
        .getAtScope({ scope, collection: SOURCE_COLLECTION, key: namespace })
        .pipe(Effect.map((row) => (row ? rowToSource(row) : null))),

    listSources: () =>
      pluginStorage
        .list({ collection: SOURCE_COLLECTION })
        .pipe(Effect.map((rows) => rows.map(rowToSource).filter(Predicate.isNotNull))),

    getOperationByToolId: (toolId, scope) =>
      pluginStorage
        .getAtScope({ scope, collection: OPERATION_COLLECTION, key: toolId })
        .pipe(Effect.map((row) => (row ? rowToOperation(row) : null))),

    listOperationsBySource: (sourceId, scope) =>
      listOperationRowsForSourceScope(sourceId, scope).pipe(
        Effect.map((rows) => rows.map(rowToOperation).filter(Predicate.isNotNull)),
      ),

    removeSource: (namespace, scope) => deleteSource(namespace, scope),
  };
};
