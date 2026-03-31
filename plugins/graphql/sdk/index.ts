import {
  applyCookiePlacementsToHeaders,
  applyHttpQueryPlacementsToUrl,
  applyJsonBodyPlacements,
} from "@executor/codemode-core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  createCatalogImportMetadata,
  createSourceCatalogSyncResult,
} from "@executor/source-core";
import type {
  ExecutorScopeConfig,
  Source,
} from "@executor/platform-sdk/schema";
import {
  SourceSchema,
} from "@executor/platform-sdk/schema";
import {
  defineExecutorSourcePlugin,
} from "@executor/platform-sdk/plugins";
import {
  SecretMaterialResolverService,
  createPluginScopeConfigEntrySchema,
  pluginScopeConfigSourceFromConfig,
  provideExecutorRuntime,
  runtimeEffectError,
} from "@executor/platform-sdk/runtime";
import {
  deriveGraphqlNamespace,
  GraphqlConnectInputSchema,
  GraphqlConnectionAuthSchema,
  GraphqlSourceConfigPayloadSchema,
  GraphqlStoredSourceDataSchema,
  GraphqlUpdateSourceInputSchema,
  type GraphqlConnectInput,
  type GraphqlSourceConfigPayload,
  type GraphqlStoredSourceData,
  type GraphqlUpdateSourceInput,
} from "@executor/plugin-graphql-shared";

import {
  createGraphqlCatalogFragment,
  type GraphqlCatalogOperationInput,
} from "./catalog";
import {
  compileGraphqlToolDefinitions,
  extractGraphqlManifest,
  GRAPHQL_INTROSPECTION_QUERY,
  buildGraphqlToolPresentation,
} from "./graphql-tools";
import {
  GraphqlToolProviderDataSchema,
  type GraphqlToolProviderData,
} from "./provider-data";

const GraphqlSourceIdInputSchema = Schema.Struct({
  sourceId: Schema.String,
});

const decodeStoredSourceData = Schema.decodeUnknownSync(GraphqlStoredSourceDataSchema);
const decodeProviderData = Schema.decodeUnknownSync(GraphqlToolProviderDataSchema);

export type GraphqlSourceStorage = {
  get: (input: {
    scopeId: string;
    sourceId: string;
  }) => Effect.Effect<GraphqlStoredSourceData | null, Error, never>;
  put: (input: {
    scopeId: string;
    sourceId: string;
    value: GraphqlStoredSourceData;
  }) => Effect.Effect<void, Error, never>;
  remove?: (input: {
    scopeId: string;
    sourceId: string;
  }) => Effect.Effect<void, Error, never>;
};

export type GraphqlSdk = {
  getSourceConfig: (
    sourceId: Source["id"],
  ) => Effect.Effect<GraphqlSourceConfigPayload, Error>;
  createSource: (
    input: GraphqlConnectInput,
  ) => Effect.Effect<Source, Error>;
  updateSource: (
    input: GraphqlUpdateSourceInput,
  ) => Effect.Effect<Source, Error>;
  removeSource: (
    sourceId: Source["id"],
  ) => Effect.Effect<boolean, Error>;
};

const GraphqlExecutorAddInputSchema = Schema.Struct({
  kind: Schema.Literal("graphql"),
  name: Schema.String,
  iconUrl: Schema.optional(Schema.String),
  endpoint: Schema.String,
  defaultHeaders: Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.String })),
  auth: GraphqlConnectionAuthSchema,
});

type GraphqlExecutorAddInput = typeof GraphqlExecutorAddInputSchema.Type;

const normalizeGraphqlAuth = (
  auth: Record<string, unknown>,
): GraphqlStoredSourceData["auth"] =>
  auth.kind === "bearer"
    ? {
        kind: "bearer",
        tokenSecretRef: auth.tokenSecretRef as Extract<
          GraphqlStoredSourceData["auth"],
          { kind: "bearer" }
        >["tokenSecretRef"],
        headerName:
          typeof auth.headerName === "string" || auth.headerName === null
            ? auth.headerName
            : null,
        prefix:
          typeof auth.prefix === "string" || auth.prefix === null
            ? auth.prefix
            : null,
      }
    : {
        kind: "none",
      };

