import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import type { SqlControlPlaneRows } from "#persistence";
import {
  makeToolInvokerFromTools,
} from "@executor/codemode-core";
import {
  buildOpenApiToolPresentation,
  compileOpenApiToolDefinitions,
  createOpenApiToolFromDefinition,
  extractOpenApiManifest,
  openApiOutputTypeSignatureFromSchemaJson,
  OpenApiRefHintTableSchema,
  OpenApiToolProviderDataSchema,
  type OpenApiToolManifest,
} from "@executor/codemode-openapi";
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

const OpenApiConnectPayloadSchema = Schema.extend(
  SourceConnectCommonFieldsSchema,
  Schema.extend(
    ConnectHttpImportAuthSchema,
    Schema.Struct({
      kind: Schema.Literal("openapi"),
      specUrl: Schema.Trim.pipe(Schema.nonEmptyString()),
      auth: Schema.optional(ConnectHttpAuthSchema),
    }),
  ),
);

const OpenApiExecutorAddInputSchema = Schema.extend(
  ConnectHttpImportAuthSchema,
  Schema.Struct({
    kind: Schema.Literal("openapi"),
    endpoint: Schema.String,
    specUrl: Schema.String,
    name: OptionalNullableStringSchema,
    namespace: OptionalNullableStringSchema,
    auth: Schema.optional(ConnectHttpAuthSchema),
  }),
);

const OpenApiBindingConfigSchema = Schema.Struct({
  specUrl: Schema.Trim.pipe(Schema.nonEmptyString()),
  defaultHeaders: Schema.optional(Schema.NullOr(StringMapSchema)),
});

const OpenApiSourceBindingPayloadSchema = Schema.Struct({
  specUrl: Schema.optional(Schema.String),
  defaultHeaders: Schema.optional(Schema.NullOr(StringMapSchema)),
});

type OpenApiBindingConfig = {
  specUrl: string;
  defaultHeaders: typeof StringMapSchema.Type | null;
};

const OPENAPI_BINDING_CONFIG_VERSION = 1;

const OPENAPI_MATERIALIZATION_REVISION_ID = "src_recipe_rev_materialization" as SourceRecipeRevisionId;

const decodeOpenApiProviderDataJson = Schema.decodeUnknownEither(
  Schema.parseJson(OpenApiToolProviderDataSchema),
);

const decodeOpenApiRefHintTableJson = Schema.decodeUnknownEither(
  Schema.parseJson(OpenApiRefHintTableSchema),
);

const bindingHasAnyField = (
  value: unknown,
  fields: readonly string[],
): boolean =>
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && fields.some((field) => Object.prototype.hasOwnProperty.call(value, field));

const openApiBindingConfigFromSource = (
  source: Pick<Source, "id" | "bindingVersion" | "binding">,
): Effect.Effect<OpenApiBindingConfig, Error, never> =>
  Effect.gen(function* () {
    if (bindingHasAnyField(source.binding, ["transport", "queryParams", "headers"])) {
      return yield* Effect.fail(
        new Error("OpenAPI sources cannot define MCP transport settings"),
      );
    }

    const bindingConfig = yield* decodeSourceBindingPayload({
      sourceId: source.id,
      label: "OpenAPI",
      version: source.bindingVersion,
      expectedVersion: OPENAPI_BINDING_CONFIG_VERSION,
      schema: OpenApiSourceBindingPayloadSchema,
      value: source.binding,
      allowedKeys: ["specUrl", "defaultHeaders"],
    });

    const specUrl = typeof bindingConfig.specUrl === "string"
      ? bindingConfig.specUrl.trim()
      : "";
    if (specUrl.length === 0) {
      return yield* Effect.fail(new Error("OpenAPI sources require specUrl"));
    }

    return {
      specUrl,
      defaultHeaders: bindingConfig.defaultHeaders ?? null,
    } satisfies OpenApiBindingConfig;
  });

const fetchOpenApiDocumentWithHeaders = (input: {
  url: string;
  headers?: Readonly<Record<string, string>>;
}): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(input.url).pipe(
      HttpClientRequest.setHeaders(input.headers ?? {}),
    );
    const response = yield* client.execute(request).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );

    if (response.status === 401 || response.status === 403) {
      return yield* Effect.fail(
        new SourceCredentialRequiredError(
          "import",
          `OpenAPI spec fetch requires credentials (status ${response.status})`,
        ),
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new Error(`OpenAPI spec fetch failed with status ${response.status}`),
      );
    }

    return yield* response.text.pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));

