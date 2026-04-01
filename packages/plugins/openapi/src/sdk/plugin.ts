import { Effect, Option } from "effect";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import type { Layer } from "effect";

import {
  Source,
  definePlugin,
  type ExecutorPlugin,
  type PluginContext,
  ToolId,
  type ToolRegistration,
} from "@executor/sdk";

import { parse } from "./parse";
import { extract } from "./extract";
import { compileToolDefinitions, type ToolDefinition } from "./definitions";
import { makeOpenApiInvoker } from "./invoke";
import { resolveBaseUrl } from "./openapi-utils";
import {
  makeInMemoryOperationStore,
  type OpenApiOperationStore,
} from "./operation-store";
import { previewSpec, type SpecPreview } from "./preview";
import {
  InvocationConfig,
  OperationBinding,
} from "./types";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

/** A header value — either a static string or a reference to a secret */
export type HeaderValue = string | { readonly secretId: string; readonly prefix?: string };

export interface OpenApiSpecConfig {
  readonly spec: string;
  readonly baseUrl?: string;
  readonly namespace?: string;
  /** Headers applied to every request. Values can reference secrets. */
  readonly headers?: Record<string, HeaderValue>;
}

// ---------------------------------------------------------------------------
// Plugin extension
// ---------------------------------------------------------------------------

export interface OpenApiPluginExtension {
  /** Preview a spec without registering — returns metadata, auth strategies, header presets */
  readonly previewSpec: (
    specText: string,
  ) => Effect.Effect<SpecPreview, Error>;

  /** Add an OpenAPI spec and register its operations as tools */
  readonly addSpec: (
    config: OpenApiSpecConfig,
  ) => Effect.Effect<{ readonly toolCount: number }, Error>;

  /** Remove all tools from a previously added spec by namespace */
  readonly removeSpec: (namespace: string) => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toRegistration = (
  def: ToolDefinition,
  namespace: string,
): ToolRegistration => {
  const op = def.operation;
  const description = Option.getOrElse(op.description, () =>
    Option.getOrElse(op.summary, () =>
      `${op.method.toUpperCase()} ${op.pathTemplate}`,
    ),
  );
  return {
    id: ToolId.make(`${namespace}.${def.toolPath}`),
    pluginKey: "openapi",
    sourceId: namespace,
    name: def.toolPath,
    description,
    inputSchema: Option.getOrUndefined(op.inputSchema),
    outputSchema: Option.getOrUndefined(op.outputSchema),
  };
};

const toBinding = (def: ToolDefinition): OperationBinding =>
  new OperationBinding({
    method: def.operation.method,
    pathTemplate: def.operation.pathTemplate,
    parameters: [...def.operation.parameters],
    requestBody: def.operation.requestBody,
  });

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export const openApiPlugin = (options?: {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly operationStore?: OpenApiOperationStore;
}): ExecutorPlugin<"openapi", OpenApiPluginExtension> => {
  const httpClientLayer = options?.httpClientLayer ?? FetchHttpClient.layer;
  const operationStore = options?.operationStore ?? makeInMemoryOperationStore();

  // Track added sources so we can list them
  const addedSources = new Map<string, Source>();

  return definePlugin({
    key: "openapi",
    init: (ctx: PluginContext) =>
      Effect.gen(function* () {
        yield* ctx.tools.registerInvoker(
          "openapi",
          makeOpenApiInvoker({
            operationStore,
            httpClientLayer,
            secrets: ctx.secrets,
            scopeId: ctx.scope.id,
          }),
        );

        // Register source manager so the core can list/remove/refresh our sources
        yield* ctx.sources.addManager({
          kind: "openapi",

          list: () =>
            Effect.sync(() => [...addedSources.values()]),

          remove: (sourceId: string) =>
            Effect.gen(function* () {
              // Clean up operation store
              yield* operationStore.removeByNamespace(sourceId);
              // Remove tools from registry
              yield* ctx.tools.unregisterBySource(sourceId);
              // Remove from our tracking
              addedSources.delete(sourceId);
            }),

          // TODO: refresh requires storing original config per namespace
        });

        return {
          extension: {
            previewSpec: (specText: string) => previewSpec(specText),

            addSpec: (config: OpenApiSpecConfig) =>
              Effect.gen(function* () {
                const doc = yield* parse(config.spec);
                const result = yield* extract(doc);

                const namespace =
                  config.namespace ??
                  Option.getOrElse(result.title, () => "api")
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "_");

                if (doc.components?.schemas) {
                  yield* ctx.tools.registerDefinitions(doc.components.schemas);
                }

                const baseUrl = config.baseUrl ?? resolveBaseUrl(result.servers);
                const invocationConfig = new InvocationConfig({
                  baseUrl,
                  headers: config.headers ?? {},
                });

                const definitions = compileToolDefinitions(result.operations);

                const registrations = definitions.map((def) =>
                  toRegistration(def, namespace),
                );

                yield* Effect.forEach(
                  definitions,
                  (def) =>
                    operationStore.put(
                      ToolId.make(`${namespace}.${def.toolPath}`),
                      namespace,
                      toBinding(def),
                      invocationConfig,
                    ),
                  { discard: true },
                );

                yield* ctx.tools.register(registrations);

                // Track the source
                const sourceName = Option.getOrElse(result.title, () => namespace);
                addedSources.set(namespace, new Source({
                  id: namespace,
                  name: sourceName,
                  kind: "openapi",
                }));

                return { toolCount: registrations.length };
              }),

            removeSpec: (namespace: string) =>
              Effect.gen(function* () {
                const toolIds = yield* operationStore.removeByNamespace(namespace);
                if (toolIds.length > 0) {
                  yield* ctx.tools.unregister(toolIds);
                }
                addedSources.delete(namespace);
              }),
          },

          close: () =>
            Effect.gen(function* () {
              for (const sourceId of addedSources.keys()) {
                yield* ctx.tools.unregisterBySource(sourceId);
              }
              addedSources.clear();
            }),
        };
      }),
  });
};