const normalizeStoredSourceData = (
  stored: GraphqlStoredSourceData,
): GraphqlStoredSourceData =>
  decodeStoredSourceData({
    ...stored,
    auth: normalizeGraphqlAuth(stored.auth as Record<string, unknown>),
  });

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const asStringRecord = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(asRecord(value)).flatMap(([key, entry]) =>
      typeof entry === "string" ? [[key, entry]] : [],
    ),
  );

const decodeGraphqlCurrentLocalConfigOption = Schema.decodeUnknownOption(
  createPluginScopeConfigEntrySchema({
    kind: "graphql",
    config: GraphqlStoredSourceDataSchema,
  }),
);

const withoutUndefinedEntries = (
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );

const responseHeadersRecord = (response: Response): Record<string, string> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
};

const parseGraphqlResponseBody = async (
  response: Response,
): Promise<unknown> => {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.text();
};

const resolveBearerToken = (
  auth: GraphqlStoredSourceData["auth"],
): Effect.Effect<string | null, Error, SecretMaterialResolverService> =>
  auth.kind === "none"
    ? Effect.succeed(null)
    : Effect.flatMap(SecretMaterialResolverService, (resolveSecretMaterial) =>
        resolveSecretMaterial({
          ref: auth.tokenSecretRef,
        }).pipe(Effect.map((token) => token.trim()))
      );

const resolveBearerHeaderName = (
  auth: Extract<GraphqlStoredSourceData["auth"], { kind: "bearer" }>,
): string => {
  const trimmed = auth.headerName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "Authorization";
};

const resolveBearerPrefix = (
  auth: Extract<GraphqlStoredSourceData["auth"], { kind: "bearer" }>,
): string => auth.prefix ?? "Bearer ";

const resolveGraphqlHeaders = (
  stored: GraphqlStoredSourceData,
): Effect.Effect<Record<string, string>, Error, SecretMaterialResolverService> =>
  Effect.gen(function* () {
    const bearerToken = yield* resolveBearerToken(stored.auth);
    return {
      ...stored.defaultHeaders,
      ...(bearerToken && stored.auth.kind === "bearer"
        ? {
            [resolveBearerHeaderName(stored.auth)]:
              `${resolveBearerPrefix(stored.auth)}${bearerToken}`,
          }
        : {}),
    };
  });