const toOpenApiRecipeOperationRecord = (input: {
  recipeRevisionId: SourceRecipeRevisionId;
  definition: ReturnType<typeof compileOpenApiToolDefinitions>[number];
  now: number;
}): StoredSourceRecipeOperationRecord => {
  const presentation = buildOpenApiToolPresentation({
    definition: input.definition,
  });
  const method = input.definition.method.toUpperCase();

  return {
    id: `src_recipe_op_${crypto.randomUUID()}`,
    recipeRevisionId: input.recipeRevisionId,
    operationKey: input.definition.toolId,
    transportKind: "http",
    toolId: input.definition.toolId,
    title: input.definition.name,
    description: input.definition.description,
    operationKind:
      method === "GET" || method === "HEAD"
        ? "read"
        : method === "DELETE"
          ? "delete"
          : "write",
    searchText: normalizeSearchText(
      input.definition.toolId,
      input.definition.name,
      input.definition.description,
      input.definition.rawToolId,
      input.definition.operationId ?? undefined,
      input.definition.method,
      input.definition.path,
      input.definition.group,
      input.definition.leaf,
      input.definition.tags.join(" "),
    ),
  inputSchemaJson: presentation.inputSchemaJson ?? null,
  outputSchemaJson: presentation.outputSchemaJson ?? null,
  providerKind: "openapi",
  providerDataJson: presentation.providerDataJson,
  createdAt: input.now,
  updatedAt: input.now,
};
};

