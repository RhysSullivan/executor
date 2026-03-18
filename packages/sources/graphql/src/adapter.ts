import {
  applyCookiePlacementsToHeaders,
  applyHttpQueryPlacementsToUrl,
  applyJsonBodyPlacements,
} from "@executor/codemode-core";
import {
  GraphqlToolProviderDataSchema,
  type GraphqlToolProviderData,
} from "./provider-data";
import { detectGraphqlSource } from "./discovery";
import {
  createGraphqlCatalogFragment,
  type GraphqlCatalogOperationInput,
} from "./catalog";
import {
  buildGraphqlToolPresentation,
  compileGraphqlToolDefinitions,
  extractGraphqlManifest,
  GRAPHQL_INTROSPECTION_QUERY,
} from "./graphql-tools";
import { GraphqlLocalConfigBindingSchema } from "./local-config";
import {
  ConnectHttpAuthSchema,
  ConnectHttpImportAuthSchema,
  createSourceCatalogSyncResult,
  decodeBindingConfig,
  decodeExecutableBindingPayload,
  decodeSourceBindingPayload,
  emptySourceBindingState,
  encodeBindingConfig,
  isSourceCredentialRequiredError,
  looksLikeGraphqlEndpoint,
  OptionalNullableStringSchema,
  SourceCredentialRequiredError,
  SourceConnectCommonFieldsSchema,
  StringMapSchema,
  createCatalogImportMetadata,
  EXECUTABLE_BINDING_VERSION,
  sourceCoreEffectError,
  type Source,
  type SourceAdapter,
} from "@executor/source-core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const GraphqlConnectPayloadSchema = Schema.extend(
  SourceConnectCommonFieldsSchema,
  Schema.extend(
    ConnectHttpImportAuthSchema,
    Schema.Struct({
      kind: Schema.Literal("graphql"),
      auth: Schema.optional(ConnectHttpAuthSchema),
    }),
  ),
);

const GraphqlExecutorAddInputSchema = Schema.extend(
  ConnectHttpImportAuthSchema,
  Schema.Struct({
    kind: Schema.Literal("graphql"),
    endpoint: Schema.String,
    name: OptionalNullableStringSchema,
    namespace: OptionalNullableStringSchema,
    auth: Schema.optional(ConnectHttpAuthSchema),
  }),
);

const GraphqlBindingConfigSchema = Schema.Struct({
  defaultHeaders: Schema.NullOr(StringMapSchema),
});

type GraphqlBindingConfig = typeof GraphqlBindingConfigSchema.Type;

const GraphqlSourceBindingPayloadSchema = Schema.Struct({
  defaultHeaders: Schema.optional(Schema.NullOr(StringMapSchema)),
});

const GRAPHQL_BINDING_CONFIG_VERSION = 1;
const GRAPHQL_INTROSPECTION_TIMEOUT_MS = 15_000;

const bindingHasAnyField = (
  value: unknown,
  fields: readonly string[],
): boolean =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  fields.some((field) => Object.prototype.hasOwnProperty.call(value, field));

const graphqlBindingConfigFromSource = (
  source: Pick<Source, "id" | "bindingVersion" | "binding">,
): Effect.Effect<GraphqlBindingConfig, Error, never> =>
  Effect.gen(function* () {
    if (
      bindingHasAnyField(source.binding, [
        "transport",
        "queryParams",
        "headers",
      ])
    ) {
      return yield* sourceCoreEffectError("graphql/adapter", "GraphQL sources cannot define MCP transport settings");
    }
    if (bindingHasAnyField(source.binding, ["specUrl"])) {
      return yield* sourceCoreEffectError("graphql/adapter", "GraphQL sources cannot define specUrl");
    }

    const bindingConfig = yield* decodeSourceBindingPayload({
      sourceId: source.id,
      label: "GraphQL",
      version: source.bindingVersion,
      expectedVersion: GRAPHQL_BINDING_CONFIG_VERSION,
      schema: GraphqlSourceBindingPayloadSchema,
      value: source.binding,
      allowedKeys: ["defaultHeaders"],
    });

    return {
      defaultHeaders: bindingConfig.defaultHeaders ?? null,
    } satisfies GraphqlBindingConfig;
  });

