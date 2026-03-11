import {
  makeToolInvokerFromTools,
  typeSignatureFromSchemaJson,
} from "@executor/codemode-core";
import type { SqlControlPlaneRows } from "#persistence";
import type {
  GraphqlToolManifest,
} from "../graphql-tools";
import {
  buildGraphqlToolPresentation,
  compileGraphqlToolDefinitions,
  createGraphqlToolFromPersistedOperation,
  decodeGraphqlSchemaRefTableJson,
  extractGraphqlManifest,
  GraphqlToolProviderDataSchema,
  GRAPHQL_INTROSPECTION_QUERY,
} from "../graphql-tools";
import type {
  Source,
  SourceRecipeRevisionId,
  StoredSourceRecipeDocumentRecord,
  StoredSourceRecipeOperationRecord,
  StoredSourceRecipeSchemaBundleRecord,
} from "#schema";
import {
  StringMapSchema,
  SourceRecipeSchemaBundleIdSchema,
} from "#schema";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { namespaceFromSourceName } from "../source-names";
import {
  contentHash,
  normalizeSearchText,
} from "../source-recipe-support";
import type {
  SourceAdapter,
  SourceAdapterMaterialization,
  SourceAdapterRepairRevisionInput,
} from "./types";
import {
  ConnectHttpAuthSchema,
  ConnectHttpImportAuthSchema,
  createStandardToolDescriptor,
  decodeBindingConfig,
  decodeSourceBindingPayload,
  emptySourceBindingState,
  encodeBindingConfig,
  isSourceCredentialRequiredError,
  OptionalNullableStringSchema,
  parseJsonValue,
  SourceCredentialRequiredError,
  SourceConnectCommonFieldsSchema,
} from "./shared";

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

const GRAPHQL_MATERIALIZATION_REVISION_ID = "src_recipe_rev_materialization" as SourceRecipeRevisionId;

const decodeGraphqlToolProviderDataJson = Schema.decodeUnknownEither(
  Schema.parseJson(GraphqlToolProviderDataSchema),
);

const bindingHasAnyField = (
  value: unknown,
  fields: readonly string[],
): boolean =>
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && fields.some((field) => Object.prototype.hasOwnProperty.call(value, field));

const graphqlBindingConfigFromSource = (
  source: Pick<Source, "id" | "bindingVersion" | "binding">,
): Effect.Effect<GraphqlBindingConfig, Error, never> =>
  Effect.gen(function* () {
    if (bindingHasAnyField(source.binding, ["transport", "queryParams", "headers"])) {
      return yield* Effect.fail(
        new Error("GraphQL sources cannot define MCP transport settings"),
      );
    }
    if (bindingHasAnyField(source.binding, ["specUrl"])) {
      return yield* Effect.fail(new Error("GraphQL sources cannot define specUrl"));
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
}): Effect.Effect<string, Error, never> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(input.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.headers ?? {}),
        },
        body: JSON.stringify({
          query: GRAPHQL_INTROSPECTION_QUERY,
          operationName: "IntrospectionQuery",
        }),
      });
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

const toGraphqlSchemaBundleRecord = (input: {
  recipeRevisionId: SourceRecipeRevisionId;
  manifest: Parameters<typeof buildGraphqlToolPresentation>[0]["manifest"];
  now: number;
}): StoredSourceRecipeSchemaBundleRecord | null => {
  const refEntries = Object.entries(input.manifest.schemaRefTable ?? {});
  if (refEntries.length === 0) {
    return null;
  }

  const refs = Object.fromEntries(
    refEntries.map(([ref, rawValue]) => {
      try {
        return [ref, JSON.parse(rawValue) as unknown];
      } catch {
        return [ref, rawValue];
      }
    }),
  );
  const refsJson = JSON.stringify(refs);

  return {
    id: SourceRecipeSchemaBundleIdSchema.make(
      `src_recipe_bundle_${crypto.randomUUID()}`,
    ),
    recipeRevisionId: input.recipeRevisionId,
    bundleKind: "json_schema_ref_map",
    refsJson,
    contentHash: contentHash(refsJson),
    createdAt: input.now,
    updatedAt: input.now,
  };
};

