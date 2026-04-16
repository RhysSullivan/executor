import { Effect } from "effect";

import { defineSchema, type StorageDeps } from "@executor/sdk";

import { OperationBinding, type HeaderValue } from "./types";

// ---------------------------------------------------------------------------
// Schema — two tables:
//   - graphql_source: endpoint + headers + display name per source
//   - graphql_operation: per-tool OperationBinding blob keyed by tool id
// ---------------------------------------------------------------------------

export const graphqlSchema = defineSchema({
  graphql_source: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      endpoint: { type: "string", required: true },
      headers: { type: "json", required: false },
    },
  },
  graphql_operation: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      binding: { type: "json", required: true },
    },
  },
});

export type GraphqlSchema = typeof graphqlSchema;

// ---------------------------------------------------------------------------
// In-memory value shapes
// ---------------------------------------------------------------------------

export interface StoredGraphqlSource {
  readonly namespace: string;
  readonly name: string;
  readonly endpoint: string;
  readonly headers: Record<string, HeaderValue>;
}

export interface StoredOperation {
  readonly toolId: string;
  readonly sourceId: string;
  readonly binding: OperationBinding;
}

// Persisted JSON shape for an OperationBinding. Reconstructed into a
// Schema.Class instance on read.
interface BindingJson {
  readonly kind: "query" | "mutation";
  readonly fieldName: string;
  readonly operationString: string;
  readonly variableNames: readonly string[];
}

const decodeBinding = (value: unknown): OperationBinding => {
  const data = typeof value === "string" ? (JSON.parse(value) as BindingJson) : (value as BindingJson);
  return new OperationBinding({
    kind: data.kind,
    fieldName: data.fieldName,
    operationString: data.operationString,
    variableNames: [...data.variableNames],
  });
};

const encodeBinding = (binding: OperationBinding): BindingJson => ({
  kind: binding.kind,
  fieldName: binding.fieldName,
  operationString: binding.operationString,
  variableNames: [...binding.variableNames],
});

const decodeHeaders = (value: unknown): Record<string, HeaderValue> => {
  if (value == null) return {};
  if (typeof value === "string") return JSON.parse(value) as Record<string, HeaderValue>;
  return value as Record<string, HeaderValue>;
};

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface GraphqlStore {
  readonly upsertSource: (
    input: StoredGraphqlSource,
    operations: readonly StoredOperation[],
  ) => Effect.Effect<void, Error>;

  readonly updateSourceMeta: (
    namespace: string,
    patch: { readonly name?: string; readonly endpoint?: string; readonly headers?: Record<string, HeaderValue> },
  ) => Effect.Effect<void, Error>;

  readonly getSource: (
    namespace: string,
  ) => Effect.Effect<StoredGraphqlSource | null, Error>;

  readonly listSources: () => Effect.Effect<readonly StoredGraphqlSource[], Error>;

  readonly getOperationByToolId: (
    toolId: string,
  ) => Effect.Effect<StoredOperation | null, Error>;

  readonly listOperationsBySource: (
    sourceId: string,
  ) => Effect.Effect<readonly StoredOperation[], Error>;

  readonly removeSource: (namespace: string) => Effect.Effect<void, Error>;
}

// ---------------------------------------------------------------------------
// Default store implementation
// ---------------------------------------------------------------------------

export const makeDefaultGraphqlStore = ({
  adapter: db,
}: StorageDeps<GraphqlSchema>): GraphqlStore => {
  const rowToSource = (row: Record<string, unknown>): StoredGraphqlSource => ({
    namespace: row.id as string,
    name: row.name as string,
    endpoint: row.endpoint as string,
    headers: decodeHeaders(row.headers),
  });

  const rowToOperation = (row: Record<string, unknown>): StoredOperation => ({
    toolId: row.id as string,
    sourceId: row.source_id as string,
    binding: decodeBinding(row.binding),
  });

  const deleteSource = (namespace: string) =>
    Effect.gen(function* () {
      yield* db.deleteMany({
        model: "graphql_operation",
        where: [{ field: "source_id", value: namespace }],
      });
      yield* db.delete({
        model: "graphql_source",
        where: [{ field: "id", value: namespace }],
      });
    });

  return {
    upsertSource: (input, operations) =>
      Effect.gen(function* () {
        yield* deleteSource(input.namespace);
        yield* db.create({
          model: "graphql_source",
          data: {
            id: input.namespace,
            name: input.name,
            endpoint: input.endpoint,
            headers: input.headers as unknown as Record<string, unknown>,
          },
          forceAllowId: true,
        });
        if (operations.length > 0) {
          yield* db.createMany({
            model: "graphql_operation",
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
        const existing = yield* db.findOne({
          model: "graphql_source",
          where: [{ field: "id", value: namespace }],
        });
        if (!existing) return;
        const update: Record<string, unknown> = {};
        if (patch.name !== undefined) update.name = patch.name;
        if (patch.endpoint !== undefined) update.endpoint = patch.endpoint;
        if (patch.headers !== undefined) {
          update.headers = patch.headers as unknown as Record<string, unknown>;
        }
        if (Object.keys(update).length === 0) return;
        yield* db.update({
          model: "graphql_source",
          where: [{ field: "id", value: namespace }],
          update,
        });
      }),

    getSource: (namespace) =>
      db
        .findOne({
          model: "graphql_source",
          where: [{ field: "id", value: namespace }],
        })
        .pipe(Effect.map((row) => (row ? rowToSource(row) : null))),

    listSources: () =>
      db
        .findMany({ model: "graphql_source" })
        .pipe(Effect.map((rows) => rows.map(rowToSource))),

    getOperationByToolId: (toolId) =>
      db
        .findOne({
          model: "graphql_operation",
          where: [{ field: "id", value: toolId }],
        })
        .pipe(Effect.map((row) => (row ? rowToOperation(row) : null))),

    listOperationsBySource: (sourceId) =>
      db
        .findMany({
          model: "graphql_operation",
          where: [{ field: "source_id", value: sourceId }],
        })
        .pipe(Effect.map((rows) => rows.map(rowToOperation))),

    removeSource: (namespace) => deleteSource(namespace),
  };
};