const fetchGraphqlIntrospectionDocumentWithHeaders = (input: {
  url: string;
  headers?: Readonly<Record<string, string>>;
  queryParams?: Readonly<Record<string, string>>;
  cookies?: Readonly<Record<string, string>>;
  bodyValues?: Readonly<Record<string, string>>;
}): Effect.Effect<string, Error, never> =>
  Effect.tryPromise({
    try: async () => {
      let response: Response;
      try {
        response = await fetch(
          applyHttpQueryPlacementsToUrl({
            url: input.url,
            queryParams: input.queryParams,
          }).toString(),
          {
            method: "POST",
            headers: applyCookiePlacementsToHeaders({
              headers: {
                "content-type": "application/json",
                ...input.headers,
              },
              cookies: input.cookies,
            }),
            body: JSON.stringify(
              applyJsonBodyPlacements({
                body: {
                  query: GRAPHQL_INTROSPECTION_QUERY,
                  operationName: "IntrospectionQuery",
                },
                bodyValues: input.bodyValues,
                label: `GraphQL introspection ${input.url}`,
              }),
            ),
            signal: AbortSignal.timeout(GRAPHQL_INTROSPECTION_TIMEOUT_MS),
          },
        );
      } catch (cause) {
        if (
          cause instanceof Error &&
          (cause.name === "AbortError" || cause.name === "TimeoutError")
        ) {
          throw new Error(
            `GraphQL introspection timed out after ${GRAPHQL_INTROSPECTION_TIMEOUT_MS}ms`,
          );
        }
        throw cause;
      }
      const text = await response.text();

      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch (cause) {
        throw new Error(
          `GraphQL introspection endpoint did not return JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new SourceCredentialRequiredError(
            "import",
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

const withoutUndefinedEntries = (
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );

export const graphqlSourceAdapter = {
  key: "graphql",
  displayName: "GraphQL",
  catalogKind: "imported",
  connectStrategy: "direct",
  credentialStrategy: "credential_managed",
  bindingConfigVersion: GRAPHQL_BINDING_CONFIG_VERSION,
  providerKey: "generic_graphql",
  defaultImportAuthPolicy: "reuse_runtime",
  connectPayloadSchema: GraphqlConnectPayloadSchema,
  executorAddInputSchema: GraphqlExecutorAddInputSchema,
  executorAddHelpText: ["endpoint is the GraphQL HTTP endpoint."],
  executorAddInputSignatureWidth: 320,
  localConfigBindingSchema: GraphqlLocalConfigBindingSchema,
  localConfigBindingFromSource: (source) =>
    Effect.runSync(
      Effect.map(graphqlBindingConfigFromSource(source), (bindingConfig) => ({
        defaultHeaders: bindingConfig.defaultHeaders,
      })),
    ),
  serializeBindingConfig: (source) =>
    encodeBindingConfig({
      adapterKey: "graphql",
      version: GRAPHQL_BINDING_CONFIG_VERSION,
      payloadSchema: GraphqlBindingConfigSchema,
      payload: Effect.runSync(graphqlBindingConfigFromSource(source)),
    }),
  deserializeBindingConfig: ({ id, bindingConfigJson }) =>
    Effect.map(
      decodeBindingConfig({
        sourceId: id,
        label: "GraphQL",
        adapterKey: "graphql",
        version: GRAPHQL_BINDING_CONFIG_VERSION,
        payloadSchema: GraphqlBindingConfigSchema,
        value: bindingConfigJson,
      }),
      ({ version, payload }) => ({
        version,
        payload,
      }),
    ),
  bindingStateFromSource: (source) =>
    Effect.map(graphqlBindingConfigFromSource(source), (bindingConfig) => ({
      ...emptySourceBindingState,
      defaultHeaders: bindingConfig.defaultHeaders,
    })),
  sourceConfigFromSource: (source) =>
    Effect.runSync(
      Effect.map(graphqlBindingConfigFromSource(source), (bindingConfig) => ({
        kind: "graphql",
        endpoint: source.endpoint,
        defaultHeaders: bindingConfig.defaultHeaders,
      })),
    ),
  validateSource: (source) =>
    Effect.gen(function* () {
      const bindingConfig = yield* graphqlBindingConfigFromSource(source);

      return {
        ...source,
        bindingVersion: GRAPHQL_BINDING_CONFIG_VERSION,
        binding: {
          defaultHeaders: bindingConfig.defaultHeaders,
        },
      };
    }),
  shouldAutoProbe: (source) =>
    source.enabled &&
    (source.status === "draft" || source.status === "probing"),
  discoveryPriority: ({ normalizedUrl }) =>
    looksLikeGraphqlEndpoint(normalizedUrl) ? 400 : 150,
  detectSource: ({ normalizedUrl, headers }) =>
    detectGraphqlSource({
      normalizedUrl,
      headers,
    }),
  syncCatalog: ({ source, resolveAuthMaterialForSlot }) =>
    Effect.gen(function* () {
      const bindingConfig = yield* graphqlBindingConfigFromSource(source);
      const auth = yield* resolveAuthMaterialForSlot("import");
      const graphqlDocument =
        yield* fetchGraphqlIntrospectionDocumentWithHeaders({
          url: source.endpoint,
          headers: {
            ...bindingConfig.defaultHeaders,
            ...auth.headers,
          },
          queryParams: auth.queryParams,
          cookies: auth.cookies,
          bodyValues: auth.bodyValues,
        }).pipe(
          Effect.withSpan("graphql.introspection.fetch", {
            kind: "client",
            attributes: {
              "executor.source.id": source.id,
              "executor.source.endpoint": source.endpoint,
            },
          }),
          Effect.mapError((cause) =>
            isSourceCredentialRequiredError(cause)
              ? cause
              : new Error(
                  `Failed fetching GraphQL introspection for ${source.id}: ${cause.message}`,
                ),
          ),
        );

      const manifest = yield* extractGraphqlManifest(
        source.name,
        graphqlDocument,
      ).pipe(
        Effect.withSpan("graphql.manifest.extract", {
          attributes: {
            "executor.source.id": source.id,
          },
        }),
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
      );
      yield* Effect.annotateCurrentSpan(
        "graphql.tool.count",
        manifest.tools.length,
      );

      const definitions = yield* Effect.sync(() =>
        compileGraphqlToolDefinitions(manifest),
      ).pipe(
        Effect.withSpan("graphql.definitions.compile", {
          attributes: {
            "executor.source.id": source.id,
            "graphql.tool.count": manifest.tools.length,
          },
        }),
      );
      yield* Effect.annotateCurrentSpan(
        "graphql.definition.count",
        definitions.length,
      );
      const operations = yield* Effect.sync(() =>
        definitions.map((definition) =>
          graphqlCatalogOperationFromDefinition({
            definition,
            manifest,
          }),
        ),
      ).pipe(
        Effect.withSpan("graphql.operations.build", {
          attributes: {
            "executor.source.id": source.id,
            "graphql.definition.count": definitions.length,
          },
        }),
      );
      const now = Date.now();
      const fragment = yield* Effect.sync(() =>
        createGraphqlCatalogFragment({
          source,
          documents: [
            {
              documentKind: "graphql_introspection",
              documentKey: source.endpoint,
              contentText: graphqlDocument,
              fetchedAt: now,
            },
          ],
          operations,
        }),
      ).pipe(
        Effect.withSpan("graphql.snapshot.build", {
          attributes: {
            "executor.source.id": source.id,
            "graphql.operation.count": operations.length,
          },
        }),
      );

      return createSourceCatalogSyncResult({
        fragment,
        importMetadata: createCatalogImportMetadata({
          source,
          adapterKey: "graphql",
        }),
        sourceHash: manifest.sourceHash,
      });
    }).pipe(
      Effect.withSpan("graphql.syncCatalog", {
        attributes: {
          "executor.source.id": source.id,
          "executor.source.endpoint": source.endpoint,
        },
      }),
    ),
  invoke: (input) =>
    Effect.tryPromise({
      try: async () => {
        const bindingConfig = Effect.runSync(
          graphqlBindingConfigFromSource(input.source),
        );
        const providerData = decodeExecutableBindingPayload({
          executableId: input.executable.id,
          label: "GraphQL",
          version: input.executable.bindingVersion,
          expectedVersion: EXECUTABLE_BINDING_VERSION,
          schema: GraphqlToolProviderDataSchema,
          value: input.executable.binding,
        }) as GraphqlToolProviderData;
        const args = asRecord(input.args);
        const headers = applyCookiePlacementsToHeaders({
          headers: {
            "content-type": "application/json",
            ...bindingConfig.defaultHeaders,
            ...input.auth.headers,
            ...asStringRecord(args.headers),
          },
          cookies: input.auth.cookies,
        });
        const endpoint = applyHttpQueryPlacementsToUrl({
          url: input.source.endpoint,
          queryParams: input.auth.queryParams,
        }).toString();

        const isRawRequest =
          providerData.toolKind === "request" ||
          typeof providerData.operationDocument !== "string" ||
          providerData.operationDocument.trim().length === 0;
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

        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            query,
            ...(variables ? { variables } : {}),
            ...(operationName ? { operationName } : {}),
          }),
        });
        const body = await parseGraphqlResponseBody(response);
        const bodyRecord = asRecord(body);
        const errors = Array.isArray(bodyRecord.errors)
          ? bodyRecord.errors
          : [];
        const rootField =
          providerData.fieldName ?? providerData.leaf ?? providerData.toolId;
        const dataRecord = asRecord(bodyRecord.data);

        return {
          data: isRawRequest ? body : (dataRecord[rootField] ?? null),
          error:
            errors.length > 0 ? errors : response.status >= 400 ? body : null,
          headers: responseHeadersRecord(response),
          status: response.status,
        };
      },
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }),
} satisfies SourceAdapter;