const toGraphqlRecipeOperationRecord = (input: {
  recipeRevisionId: SourceRecipeRevisionId;
  definition: ReturnType<typeof compileGraphqlToolDefinitions>[number];
  manifest: Parameters<typeof buildGraphqlToolPresentation>[0]["manifest"];
  now: number;
}): StoredSourceRecipeOperationRecord => {
  const presentation = buildGraphqlToolPresentation({
    manifest: input.manifest,
    definition: input.definition,
  });

  return {
    id: `src_recipe_op_${crypto.randomUUID()}`,
    recipeRevisionId: input.recipeRevisionId,
    operationKey: input.definition.toolId,
    transportKind: "graphql",
    toolId: input.definition.toolId,
    title: input.definition.name,
    description: input.definition.description,
    operationKind:
      input.definition.operationType === "query"
        ? "read"
        : input.definition.operationType === "mutation"
          ? "write"
          : "unknown",
    searchText: normalizeSearchText(
      input.definition.toolId,
      input.definition.name,
      input.definition.description,
      input.definition.rawToolId,
      input.definition.group,
      input.definition.leaf,
      input.definition.fieldName,
      input.definition.operationType,
      input.definition.operationName,
      input.definition.searchTerms.join(" "),
    ),
    inputSchemaJson: presentation.inputSchemaJson ?? null,
    outputSchemaJson: presentation.outputSchemaJson ?? null,
    providerKind: "graphql",
    providerDataJson: presentation.providerDataJson,
    createdAt: input.now,
    updatedAt: input.now,
  };
};

const primaryDocument = (
  documents: readonly StoredSourceRecipeDocumentRecord[],
): StoredSourceRecipeDocumentRecord | null =>
  documents.find((document) => document.documentKind === "graphql_introspection")
  ?? null;

export const rebuildGraphqlRecipeRevisionContent = (input: {
  rows: SqlControlPlaneRows;
  sourceRecord: SourceAdapterRepairRevisionInput["sourceRecord"];
  revision: SourceAdapterRepairRevisionInput["revision"];
  documents: readonly StoredSourceRecipeDocumentRecord[];
}): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const manifest =
      input.revision.manifestJson !== null
        ? yield* parseJsonValue<GraphqlToolManifest>({
            label: `GraphQL manifest for ${input.sourceRecord.id}`,
            value: input.revision.manifestJson,
          })
        : null;
    const document = primaryDocument(input.documents);
    const resolvedManifest =
      manifest
      ?? (document !== null
        ? yield* extractGraphqlManifest(
            input.sourceRecord.name,
            document.contentText,
          )
        : null);

    if (resolvedManifest === null) {
      return yield* Effect.fail(
        new Error(
          `Missing GraphQL manifest and document for ${input.sourceRecord.id}`,
        ),
      );
    }

    const now = Math.max(input.revision.updatedAt, input.sourceRecord.updatedAt);
    const definitions = compileGraphqlToolDefinitions(resolvedManifest);
    const schemaBundle = toGraphqlSchemaBundleRecord({
      recipeRevisionId: input.revision.id,
      manifest: resolvedManifest,
      now,
    });

    yield* input.rows.sourceRecipeRevisions.update(input.revision.id, {
      manifestJson: JSON.stringify(resolvedManifest),
      manifestHash: resolvedManifest.sourceHash,
      updatedAt: now,
    });
    yield* input.rows.sourceRecipeOperations.replaceForRevision({
      recipeRevisionId: input.revision.id,
      operations: definitions.map((definition) =>
        toGraphqlRecipeOperationRecord({
          recipeRevisionId: input.revision.id,
          definition,
          manifest: resolvedManifest,
          now,
        }),
      ),
    });
    yield* input.rows.sourceRecipeSchemaBundles.replaceForRevision({
      recipeRevisionId: input.revision.id,
      bundles: schemaBundle ? [schemaBundle] : [],
    });

    if (input.sourceRecord.sourceHash !== resolvedManifest.sourceHash) {
      yield* input.rows.sources.update(input.sourceRecord.workspaceId, input.sourceRecord.id, {
        sourceHash: resolvedManifest.sourceHash,
        updatedAt: now,
      });
    }
  });

