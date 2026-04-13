import { Effect, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import type { Layer } from "effect";

import {
  Source,
  SourceDetectionResult,
  definePlugin,
  registerRuntimeTools,
  runtimeTool,
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
import type { OpenApiOperationStore, StoredSource } from "./operation-store";
import { makeInMemoryOperationStore } from "./kv-operation-store";
import { previewSpec, SpecPreview } from "./preview";
import {
  HeaderValue as HeaderValueSchema,
  InvocationConfig,
  OperationBinding,
  type HeaderValue as HeaderValueValue,
} from "./types";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

/** A header value — either a static string or a reference to a secret */
export type HeaderValue = HeaderValueValue;

export interface OpenApiSpecConfig {
  readonly spec: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly namespace?: string;
  /** Headers applied to every request. Values can reference secrets. */
  readonly headers?: Record<string, HeaderValue>;
}

// ---------------------------------------------------------------------------
// Plugin extension
// ---------------------------------------------------------------------------

export interface OpenApiUpdateSourceInput {
  readonly baseUrl?: string;
  readonly headers?: Record<string, HeaderValue>;
}

export interface OpenApiPluginExtension {
  /** Preview a spec without registering — returns metadata, auth strategies, header presets */
  readonly previewSpec: (specText: string) => Effect.Effect<SpecPreview, Error>;

  /** Add an OpenAPI spec and register its operations as tools */
  readonly addSpec: (
    config: OpenApiSpecConfig,
  ) => Effect.Effect<{ readonly toolCount: number }, Error>;

  /** Remove all tools from a previously added spec by namespace */
  readonly removeSpec: (namespace: string) => Effect.Effect<void>;

  /** Fetch the full stored source by namespace (or null if missing) */
  readonly getSource: (namespace: string) => Effect.Effect<StoredSource | null>;

  /** Update config (baseUrl, headers) for an existing OpenAPI source */
  readonly updateSource: (
    namespace: string,
    input: OpenApiUpdateSourceInput,
  ) => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PreviewSpecInputSchema = Schema.Struct({
  spec: Schema.String,
});
type PreviewSpecInput = typeof PreviewSpecInputSchema.Type;

const AddSourceInputSchema = Schema.Struct({
  spec: Schema.String,
  baseUrl: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: HeaderValueSchema })),
});
type AddSourceInput = typeof AddSourceInputSchema.Type;

const AddSourceOutputSchema = Schema.Struct({
  sourceId: Schema.String,
  toolCount: Schema.Number,
});

/** Rewrite OpenAPI `#/components/schemas/X` refs to standard `#/$defs/X`. */
const normalizeOpenApiRefs = (node: unknown): unknown => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((item) => {
      const n = normalizeOpenApiRefs(item);
      if (n !== item) changed = true;
      return n;
    });
    return changed ? out : node;
  }

  const obj = node as Record<string, unknown>;

  if (typeof obj.$ref === "string") {
    const match = obj.$ref.match(/^#\/components\/schemas\/(.+)$/);
    if (match) return { ...obj, $ref: `#/$defs/${match[1]}` };
    return obj;
  }

  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = normalizeOpenApiRefs(v);
    if (n !== v) changed = true;
    result[k] = n;
  }
  return changed ? result : obj;
};

