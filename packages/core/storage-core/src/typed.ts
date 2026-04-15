// ---------------------------------------------------------------------------
// Schema-aware typed view over a DBAdapter.
//
// `DBAdapter` is intentionally un-generic — it's a single runtime interface
// every backend implements. This wrapper layers compile-time typing on top
// for a caller that knows its schema statically:
//
//   const typed = typedAdapter<typeof mySchema>(adapter);
//   typed.create({ model: "my_table", data: { ... } });
//   //                       ^^^^^^^^^^         ^^^^^^^^
//   //                       keyof mySchema     InferDBFieldsInput<fields>
//
// There's no runtime wrapping — `typedAdapter` is a zero-cost cast at the
// type level. Core SDK wraps once with `coreSchema`, each plugin wraps
// once with its own plugin schema inside `makeDefault*Store`.
// ---------------------------------------------------------------------------

import type { Effect } from "effect";

import type { DBAdapter, Where } from "./adapter";
import type {
  DBSchema,
  InferDBFieldsInput,
  InferDBFieldsOutput,
} from "./schema";

type RowInput<S extends DBSchema, M extends keyof S> = InferDBFieldsInput<
  S[M]["fields"]
> &
  Record<string, unknown>;

type RowOutput<S extends DBSchema, M extends keyof S> = InferDBFieldsOutput<
  S[M]["fields"]
> &
  Record<string, unknown>;

export interface TypedAdapter<S extends DBSchema> {
  readonly raw: DBAdapter;

  readonly create: <M extends keyof S & string>(data: {
    model: M;
    data: Omit<RowInput<S, M>, "id"> & { id?: string };
    forceAllowId?: boolean;
  }) => Effect.Effect<RowOutput<S, M>, Error>;

  readonly createMany: <M extends keyof S & string>(data: {
    model: M;
    data: ReadonlyArray<Omit<RowInput<S, M>, "id"> & { id?: string }>;
    forceAllowId?: boolean;
  }) => Effect.Effect<readonly RowOutput<S, M>[], Error>;

  readonly findOne: <M extends keyof S & string>(data: {
    model: M;
    where: Where[];
  }) => Effect.Effect<RowOutput<S, M> | null, Error>;

  readonly findMany: <M extends keyof S & string>(data: {
    model: M;
    where?: Where[];
    limit?: number;
    sortBy?: { field: string; direction: "asc" | "desc" };
    offset?: number;
  }) => Effect.Effect<readonly RowOutput<S, M>[], Error>;

  readonly update: <M extends keyof S & string>(data: {
    model: M;
    where: Where[];
    update: Partial<RowInput<S, M>>;
  }) => Effect.Effect<RowOutput<S, M> | null, Error>;

  readonly updateMany: <M extends keyof S & string>(data: {
    model: M;
    where: Where[];
    update: Partial<RowInput<S, M>>;
  }) => Effect.Effect<number, Error>;

  readonly delete: <M extends keyof S & string>(data: {
    model: M;
    where: Where[];
  }) => Effect.Effect<void, Error>;

  readonly deleteMany: <M extends keyof S & string>(data: {
    model: M;
    where: Where[];
  }) => Effect.Effect<number, Error>;

  readonly count: <M extends keyof S & string>(data: {
    model: M;
    where?: Where[];
  }) => Effect.Effect<number, Error>;
}

/**
 * Create a schema-typed view over a `DBAdapter`. Zero runtime cost —
 * this is a typed re-export of the adapter's methods. Pass the schema as
 * a type parameter; the adapter argument is the normal untyped one.
 */
export const typedAdapter = <S extends DBSchema>(
  adapter: DBAdapter,
): TypedAdapter<S> => ({
  raw: adapter,
  create: adapter.create as TypedAdapter<S>["create"],
  createMany: adapter.createMany as TypedAdapter<S>["createMany"],
  findOne: adapter.findOne as TypedAdapter<S>["findOne"],
  findMany: adapter.findMany as TypedAdapter<S>["findMany"],
  update: adapter.update as TypedAdapter<S>["update"],
  updateMany: adapter.updateMany as TypedAdapter<S>["updateMany"],
  delete: adapter.delete as TypedAdapter<S>["delete"],
  deleteMany: adapter.deleteMany as TypedAdapter<S>["deleteMany"],
  count: adapter.count as TypedAdapter<S>["count"],
});
