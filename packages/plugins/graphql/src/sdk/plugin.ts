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
  type SecretId,
  type ToolRegistration,
} from "@executor/sdk";

import {
  introspect,
  parseIntrospectionJson,
  type IntrospectionResult,
  type IntrospectionType,
  type IntrospectionField,
} from "./introspect";
import { extract } from "./extract";
import { GraphqlExtractionError } from "./errors";
import { makeGraphqlInvoker } from "./invoke";
import type { GraphqlOperationStore, StoredSource } from "./operation-store";
import { makeInMemoryOperationStore } from "./kv-operation-store";
import {
  ExtractedField,
  HeaderValue as HeaderValueSchema,
  InvocationConfig,
  OperationBinding,
  type HeaderValue as HeaderValueValue,
  type GraphqlOperationKind,
} from "./types";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

export type HeaderValue = HeaderValueValue;

export interface GraphqlSourceConfig {
  /** The GraphQL endpoint URL */
  readonly endpoint: string;
  /** Optional: introspection JSON text (if endpoint doesn't support introspection) */
  readonly introspectionJson?: string;
  /** Namespace for the tools (derived from endpoint if not provided) */
  readonly namespace?: string;
  /** Headers applied to every request. Values can reference secrets. */
  readonly headers?: Record<string, HeaderValue>;
}

// ---------------------------------------------------------------------------
// Plugin extension
// ---------------------------------------------------------------------------

export interface GraphqlUpdateSourceInput {
  readonly endpoint?: string;
  readonly headers?: Record<string, HeaderValue>;
}

export interface GraphqlPluginExtension {
  /** Add a GraphQL endpoint and register its operations as tools */
  readonly addSource: (
    config: GraphqlSourceConfig,
  ) => Effect.Effect<{ readonly toolCount: number }, Error>;

  /** Remove all tools from a previously added GraphQL source by namespace */
  readonly removeSource: (namespace: string) => Effect.Effect<void>;

  /** Fetch the full stored source by namespace (or null if missing) */
  readonly getSource: (namespace: string) => Effect.Effect<StoredSource | null>;

  /** Update config (endpoint, headers) for an existing GraphQL source */
  readonly updateSource: (
    namespace: string,
    input: GraphqlUpdateSourceInput,
  ) => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AddSourceInputSchema = Schema.Struct({
  endpoint: Schema.String,
  introspectionJson: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: HeaderValueSchema })),
});
type AddSourceInput = typeof AddSourceInputSchema.Type;

const AddSourceOutputSchema = Schema.Struct({
  sourceId: Schema.String,
  toolCount: Schema.Number,
});

/** Derive a namespace from an endpoint URL */
const namespaceFromEndpoint = (endpoint: string): string => {
  try {
    const url = new URL(endpoint);
    return url.hostname.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  } catch {
    return "graphql";
  }
};

const buildOperationStringForField = (
  kind: GraphqlOperationKind,
  field: IntrospectionField,
  types: ReadonlyMap<string, IntrospectionType>,
): string => {
  const opType = kind === "query" ? "query" : "mutation";

  const varDefs = field.args.map((arg) => {
    const typeName = formatTypeRef(arg.type);
    return `$${arg.name}: ${typeName}`;
  });

  const argPasses = field.args.map((arg) => `${arg.name}: $${arg.name}`);
  const selectionSet = buildSelectionSet(field.type, types, 0, new Set());

  const varDefsStr = varDefs.length > 0 ? `(${varDefs.join(", ")})` : "";
  const argPassStr = argPasses.length > 0 ? `(${argPasses.join(", ")})` : "";

  return `${opType}${varDefsStr} { ${field.name}${argPassStr}${selectionSet ? ` ${selectionSet}` : ""} }`;
};

import type { IntrospectionTypeRef } from "./introspect";

const formatTypeRef = (ref: IntrospectionTypeRef): string => {
  switch (ref.kind) {
    case "NON_NULL":
      return ref.ofType ? `${formatTypeRef(ref.ofType)}!` : "Unknown!";
    case "LIST":
      return ref.ofType ? `[${formatTypeRef(ref.ofType)}]` : "[Unknown]";
    default:
      return ref.name ?? "Unknown";
  }
};

