import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Source } from "#schema";

import type { SourceAdapter } from "./types";
import {
  createStandardToolDescriptor,
  decodeBindingConfig,
  decodeSourceBindingPayload,
  emptySourceBindingState,
  encodeBindingConfig,
} from "./shared";

const InternalBindingConfigSchema = Schema.Struct({});

const INTERNAL_BINDING_CONFIG_VERSION = 1;

const bindingHasAnyField = (
  value: unknown,
  fields: readonly string[],
): boolean =>
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && fields.some((field) => Object.prototype.hasOwnProperty.call(value, field));

const internalBindingConfigFromSource = (source: Pick<Source, "id" | "bindingVersion" | "binding">) =>
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
      return yield* Effect.fail(
        new Error("internal sources cannot define HTTP source settings"),
      );
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

export const internalSourceAdapter: SourceAdapter = {
  key: "internal",
  displayName: "Internal",
  family: "internal",
  bindingConfigVersion: INTERNAL_BINDING_CONFIG_VERSION,
  providerKey: "generic_internal",
  defaultImportAuthPolicy: "none",
  primaryDocumentKind: null,
  primarySchemaBundleKind: null,
  connectPayloadSchema: null,
  executorAddInputSchema: null,
  executorAddHelpText: null,
  executorAddInputSignatureWidth: null,
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
  parseManifest: () => Effect.succeed(null),
  describePersistedOperation: ({ operation, path }) =>
    Effect.succeed({
      method: null,
      pathTemplate: null,
      rawToolId: null,
      operationId: null,
      group: null,
      leaf: null,
      tags: [],
      searchText: [path, operation.toolId, operation.title ?? "", operation.description ?? "", operation.searchText]
        .filter((part) => part.length > 0)
        .join(" ")
        .toLowerCase(),
      interaction: "auto",
      approvalLabel: null,
    } as const),
  createToolDescriptor: ({ source, operation, path, includeSchemas, schemaBundleId }) =>
    createStandardToolDescriptor({
      source,
      operation,
      path,
      includeSchemas,
      interaction: "auto",
      schemaBundleId,
    }),
  materializeSource: () => Effect.succeed({
    manifestJson: null,
    manifestHash: null,
    sourceHash: null,
    documents: [],
    schemaBundles: [],
    operations: [],
  }),
  invokePersistedTool: ({ path }) =>
    Effect.fail(new Error(`Unsupported stored tool provider for ${path}`)),
};