const toRegistration = (def: ToolDefinition, namespace: string): ToolRegistration => {
  const op = def.operation;
  const description = Option.getOrElse(op.description, () =>
    Option.getOrElse(op.summary, () => `${op.method.toUpperCase()} ${op.pathTemplate}`),
  );
  return {
    id: ToolId.make(`${namespace}.${def.toolPath}`),
    pluginKey: "openapi",
    sourceId: namespace,
    name: def.toolPath,
    description,
    inputSchema: normalizeOpenApiRefs(Option.getOrUndefined(op.inputSchema)),
    outputSchema: normalizeOpenApiRefs(Option.getOrUndefined(op.outputSchema)),
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

        // Tools are already persisted in the KV tool registry — no need to
        // re-register them. We only need the source list and the invoker.
        // Register source manager so the core can list/remove/refresh our sources
        yield* ctx.sources.addManager({
          kind: "openapi",

          list: () =>
            operationStore.listSources().pipe(
              Effect.map((metas) =>
                metas.map(
                  (s) =>
                    new Source({
                      id: s.namespace,
                      name: s.name,
                      kind: "openapi",
                      url: s.config.baseUrl,
                      runtime: false,
                      canRemove: true,
                      canRefresh: false,
                      canEdit: true,
                    }),
                ),
              ),
            ),

          remove: (sourceId: string) =>
            Effect.gen(function* () {
              yield* operationStore.removeByNamespace(sourceId);
              yield* operationStore.removeSource(sourceId);
              yield* ctx.tools.unregisterBySource(sourceId);
            }),

          detect: (url: string) =>
            Effect.gen(function* () {
              const trimmed = url.trim();
              if (!trimmed) return null;
              const parsed = yield* Effect.try(() => new URL(trimmed)).pipe(Effect.option);
              if (parsed._tag === "None") return null;

              // Try fetching the URL and parsing as OpenAPI spec
              // parse() handles both URLs directly and spec text
              const doc = yield* parse(trimmed).pipe(Effect.catchAll(() => Effect.succeed(null)));
              if (!doc) return null;

              const result = yield* extract(doc).pipe(Effect.catchAll(() => Effect.succeed(null)));
              if (!result) return null;

              const namespace = Option.getOrElse(result.title, () => "api")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_");
              const name = Option.getOrElse(result.title, () => namespace);

              return new SourceDetectionResult({
                kind: "openapi",
                confidence: "high",
                endpoint: trimmed,
                name,
                namespace,
              });
            }),
        });

        const addSpecInternal = (config: OpenApiSpecConfig) =>
          Effect.gen(function* () {
            const doc = yield* parse(config.spec);
            const result = yield* extract(doc);

            const namespace =
              config.namespace ??
              Option.getOrElse(result.title, () => "api")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_");

            if (doc.components?.schemas) {
              // Normalize OpenAPI $ref format to standard JSON Schema $defs
              const defs: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(doc.components.schemas)) {
                defs[k] = normalizeOpenApiRefs(v);
              }
              yield* ctx.tools.registerDefinitions(defs);
            }

            const baseUrl = config.baseUrl ?? resolveBaseUrl(result.servers);
            const invocationConfig = new InvocationConfig({
              baseUrl,
              headers: config.headers ?? {},
            });

            const definitions = compileToolDefinitions(result.operations);

            const registrations = definitions.map((def) => toRegistration(def, namespace));

            yield* operationStore.put(
              definitions.map((def) => ({
                toolId: ToolId.make(`${namespace}.${def.toolPath}`),
                namespace,
                binding: toBinding(def),
              })),
            );

            yield* ctx.tools.register(registrations);

            const sourceName = config.name ?? Option.getOrElse(result.title, () => namespace);
            yield* operationStore.putSource({
              namespace,
              name: sourceName,
              config: {
                spec: config.spec,
                baseUrl: config.baseUrl,
                namespace: config.namespace,
                headers: config.headers,
              },
              invocationConfig,
            });

            return { sourceId: namespace, toolCount: registrations.length };
          });

        const runtimeTools = yield* registerRuntimeTools({
          registry: ctx.tools,
          sources: ctx.sources,
          pluginKey: "openapi",
          source: {
            id: "built-in",
            name: "Built In",
            kind: "built-in",
          },
          tools: [
            runtimeTool({
              id: "openapi.previewSpec",
              name: "openapi.previewSpec",
              description: "Preview an OpenAPI document before adding it as a source",
              inputSchema: PreviewSpecInputSchema,
              outputSchema: SpecPreview,
              handler: ({ spec }: PreviewSpecInput) => previewSpec(spec),
            }),
            runtimeTool({
              id: "openapi.addSource",
              name: "openapi.addSource",
              description: "Add an OpenAPI source and register its operations as tools",
              inputSchema: AddSourceInputSchema,
              outputSchema: AddSourceOutputSchema,
              handler: (input: AddSourceInput) => addSpecInternal(input),
            }),
          ],
        });

        return {
          extension: {
            previewSpec: (specText: string) => previewSpec(specText),

            addSpec: (config: OpenApiSpecConfig) =>
              addSpecInternal(config).pipe(Effect.map(({ toolCount }) => ({ toolCount }))),

            removeSpec: (namespace: string) =>
              Effect.gen(function* () {
                const toolIds = yield* operationStore.removeByNamespace(namespace);
                if (toolIds.length > 0) {
                  yield* ctx.tools.unregister(toolIds);
                }
                yield* operationStore.removeSource(namespace);
              }),

            getSource: (namespace: string) => operationStore.getSource(namespace),

            updateSource: (namespace: string, input: OpenApiUpdateSourceInput) =>
              Effect.gen(function* () {
                const existing = yield* operationStore.getSource(namespace);
                if (!existing) return;

                const updatedConfig = {
                  ...existing.config,
                  ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
                  ...(input.headers !== undefined
                    ? { headers: input.headers as Record<string, HeaderValueValue> }
                    : {}),
                };

                const newInvocationConfig = new InvocationConfig({
                  baseUrl: updatedConfig.baseUrl ?? existing.invocationConfig.baseUrl,
                  headers: (updatedConfig.headers ?? {}) as Record<string, HeaderValueValue>,
                });

                yield* operationStore.putSource({
                  namespace,
                  name: existing.name,
                  config: updatedConfig,
                  invocationConfig: newInvocationConfig,
                });
              }),
          },

          close: () => runtimeTools.close(),
        };
      }),
  });
};
