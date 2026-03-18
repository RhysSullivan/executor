import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  createSourceCatalogSyncResult,
  createCatalogImportMetadata,
  decodeBindingConfig,
  decodeSourceBindingPayload,
  emptySourceBindingState,
  encodeBindingConfig,
  type Source,
  type SourceAdapter,
} from "@executor/source-core";
import { runtimeEffectError } from "../../effect-errors";

const InternalBindingConfigSchema = Schema.Struct({});

const INTERNAL_BINDING_CONFIG_VERSION = 1;

const bindingHasAnyField = (
  value: unknown,
  fields: readonly string[],
): boolean =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  fields.some((field) => Object.prototype.hasOwnProperty.call(value, field));

const internalBindingConfigFromSource = (
  source: Pick<Source, "id" | "bindingVersion" | "binding">,
) =>
  Effect.gen(function* () {
    if (
      bindingHasAnyField(source.binding, [
        "specUrl",
        "defaultHeaders",
        "transport",
        "queryParams",
        "headers",
      ])
    ) {
      return yield* runtimeEffectError("sources/source-adapters/internal", "internal sources cannot define HTTP source settings");
    }

    return yield* decodeSourceBindingPayload({
      sourceId: source.id,
      label: "internal",
      version: source.bindingVersion,
      expectedVersion: INTERNAL_BINDING_CONFIG_VERSION,
      schema: InternalBindingConfigSchema,
      value: source.binding,
      allowedKeys: [],
    });
  });

export const internalSourceAdapter = {
  key: "internal",
  displayName: "Internal",
  catalogKind: "internal",
  connectStrategy: "none",
  credentialStrategy: "none",
  bindingConfigVersion: INTERNAL_BINDING_CONFIG_VERSION,
  providerKey: "generic_internal",
  defaultImportAuthPolicy: "none",
  connectPayloadSchema: null,
  executorAddInputSchema: null,
  executorAddHelpText: null,
  executorAddInputSignatureWidth: null,
  localConfigBindingSchema: null,
  localConfigBindingFromSource: () => null,
  serializeBindingConfig: (source) =>
    encodeBindingConfig({
      adapterKey: source.kind,
      version: INTERNAL_BINDING_CONFIG_VERSION,
      payloadSchema: InternalBindingConfigSchema,
      payload: Effect.runSync(internalBindingConfigFromSource(source)),
    }),
  deserializeBindingConfig: ({ id, bindingConfigJson }) =>
    Effect.map(
      decodeBindingConfig({
        sourceId: id,
        label: "internal",
        adapterKey: "internal",
        version: INTERNAL_BINDING_CONFIG_VERSION,
        payloadSchema: InternalBindingConfigSchema,
        value: bindingConfigJson,
      }),
      ({ version, payload }) => ({
        version,
        payload,
      }),
    ),
  bindingStateFromSource: () => Effect.succeed(emptySourceBindingState),
  sourceConfigFromSource: (source) => ({
    kind: "internal",
    endpoint: source.endpoint,
  }),
  validateSource: (source) =>
    Effect.gen(function* () {
      yield* internalBindingConfigFromSource(source);

      return {
        ...source,
        bindingVersion: INTERNAL_BINDING_CONFIG_VERSION,
        binding: {},
      };
    }),
  shouldAutoProbe: () => false,
  syncCatalog: ({ source }) =>
    Effect.succeed(
      createSourceCatalogSyncResult({
        fragment: {
          version: "ir.v1.fragment",
        },
        importMetadata: {
          ...createCatalogImportMetadata({
            source,
            adapterKey: "internal",
          }),
          importerVersion: "ir.v1.internal",
          sourceConfigHash: "internal",
        },
        sourceHash: null,
      }),
    ),
  invoke: () =>
    Effect.fail(
      runtimeEffectError("sources/source-adapters/internal", "Internal sources do not support persisted adapter invocation"),
    ),
} satisfies SourceAdapter;