const unwrapTypeName = (ref: IntrospectionTypeRef): string => {
  if (ref.name) return ref.name;
  if (ref.ofType) return unwrapTypeName(ref.ofType);
  return "Unknown";
};

const buildSelectionSet = (
  ref: IntrospectionTypeRef,
  types: ReadonlyMap<string, IntrospectionType>,
  depth: number,
  seen: Set<string>,
): string => {
  if (depth > 2) return "";

  const leafName = unwrapTypeName(ref);
  if (seen.has(leafName)) return "";

  const objectType = types.get(leafName);
  if (!objectType?.fields) return "";

  const kind = objectType.kind;
  if (kind === "SCALAR" || kind === "ENUM") return "";

  seen.add(leafName);

  const subFields = objectType.fields
    .filter((f) => !f.name.startsWith("__"))
    .slice(0, 12)
    .map((f) => {
      const sub = buildSelectionSet(f.type, types, depth + 1, seen);
      return sub ? `${f.name} ${sub}` : f.name;
    });

  seen.delete(leafName);

  return subFields.length > 0 ? `{ ${subFields.join(" ")} }` : "";
};

const toRegistration = (field: ExtractedField, namespace: string): ToolRegistration => {
  const prefix = field.kind === "mutation" ? "mutation" : "query";
  const toolPath = `${prefix}.${field.fieldName}`;
  const description = Option.getOrElse(
    field.description,
    () => `GraphQL ${field.kind}: ${field.fieldName} -> ${field.returnTypeName}`,
  );

  return {
    id: ToolId.make(`${namespace}.${toolPath}`),
    pluginKey: "graphql",
    sourceId: namespace,
    name: toolPath,
    description,
    inputSchema: Option.getOrUndefined(field.inputSchema),
    outputSchema: undefined,
  };
};

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export const graphqlPlugin = (options?: {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly operationStore?: GraphqlOperationStore;
}): ExecutorPlugin<"graphql", GraphqlPluginExtension> => {
  const httpClientLayer = options?.httpClientLayer ?? FetchHttpClient.layer;
  const operationStore = options?.operationStore ?? makeInMemoryOperationStore();

  return definePlugin({
    key: "graphql",
    init: (ctx: PluginContext) =>
      Effect.gen(function* () {
        yield* ctx.tools.registerInvoker(
          "graphql",
          makeGraphqlInvoker({
            operationStore,
            httpClientLayer,
            secrets: ctx.secrets,
            scopeId: ctx.scope.id,
          }),
        );

        yield* ctx.sources.addManager({
          kind: "graphql",

          list: () =>
            operationStore.listSources().pipe(
              Effect.map((metas) =>
                metas.map(
                  (s) =>
                    new Source({
                      id: s.namespace,
                      name: s.name,
                      kind: "graphql",
                      url: s.config.endpoint,
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

              const ok = yield* introspect(trimmed).pipe(
                Effect.provide(httpClientLayer),
                Effect.map(() => true),
                Effect.catchAll(() => Effect.succeed(false)),
              );

              if (!ok) return null;

              const name = namespaceFromEndpoint(trimmed);
              return new SourceDetectionResult({
                kind: "graphql",
                confidence: "high",
                endpoint: trimmed,
                name,
                namespace: name,
              });
            }),
        });

        const addSourceInternal = (config: GraphqlSourceConfig) =>
          Effect.gen(function* () {
            // Get introspection result — either by querying the endpoint or parsing provided JSON
            let introspectionResult: IntrospectionResult;
            if (config.introspectionJson) {
              introspectionResult = yield* parseIntrospectionJson(config.introspectionJson);
            } else {
              // Resolve all headers (including secret refs) for introspection
              const resolvedHeaders: Record<string, string> = {};
              if (config.headers) {
                for (const [name, value] of Object.entries(config.headers)) {
                  if (typeof value === "string") {
                    resolvedHeaders[name] = value;
                  } else {
                    const secret = yield* ctx.secrets
                      .resolve(value.secretId as SecretId, ctx.scope.id)
                      .pipe(Effect.catchAll(() => Effect.succeed("")));
                    if (secret) {
                      resolvedHeaders[name] = value.prefix ? `${value.prefix}${secret}` : secret;
                    }
                  }
                }
              }

              introspectionResult = yield* introspect(
                config.endpoint,
                Object.keys(resolvedHeaders).length > 0 ? resolvedHeaders : undefined,
              ).pipe(Effect.provide(httpClientLayer));
            }

            const { result, definitions } = yield* extract(introspectionResult);
            const namespace = config.namespace ?? namespaceFromEndpoint(config.endpoint);

            // Register shared JSON Schema definitions ($ref targets)
            if (Object.keys(definitions).length > 0) {
              yield* ctx.tools.registerDefinitions(definitions);
            }

            const invocationConfig = new InvocationConfig({
              endpoint: config.endpoint,
              headers: config.headers ?? {},
            });

            // Build type map for operation string generation
            const typeMap = new Map<string, IntrospectionType>();
            for (const t of introspectionResult.__schema.types) {
              typeMap.set(t.name, t);
            }

            // Build field map for operation strings
            const fieldMap = new Map<
              string,
              { kind: GraphqlOperationKind; field: IntrospectionField }
            >();
            const schema = introspectionResult.__schema;

            for (const rootKind of ["query", "mutation"] as const) {
              const typeName =
                rootKind === "query" ? schema.queryType?.name : schema.mutationType?.name;
              if (!typeName) continue;
              const rootType = typeMap.get(typeName);
              if (!rootType?.fields) continue;
              for (const f of rootType.fields) {
                if (!f.name.startsWith("__")) {
                  fieldMap.set(`${rootKind}.${f.name}`, { kind: rootKind, field: f });
                }
              }
            }

            const registrations: ToolRegistration[] = [];

            yield* Effect.forEach(
              result.fields,
              (extractedField) => {
                const reg = toRegistration(extractedField, namespace);
                registrations.push(reg);

                const key = `${extractedField.kind}.${extractedField.fieldName}`;
                const entry = fieldMap.get(key);

                const operationString = entry
                  ? buildOperationStringForField(entry.kind, entry.field, typeMap)
                  : `${extractedField.kind} { ${extractedField.fieldName} }`;

                const binding = new OperationBinding({
                  kind: extractedField.kind,
                  fieldName: extractedField.fieldName,
                  operationString,
                  variableNames: extractedField.arguments.map((a) => a.name),
                });

                return operationStore.put(reg.id, namespace, binding);
              },
              { discard: true },
            );

            yield* ctx.tools.register(registrations);

            yield* operationStore.putSource({
              namespace,
              name: namespace,
              config: {
                endpoint: config.endpoint,
                introspectionJson: config.introspectionJson,
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
          pluginKey: "graphql",
          source: {
            id: "built-in",
            name: "Built In",
            kind: "built-in",
          },
          tools: [
            runtimeTool({
              id: "graphql.addSource",
              name: "graphql.addSource",
              description: "Add a GraphQL endpoint and register its operations as tools",
              inputSchema: AddSourceInputSchema,
              outputSchema: AddSourceOutputSchema,
              handler: (input: AddSourceInput) => addSourceInternal(input),
            }),
          ],
        });

        return {
          extension: {
            addSource: (config: GraphqlSourceConfig) =>
              addSourceInternal(config).pipe(
                Effect.map(({ toolCount }) => ({ toolCount })),
                Effect.mapError(
                  (err) =>
                    new GraphqlExtractionError({
                      message: err instanceof Error ? err.message : String(err),
                    }),
                ),
              ),

            removeSource: (namespace: string) =>
              Effect.gen(function* () {
                const toolIds = yield* operationStore.removeByNamespace(namespace);
                if (toolIds.length > 0) {
                  yield* ctx.tools.unregister(toolIds);
                }
                yield* operationStore.removeSource(namespace);
              }),

            getSource: (namespace: string) => operationStore.getSource(namespace),

            updateSource: (namespace: string, input: GraphqlUpdateSourceInput) =>
              Effect.gen(function* () {
                const existing = yield* operationStore.getSource(namespace);
                if (!existing) return;

                const updatedConfig = {
                  ...existing.config,
                  ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
                  ...(input.headers !== undefined
                    ? { headers: input.headers as Record<string, HeaderValueValue> }
                    : {}),
                };

                const newInvocationConfig = new InvocationConfig({
                  endpoint: updatedConfig.endpoint,
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