export const graphqlSourceAdapter: SourceAdapter = {
  key: "graphql",
  displayName: "GraphQL",
  family: "http_api",
  bindingConfigVersion: GRAPHQL_BINDING_CONFIG_VERSION,
  providerKey: "generic_graphql",
  defaultImportAuthPolicy: "reuse_runtime",
  primaryDocumentKind: "graphql_introspection",
  primarySchemaBundleKind: "json_schema_ref_map",
  connectPayloadSchema: GraphqlConnectPayloadSchema,
  executorAddInputSchema: GraphqlExecutorAddInputSchema,
  executorAddHelpText: [
    "endpoint is the GraphQL HTTP endpoint.",
  ],
  executorAddInputSignatureWidth: 320,
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
      }),
    ),
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
    source.enabled && (source.status === "draft" || source.status === "probing"),
  parseManifest: ({ source, manifestJson }) =>
    parseJsonValue<GraphqlToolManifest>({
      label: `GraphQL manifest for ${source.id}`,
      value: manifestJson,
    }),
  describePersistedOperation: ({ operation, path }) =>
    Effect.gen(function* () {
      const decoded = operation.providerDataJson
        ? decodeGraphqlToolProviderDataJson(operation.providerDataJson)
        : Either.left(new Error("Missing providerDataJson"));
      if (Either.isLeft(decoded)) {
        return yield* Effect.fail(
          new Error(`Invalid GraphQL provider data for ${path}`),
        );
      }

      const providerData = decoded.right;

      return {
        method: null,
        pathTemplate: null,
        rawToolId: providerData.rawToolId,
        operationId: providerData.operationName,
        group: providerData.group,
        leaf: providerData.leaf,
        tags: [],
        searchText: normalizeSearchText(
          path,
          operation.toolId,
          operation.title ?? undefined,
          operation.description ?? undefined,
          providerData.rawToolId ?? undefined,
          providerData.group ?? undefined,
          providerData.leaf ?? undefined,
          providerData.fieldName ?? undefined,
          providerData.operationType ?? undefined,
          providerData.operationName ?? undefined,
          operation.searchText,
        ),
        interaction: providerData.operationType === "query" ? "auto" : "required",
        approvalLabel: providerData.operationType
          ? `GraphQL ${providerData.operationType} ${path}`
          : `GraphQL ${path}`,
      } as const;
    }),
  searchNamespace: ({ source }) =>
    source.namespace ?? namespaceFromSourceName(source.name),
  createToolDescriptor: ({ source, operation, path, includeSchemas, schemaBundleId }) =>
    createStandardToolDescriptor({
      source,
      operation,
      path,
      includeSchemas,
      interaction: operation.operationKind === "read" ? "auto" : "required",
      outputType: typeSignatureFromSchemaJson(
        operation.outputSchemaJson ?? undefined,
        "unknown",
        320,
      ),
      schemaBundleId,
    }),
  materializeSource: ({ source, resolveAuthMaterialForSlot }) =>
    Effect.gen(function* () {
      const bindingConfig = yield* graphqlBindingConfigFromSource(source);
      const auth = yield* resolveAuthMaterialForSlot("import");
      const graphqlDocument = yield* fetchGraphqlIntrospectionDocumentWithHeaders(
        {
          url: source.endpoint,
          headers: {
            ...(bindingConfig.defaultHeaders ?? {}),
            ...auth.headers,
          },
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
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
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
      );

      const definitions = compileGraphqlToolDefinitions(manifest);
      const now = Date.now();
      const schemaBundle = toGraphqlSchemaBundleRecord({
        recipeRevisionId: GRAPHQL_MATERIALIZATION_REVISION_ID,
        manifest,
        now,
      });

      return {
        manifestJson: JSON.stringify(manifest),
        manifestHash: manifest.sourceHash,
        sourceHash: manifest.sourceHash,
        documents: [
          {
            id: `src_recipe_doc_${crypto.randomUUID()}`,
            recipeRevisionId: GRAPHQL_MATERIALIZATION_REVISION_ID,
            documentKind: "graphql_introspection",
            documentKey: source.endpoint,
            contentText: graphqlDocument,
            contentHash: contentHash(graphqlDocument),
            fetchedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        ],
        schemaBundles: schemaBundle ? [schemaBundle] : [],
        operations: definitions.map((definition) =>
          toGraphqlRecipeOperationRecord({
            recipeRevisionId: GRAPHQL_MATERIALIZATION_REVISION_ID,
            definition,
            manifest,
            now,
          }),
        ),
      } satisfies SourceAdapterMaterialization;
    }),
  invokePersistedTool: ({
    source,
    path,
    operation,
    schemaBundle,
    auth,
    args,
    context,
    onElicitation,
  }) =>
    Effect.gen(function* () {
      const bindingConfig = yield* graphqlBindingConfigFromSource(source);
      const schemaRefTable = schemaBundle
        ? decodeGraphqlSchemaRefTableJson(schemaBundle.refsJson)
        : Either.right({});

      if (Either.isLeft(schemaRefTable)) {
        return yield* Effect.fail(
          new Error(`Invalid GraphQL schema bundle for ${path}`),
        );
      }
      if (!operation.providerDataJson) {
        return yield* Effect.fail(
          new Error(`Missing GraphQL provider data for ${path}`),
        );
      }

      const tool = createGraphqlToolFromPersistedOperation({
        path,
        sourceKey: source.id,
        endpoint: source.endpoint,
        description: operation.description ?? operation.title ?? undefined,
        inputSchemaJson: operation.inputSchemaJson ?? undefined,
        outputSchemaJson: operation.outputSchemaJson ?? undefined,
        providerDataJson: operation.providerDataJson,
        schemaRefTable: schemaRefTable.right,
        defaultHeaders: bindingConfig.defaultHeaders ?? {},
        credentialHeaders: auth.headers,
      });

      return yield* makeToolInvokerFromTools({
        tools: {
          [path]: tool,
        },
        onElicitation,
      }).invoke({
        path,
        args,
        context,
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
      );
    }),
};