const fetchGraphqlIntrospectionDocumentWithHeaders = (input: {
  endpoint: string;
  headers: Readonly<Record<string, string>>;
}): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      let response: Response;
      try {
        response = await fetch(input.endpoint, {
          method: "POST",
          headers: {
            accept: "application/graphql-response+json, application/json",
            "content-type": "application/json",
            ...input.headers,
          },
          body: JSON.stringify({ query: GRAPHQL_INTROSPECTION_QUERY }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (cause) {
        if (
          cause instanceof Error &&
          (cause.name === "AbortError" || cause.name === "TimeoutError")
        ) {
          throw new Error("GraphQL introspection timed out after 15000ms");
        }
        throw cause;
      }

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        throw new Error(
          `GraphQL introspection endpoint did not return JSON: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(
            `GraphQL introspection requires credentials (status ${response.status})`,
          );
        }

        throw new Error(
          `GraphQL introspection failed with status ${response.status}`,
        );
      }

      return JSON.stringify(parsed, null, 2);
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  });

const graphqlCatalogOperationFromDefinition = (input: {
  definition: ReturnType<typeof compileGraphqlToolDefinitions>[number];
  manifest: Parameters<typeof buildGraphqlToolPresentation>[0]["manifest"];
}): GraphqlCatalogOperationInput => {
  const presentation = buildGraphqlToolPresentation({
    manifest: input.manifest,
    definition: input.definition,
  });

  return {
    toolId: input.definition.toolId,
    title: input.definition.name,
    description: input.definition.description,
    effect: input.definition.operationType === "query" ? "read" : "write",
    inputSchema: presentation.inputSchema,
    outputSchema: presentation.outputSchema,
    providerData: presentation.providerData as GraphqlToolProviderData,
  };
};

const storedSourceDataFromInput = (
  input: GraphqlConnectInput,
): GraphqlStoredSourceData =>
  decodeStoredSourceData({
    endpoint: input.endpoint.trim(),
    defaultHeaders: input.defaultHeaders,
    auth:
      input.auth.kind === "bearer"
        ? {
            ...input.auth,
            headerName: input.auth.headerName ?? null,
            prefix: input.auth.prefix ?? null,
          }
        : input.auth,
  });

const sourceConfigFromStored = (
  source: Source,
  stored: GraphqlStoredSourceData,
): GraphqlSourceConfigPayload => ({
  name: source.name,
  endpoint: stored.endpoint,
  defaultHeaders: stored.defaultHeaders,
  auth: stored.auth,
});

const graphqlConnectInputFromAddInput = (
  input: GraphqlExecutorAddInput,
): GraphqlConnectInput => ({
  name: input.name,
  ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}),
  endpoint: input.endpoint,
  defaultHeaders: input.defaultHeaders,
  auth: input.auth,
});

const graphqlStoredSourceDataFromLocalConfig = (input: {
  config: unknown;
  loadedConfig: ExecutorScopeConfig | null;
}): GraphqlStoredSourceData => {
  const current = decodeGraphqlCurrentLocalConfigOption(input.config);
  if (Option.isSome(current)) {
    return normalizeStoredSourceData(current.value.config);
  }
  throw new Error("Unsupported GraphQL local source config.");
};

export const graphqlSdkPlugin = (options: {
  storage: GraphqlSourceStorage;
}) => defineExecutorSourcePlugin<
  "graphql",
  GraphqlExecutorAddInput,
  GraphqlConnectInput,
  GraphqlSourceConfigPayload,
  GraphqlStoredSourceData,
  GraphqlUpdateSourceInput,
  GraphqlSdk
>({
  key: "graphql",
  source: {
    kind: "graphql",
    displayName: "GraphQL",
    add: {
      inputSchema: GraphqlExecutorAddInputSchema,
      inputSignatureWidth: 300,
      helpText: [
        "Point `endpoint` at the GraphQL HTTP endpoint and choose `auth.kind`.",
      ],
      toConnectInput: graphqlConnectInputFromAddInput,
    },
    storage: options.storage,
    source: {
      create: (input) => ({
        source: {
          name: input.name.trim(),
          kind: "graphql",
          status: "connected",
          enabled: true,
          namespace: deriveGraphqlNamespace({
            endpoint: input.endpoint,
            title: input.name,
          }),
          ...(input.iconUrl?.trim() ? { iconUrl: input.iconUrl.trim() } : {}),
        },
        stored: storedSourceDataFromInput(input),
      }),
      update: ({ source, config }) => ({
        source: {
          ...source,
          name: config.name.trim(),
          namespace: deriveGraphqlNamespace({
            endpoint: config.endpoint,
            title: config.name,
          }),
          iconUrl: config.iconUrl?.trim() || undefined,
        },
        stored: storedSourceDataFromInput(config),
      }),
      toConfig: ({ source, stored }) =>
        sourceConfigFromStored(source, normalizeStoredSourceData(stored)),
    },
    scopeConfig: {
      toConfigSource: ({ source, stored }) =>
        pluginScopeConfigSourceFromConfig({
          source,
          config: normalizeStoredSourceData(stored),
        }),
      recoverStored: ({ config, loadedConfig }) =>
        graphqlStoredSourceDataFromLocalConfig({
          config,
          loadedConfig,
        }),
    },
    catalog: {
      kind: "imported",
      identity: ({ source }) => ({
        kind: "graphql",
        sourceId: source.id,
      }),
      sync: ({ source, stored }) =>
        Effect.gen(function* () {
          if (stored === null) {
            return yield* runtimeEffectError(
              "plugins/graphql/sdk",
              `GraphQL source storage missing for ${source.id}`,
            );
          }

          const normalizedStored = normalizeStoredSourceData(stored);
          const headers = yield* resolveGraphqlHeaders(normalizedStored);
          const graphqlDocument = yield* fetchGraphqlIntrospectionDocumentWithHeaders({
            endpoint: normalizedStored.endpoint,
            headers,
          });
          const manifest = yield* extractGraphqlManifest(source.name, graphqlDocument);
          const definitions = yield* Effect.sync(() =>
            compileGraphqlToolDefinitions(manifest),
          );
          const operations = definitions.map((definition) =>
            graphqlCatalogOperationFromDefinition({
              definition,
              manifest,
            }),
          );
          const now = Date.now();

          return createSourceCatalogSyncResult({
            fragment: createGraphqlCatalogFragment({
              source,
              documents: [
                {
                  documentKind: "graphql_introspection",
                  documentKey: normalizedStored.endpoint,
                  contentText: graphqlDocument,
                  fetchedAt: now,
                },
              ],
              operations,
            }),
            importMetadata: {
              ...createCatalogImportMetadata({
                source,
                pluginKey: "graphql",
              }),
              importerVersion: "ir.v1.graphql",
            },
            sourceHash: manifest.sourceHash,
          });
        }),
      invoke: (input) =>
        Effect.gen(function* () {
          if (input.stored === null) {
            return yield* runtimeEffectError(
              "plugins/graphql/sdk",
              `GraphQL source storage missing for ${input.source.id}`,
            );
          }

          const normalizedStored = normalizeStoredSourceData(input.stored);
          const providerData = decodeProviderData(
            input.executable.binding,
          ) as GraphqlToolProviderData;
          const args = asRecord(input.args);
          const headers = {
            "content-type": "application/json",
            ...(yield* resolveGraphqlHeaders(normalizedStored)),
            ...asStringRecord(args.headers),
          };
          const endpoint = applyHttpQueryPlacementsToUrl({
            url: normalizedStored.endpoint,
          }).toString();

          const isRawRequest =
            providerData.toolKind === "request"
            || typeof providerData.operationDocument !== "string"
            || providerData.operationDocument.trim().length === 0;
          const query = isRawRequest
            ? (() => {
                const value = asString(args.query);
                if (value === null) {
                  throw new Error("GraphQL request tools require args.query");
                }
                return value;
              })()
            : providerData.operationDocument!;
          const variables = isRawRequest
            ? args.variables !== undefined
              ? asRecord(args.variables)
              : undefined
            : withoutUndefinedEntries(
                Object.fromEntries(
                  Object.entries(args).filter(([key]) => key !== "headers"),
                ),
              );
          const operationName = isRawRequest
            ? (asString(args.operationName) ?? undefined)
            : (providerData.operationName ?? undefined);

          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(endpoint, {
                method: "POST",
                headers: applyCookiePlacementsToHeaders({
                  headers,
                  cookies: {},
                }),
                body: JSON.stringify(
                  applyJsonBodyPlacements({
                    body: {
                      query,
                      ...(variables ? { variables } : {}),
                      ...(operationName ? { operationName } : {}),
                    },
                    bodyValues: {},
                    label: `GraphQL invocation ${normalizedStored.endpoint}`,
                  }),
                ),
              }),
            catch: (cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
          });
          const body = yield* Effect.tryPromise({
            try: () => parseGraphqlResponseBody(response),
            catch: (cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
          });
          const bodyRecord = asRecord(body);
          const hasErrors =
            Array.isArray(bodyRecord.errors) && bodyRecord.errors.length > 0;

          return {
            data: response.ok ? (bodyRecord.data ?? body) : null,
            error:
              response.ok && !hasErrors
                ? null
                : bodyRecord.errors ?? body,
            headers: responseHeadersRecord(response),
            status: response.status,
          };
        }),
    },
  },
  tools: [
    {
      name: "getSourceConfig",
      description: "Load the saved configuration for a GraphQL source.",
      inputSchema: GraphqlSourceIdInputSchema,
      outputSchema: GraphqlSourceConfigPayloadSchema,
      execute: ({ args, source }) => source.getSourceConfig(args.sourceId),
    },
    {
      name: "createSource",
      description: "Create a GraphQL source.",
      inputSchema: GraphqlConnectInputSchema,
      outputSchema: SourceSchema,
      execute: ({ args, source }) => source.createSource(args),
    },
    {
      name: "updateSource",
      description: "Update a GraphQL source configuration.",
      inputSchema: GraphqlUpdateSourceInputSchema,
      outputSchema: SourceSchema,
      execute: ({ args, source }) => source.updateSource(args),
    },
    {
      name: "removeSource",
      description: "Remove a GraphQL source and its stored plugin data.",
      inputSchema: GraphqlSourceIdInputSchema,
      outputSchema: Schema.Boolean,
      execute: ({ args, source }) => source.removeSource(args.sourceId),
    },
  ] as const,
  extendExecutor: ({ source, executor }) => {
    const provideRuntime = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, never> =>
      provideExecutorRuntime(effect, executor.runtime);

    return {
      getSourceConfig: (sourceId) =>
        provideRuntime(source.getSourceConfig(sourceId)),
      createSource: (input) =>
        provideRuntime(source.createSource(input)),
      updateSource: (input) =>
        provideRuntime(source.updateSource(input)),
      removeSource: (sourceId) =>
        provideRuntime(source.removeSource(sourceId)),
    };
  },
});