const toOpenApiSchemaBundleRecord = (input: {
  recipeRevisionId: SourceRecipeRevisionId;
  refTable: Readonly<Record<string, string>> | undefined;
  now: number;
}): StoredSourceRecipeSchemaBundleRecord | null => {
  const refEntries = Object.entries(input.refTable ?? {});
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

const openApiDefinitionFromPersistedOperation = (input: {
  source: Source;
  path: string;
  operation: StoredSourceRecipeOperationRecord;
}) => {
  const decoded = input.operation.providerDataJson
    ? decodeOpenApiProviderDataJson(input.operation.providerDataJson)
    : Either.left(new Error("Missing providerDataJson"));

  if (Either.isLeft(decoded)) {
    throw new Error(`Invalid OpenAPI provider data for ${input.path}`);
  }

  return {
    toolId: input.operation.toolId,
    rawToolId: decoded.right.rawToolId,
    ...(decoded.right.operationId
      ? { operationId: decoded.right.operationId }
      : {}),
    name: input.operation.title ?? input.operation.toolId,
    description:
      input.operation.description ??
      `${decoded.right.method.toUpperCase()} ${decoded.right.path}`,
    group: decoded.right.group,
    leaf: decoded.right.leaf,
    tags: decoded.right.tags,
    ...(decoded.right.versionSegment
      ? { versionSegment: decoded.right.versionSegment }
      : {}),
    method: decoded.right.method,
    path: decoded.right.path,
    invocation: decoded.right.invocation,
    operationHash: decoded.right.operationHash,
    typing: {
      ...(input.operation.inputSchemaJson
        ? { inputSchemaJson: input.operation.inputSchemaJson }
        : {}),
      ...(input.operation.outputSchemaJson
        ? { outputSchemaJson: input.operation.outputSchemaJson }
        : {}),
    },
    ...(decoded.right.documentation
      ? { documentation: decoded.right.documentation }
      : {}),
  };
};

const primaryDocument = (
  documents: readonly StoredSourceRecipeDocumentRecord[],
): StoredSourceRecipeDocumentRecord | null =>
  documents.find((document) => document.documentKind === "openapi") ?? null;

export const rebuildOpenApiRecipeRevisionContent = (input: {
  rows: SqlControlPlaneRows;
  sourceRecord: SourceAdapterRepairRevisionInput["sourceRecord"];
  revision: SourceAdapterRepairRevisionInput["revision"];
  documents: readonly StoredSourceRecipeDocumentRecord[];
}): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const manifest =
      input.revision.manifestJson !== null
        ? ((yield* parseJsonValue<OpenApiToolManifest>({
            label: `OpenAPI manifest for ${input.sourceRecord.id}`,
            value: input.revision.manifestJson,
          })) as OpenApiToolManifest | null)
        : null;
    const document = primaryDocument(input.documents);
    const resolvedManifest =
      manifest
      ?? (document !== null
        ? yield* extractOpenApiManifest(
            input.sourceRecord.name,
            document.contentText,
          )
        : null);

    if (resolvedManifest === null) {
      return yield* Effect.fail(
        new Error(
          `Missing OpenAPI manifest and document for ${input.sourceRecord.id}`,
        ),
      );
    }

    const now = Math.max(input.revision.updatedAt, input.sourceRecord.updatedAt);
    const definitions = compileOpenApiToolDefinitions(resolvedManifest);
    const schemaBundle = toOpenApiSchemaBundleRecord({
      recipeRevisionId: input.revision.id,
      refTable: resolvedManifest.refHintTable,
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
        toOpenApiRecipeOperationRecord({
          recipeRevisionId: input.revision.id,
          definition,
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

export const openApiSourceAdapter: SourceAdapter = {
  key: "openapi",
  displayName: "OpenAPI",
  family: "http_api",
  bindingConfigVersion: OPENAPI_BINDING_CONFIG_VERSION,
  providerKey: "generic_http",
  defaultImportAuthPolicy: "reuse_runtime",
  primaryDocumentKind: "openapi",
  primarySchemaBundleKind: "json_schema_ref_map",
  connectPayloadSchema: OpenApiConnectPayloadSchema,
  executorAddInputSchema: OpenApiExecutorAddInputSchema,
  executorAddHelpText: [
    "endpoint is the base API URL. specUrl is the OpenAPI document URL.",
  ],
  executorAddInputSignatureWidth: 420,
  serializeBindingConfig: (source) =>
    encodeBindingConfig({
      adapterKey: "openapi",
      version: OPENAPI_BINDING_CONFIG_VERSION,
      payloadSchema: OpenApiBindingConfigSchema,
      payload: Effect.runSync(openApiBindingConfigFromSource(source)),
    }),
  deserializeBindingConfig: ({ id, bindingConfigJson }) =>
    Effect.map(
      decodeBindingConfig({
        sourceId: id,
        label: "OpenAPI",
        adapterKey: "openapi",
        version: OPENAPI_BINDING_CONFIG_VERSION,
        payloadSchema: OpenApiBindingConfigSchema,
        value: bindingConfigJson,
      }),
      ({ version, payload }) => ({
        version,
        payload: {
          specUrl: payload.specUrl,
          defaultHeaders: payload.defaultHeaders ?? null,
        },
      }),
    ),
  bindingStateFromSource: (source) =>
    Effect.map(openApiBindingConfigFromSource(source), (bindingConfig) => ({
      ...emptySourceBindingState,
      specUrl: bindingConfig.specUrl,
      defaultHeaders: bindingConfig.defaultHeaders,
    })),
  sourceConfigFromSource: (source) =>
    Effect.runSync(
      Effect.map(openApiBindingConfigFromSource(source), (bindingConfig) => ({
        kind: "openapi",
        endpoint: source.endpoint,
        specUrl: bindingConfig.specUrl,
        defaultHeaders: bindingConfig.defaultHeaders,
      })),
    ),
  validateSource: (source) =>
    Effect.gen(function* () {
      const bindingConfig = yield* openApiBindingConfigFromSource(source);
      return {
        ...source,
        bindingVersion: OPENAPI_BINDING_CONFIG_VERSION,
        binding: {
          specUrl: bindingConfig.specUrl,
          defaultHeaders: bindingConfig.defaultHeaders,
        },
      };
    }),
  shouldAutoProbe: (source) =>
    source.enabled && (source.status === "draft" || source.status === "probing"),
  parseManifest: ({ source, manifestJson }) =>
    parseJsonValue<OpenApiToolManifest>({
      label: `OpenAPI manifest for ${source.id}`,
      value: manifestJson,
    }),
  describePersistedOperation: ({ operation, path }) =>
    Effect.gen(function* () {
      const decoded = operation.providerDataJson
        ? decodeOpenApiProviderDataJson(operation.providerDataJson)
        : Either.left(new Error("Missing providerDataJson"));
      if (Either.isLeft(decoded)) {
        return yield* Effect.fail(
          new Error(`Invalid OpenAPI provider data for ${path}`),
        );
      }

      const providerData = decoded.right;
      const method = providerData.method.toUpperCase();

      return {
        method: providerData.method,
        pathTemplate: providerData.path,
        rawToolId: providerData.rawToolId,
        operationId: providerData.operationId ?? null,
        group: providerData.group,
        leaf: providerData.leaf,
        tags: providerData.tags,
        searchText: normalizeSearchText(
          path,
          operation.toolId,
          operation.title ?? undefined,
          operation.description ?? undefined,
          providerData.rawToolId,
          providerData.operationId ?? undefined,
          method,
          providerData.path,
          providerData.group,
          providerData.leaf,
          providerData.tags.join(" "),
          operation.searchText,
        ),
        interaction: method === "GET" || method === "HEAD" ? "auto" : "required",
        approvalLabel: `${method} ${providerData.path}`,
      } as const;
    }),
  createToolDescriptor: ({ source, operation, path, includeSchemas, schemaBundleId }) =>
    createStandardToolDescriptor({
      source,
      operation,
      path,
      includeSchemas,
      interaction: operation.operationKind === "read" ? "auto" : "required",
      outputType: openApiOutputTypeSignatureFromSchemaJson(
        operation.outputSchemaJson ?? undefined,
        320,
      ),
      schemaBundleId,
    }),
  materializeSource: ({ source, resolveAuthMaterialForSlot }) =>
    Effect.gen(function* () {
      const bindingConfig = yield* openApiBindingConfigFromSource(source);

      const auth = yield* resolveAuthMaterialForSlot("import");
      const openApiDocument = yield* fetchOpenApiDocumentWithHeaders({
        url: bindingConfig.specUrl,
        headers: {
          ...(bindingConfig.defaultHeaders ?? {}),
          ...auth.headers,
        },
      }).pipe(
        Effect.mapError(
          (cause) =>
            isSourceCredentialRequiredError(cause)
              ? cause
              : new Error(
                `Failed fetching OpenAPI spec for ${source.id}: ${cause.message}`,
              ),
        ),
      );

      const manifest = yield* extractOpenApiManifest(
        source.name,
        openApiDocument,
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
      );

      const definitions = compileOpenApiToolDefinitions(manifest);
      const now = Date.now();
      const schemaBundle = toOpenApiSchemaBundleRecord({
        recipeRevisionId: OPENAPI_MATERIALIZATION_REVISION_ID,
        refTable: manifest.refHintTable,
        now,
      });

      return {
        manifestJson: JSON.stringify(manifest),
        manifestHash: manifest.sourceHash,
        sourceHash: manifest.sourceHash,
        documents: [
          {
            id: `src_recipe_doc_${crypto.randomUUID()}`,
            recipeRevisionId: OPENAPI_MATERIALIZATION_REVISION_ID,
            documentKind: "openapi",
            documentKey: bindingConfig.specUrl,
            contentText: openApiDocument,
            contentHash: contentHash(openApiDocument),
            fetchedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        ],
        schemaBundles: schemaBundle ? [schemaBundle] : [],
        operations: definitions.map((definition) =>
          toOpenApiRecipeOperationRecord({
            recipeRevisionId: OPENAPI_MATERIALIZATION_REVISION_ID,
            definition,
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
      const bindingConfig = yield* openApiBindingConfigFromSource(source);
      const refHintTable = schemaBundle
        ? decodeOpenApiRefHintTableJson(schemaBundle.refsJson)
        : Either.right({});

      if (Either.isLeft(refHintTable)) {
        return yield* Effect.fail(
          new Error(`Invalid OpenAPI schema bundle for ${path}`),
        );
      }

      const tool = createOpenApiToolFromDefinition({
        definition: openApiDefinitionFromPersistedOperation({
          source,
          path,
          operation,
        }),
        path,
        sourceKey: source.id,
        baseUrl: source.endpoint,
        defaultHeaders: bindingConfig.defaultHeaders ?? {},
        credentialHeaders: auth.headers,
        refHintTable: refHintTable.right,
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
