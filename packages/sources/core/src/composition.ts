import * as Schema from "effect/Schema";

import { createSourceAdapterRegistry } from "./registry";
import type { SourceAdapter, SourceAdapterInputSchema } from "./types";

type SchemaTypeOf<TSchema> = TSchema extends { readonly Type: infer T } ? T : never;
type AdapterUnion<TAdapters extends readonly SourceAdapter[]> = TAdapters[number];
type ConnectPayloadSchema<TAdapters extends readonly SourceAdapter[]> =
  NonNullable<AdapterUnion<TAdapters>["connectPayloadSchema"]>;
type ExecutorAddInputSchema<TAdapters extends readonly SourceAdapter[]> =
  NonNullable<AdapterUnion<TAdapters>["executorAddInputSchema"]>;

export type ConnectableSourceAdapter<TAdapter extends SourceAdapter = SourceAdapter> = TAdapter & {
  connectPayloadSchema: SourceAdapterInputSchema;
};

export type ExecutorAddableSourceAdapter<TAdapter extends SourceAdapter = SourceAdapter> = TAdapter & {
  executorAddInputSchema: SourceAdapterInputSchema;
};

export type LocalConfigurableSourceAdapter<TAdapter extends SourceAdapter = SourceAdapter> = TAdapter & {
  localConfigBindingSchema: SourceAdapterInputSchema;
};

const isConnectableSourceAdapter = <TAdapter extends SourceAdapter>(
  adapter: TAdapter,
): adapter is ConnectableSourceAdapter<TAdapter> =>
  adapter.connectPayloadSchema !== null;

const isExecutorAddableSourceAdapter = <TAdapter extends SourceAdapter>(
  adapter: TAdapter,
): adapter is ExecutorAddableSourceAdapter<TAdapter> =>
  adapter.executorAddInputSchema !== null;

const isLocalConfigurableSourceAdapter = <TAdapter extends SourceAdapter>(
  adapter: TAdapter,
): adapter is LocalConfigurableSourceAdapter<TAdapter> =>
  adapter.localConfigBindingSchema !== null;

const asSchemaTuple = (
  schemas: ReadonlyArray<Schema.Schema<any, any, never>>,
): [
  Schema.Schema<any, any, never>,
  Schema.Schema<any, any, never>,
  ...Array<Schema.Schema<any, any, never>>,
] => schemas as [
  Schema.Schema<any, any, never>,
  Schema.Schema<any, any, never>,
  ...Array<Schema.Schema<any, any, never>>,
];

const createSchemaFromAdapters = <TSchema extends SourceAdapterInputSchema>(
  schemas: ReadonlyArray<TSchema>,
  label: string,
): TSchema =>
  (schemas.length === 0
    ? (() => {
        throw new Error(`Cannot create ${label} without any schemas`);
      })()
    : schemas.length === 1
    ? schemas[0]!
    : Schema.Union(...asSchemaTuple(schemas))) as TSchema;

export const createSourceAdapterComposition = <const TAdapters extends readonly SourceAdapter[]>(
  adapters: TAdapters,
) => {
  const connectableSourceAdapters = adapters.filter(isConnectableSourceAdapter);
  const executorAddableSourceAdapters = adapters.filter(isExecutorAddableSourceAdapter);
  const localConfigurableSourceAdapters = adapters.filter(isLocalConfigurableSourceAdapter);
  const registry = createSourceAdapterRegistry(adapters);

  return {
    connectableSourceAdapters,
    connectPayloadSchema: createSchemaFromAdapters(
      connectableSourceAdapters.map((adapter) => adapter.connectPayloadSchema),
      "connect payload schema",
    ) as Schema.Schema<SchemaTypeOf<ConnectPayloadSchema<TAdapters>>, any, never>,
    executorAddableSourceAdapters,
    executorAddInputSchema: createSchemaFromAdapters(
      executorAddableSourceAdapters.map((adapter) => adapter.executorAddInputSchema),
      "executor add input schema",
    ) as Schema.Schema<SchemaTypeOf<ExecutorAddInputSchema<TAdapters>>, any, never>,
    localConfigurableSourceAdapters,
    ...registry,
  };
};

export type SourceAdapterComposition = ReturnType<typeof createSourceAdapterComposition>;
