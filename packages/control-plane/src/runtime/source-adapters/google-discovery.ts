import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import {
  makeToolInvokerFromTools,
  typeSignatureFromSchemaJson,
} from "@executor/codemode-core";
import {
  compileGoogleDiscoveryToolDefinitions,
  createGoogleDiscoveryToolFromDefinition,
  decodeGoogleDiscoverySchemaRefTableJson,
  extractGoogleDiscoveryManifest,
  googleDiscoveryProviderDataJsonFromDefinition,
  GoogleDiscoveryToolProviderDataSchema,
  type GoogleDiscoveryToolManifest,
} from "@executor/codemode-google-discovery";
import type {
  Source,
  SourceRecipeRevisionId,
  StoredSourceRecipeDocumentRecord,
  StoredSourceRecipeOperationRecord,
  StoredSourceRecipeSchemaBundleRecord,
} from "#schema";
import {
  SourceRecipeSchemaBundleIdSchema,
  StringMapSchema,
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
} from "./types";
import {
  ConnectHttpAuthSchema,
  ConnectHttpImportAuthSchema,
  ConnectOauthClientSchema,
  createStandardToolDescriptor,
  decodeBindingConfig,
  decodeSourceBindingPayload,
  emptySourceBindingState,
  encodeBindingConfig,
  isSourceCredentialRequiredError,
  OptionalNullableStringSchema,
  parseJsonValue,
  SourceCredentialRequiredError,
} from "./shared";

const GoogleDiscoveryConnectPayloadSchema = Schema.extend(
  ConnectHttpImportAuthSchema,
  Schema.Struct({
    kind: Schema.Literal("google_discovery"),
    service: Schema.Trim.pipe(Schema.nonEmptyString()),
    version: Schema.Trim.pipe(Schema.nonEmptyString()),
    discoveryUrl: Schema.optional(
      Schema.NullOr(Schema.Trim.pipe(Schema.nonEmptyString())),
    ),
    scopes: Schema.optional(
      Schema.Array(Schema.Trim.pipe(Schema.nonEmptyString())),
    ),
    oauthClient: ConnectOauthClientSchema,
    name: OptionalNullableStringSchema,
    namespace: OptionalNullableStringSchema,
    auth: Schema.optional(ConnectHttpAuthSchema),
  }),
);

const GoogleDiscoveryExecutorAddInputSchema = GoogleDiscoveryConnectPayloadSchema;

const GoogleDiscoveryBindingConfigSchema = Schema.Struct({
  service: Schema.Trim.pipe(Schema.nonEmptyString()),
  version: Schema.Trim.pipe(Schema.nonEmptyString()),
  discoveryUrl: Schema.Trim.pipe(Schema.nonEmptyString()),
  defaultHeaders: Schema.optional(Schema.NullOr(StringMapSchema)),
  scopes: Schema.optional(
    Schema.Array(Schema.Trim.pipe(Schema.nonEmptyString())),
  ),
});

const GoogleDiscoverySourceBindingPayloadSchema = Schema.Struct({
  service: Schema.String,
  version: Schema.String,
  discoveryUrl: Schema.optional(Schema.String),
  defaultHeaders: Schema.optional(Schema.NullOr(StringMapSchema)),
  scopes: Schema.optional(Schema.Array(Schema.String)),
});

type GoogleDiscoveryBindingConfig = typeof GoogleDiscoveryBindingConfigSchema.Type;

const GOOGLE_DISCOVERY_BINDING_CONFIG_VERSION = 1;
const GOOGLE_DISCOVERY_MATERIALIZATION_REVISION_ID =
  "src_recipe_rev_materialization" as SourceRecipeRevisionId;

const decodeGoogleDiscoveryProviderDataJson = Schema.decodeUnknownEither(
  Schema.parseJson(GoogleDiscoveryToolProviderDataSchema),
);

const bindingHasAnyField = (
  value: unknown,
  fields: readonly string[],
): boolean =>
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && fields.some((field) => Object.prototype.hasOwnProperty.call(value, field));

const defaultGoogleDiscoveryUrl = (service: string, version: string): string =>
  `https://www.googleapis.com/discovery/v1/apis/${encodeURIComponent(service)}/${encodeURIComponent(version)}/rest`;

const googleDiscoveryBindingConfigFromSource = (
  source: Pick<Source, "id" | "bindingVersion" | "binding">,
): Effect.Effect<GoogleDiscoveryBindingConfig, Error, never> =>
  Effect.gen(function* () {
    if (bindingHasAnyField(source.binding, ["transport", "queryParams", "headers", "specUrl"])) {
      return yield* Effect.fail(
        new Error("Google Discovery sources cannot define MCP or OpenAPI binding fields"),
      );
    }

    const bindingConfig = yield* decodeSourceBindingPayload({
      sourceId: source.id,
      label: "Google Discovery",
      version: source.bindingVersion,
      expectedVersion: GOOGLE_DISCOVERY_BINDING_CONFIG_VERSION,
      schema: GoogleDiscoverySourceBindingPayloadSchema,
      value: source.binding,
      allowedKeys: ["service", "version", "discoveryUrl", "defaultHeaders", "scopes"],
    });

    const service = bindingConfig.service.trim();
    const version = bindingConfig.version.trim();
    if (service.length === 0 || version.length === 0) {
      return yield* Effect.fail(
        new Error("Google Discovery sources require service and version"),
      );
    }

    const explicitDiscoveryUrl =
      typeof bindingConfig.discoveryUrl === "string" && bindingConfig.discoveryUrl.trim().length > 0
        ? bindingConfig.discoveryUrl.trim()
        : null;

    return {
      service,
      version,
      discoveryUrl: explicitDiscoveryUrl ?? defaultGoogleDiscoveryUrl(service, version),
      defaultHeaders: bindingConfig.defaultHeaders ?? null,
      scopes: (bindingConfig.scopes ?? []).map((scope) => scope.trim()).filter((scope) => scope.length > 0),
    } satisfies GoogleDiscoveryBindingConfig;
  });

const fetchGoogleDiscoveryDocumentWithHeaders = (input: {
  url: string;
  headers?: Readonly<Record<string, string>>;
  queryParams?: Readonly<Record<string, string>>;
  cookies?: Readonly<Record<string, string>>;
}): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(input.url).pipe(
      HttpClientRequest.setHeaders({
        ...(input.headers ?? {}),
        ...(input.cookies
          ? {
              cookie: Object.entries(input.cookies)
                .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
                .join("; "),
            }
          : {}),
      }),
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
          `Google Discovery fetch requires credentials (status ${response.status})`,
        ),
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new Error(`Google Discovery fetch failed with status ${response.status}`),
      );
    }

    return yield* response.text.pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));

const toGoogleDiscoverySchemaBundleRecord = (input: {
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

const toGoogleDiscoveryRecipeOperationRecord = (input: {
  recipeRevisionId: SourceRecipeRevisionId;
  manifest: GoogleDiscoveryToolManifest;
  definition: ReturnType<typeof compileGoogleDiscoveryToolDefinitions>[number];
  now: number;
}): StoredSourceRecipeOperationRecord => ({
  id: `src_recipe_op_${crypto.randomUUID()}`,
  recipeRevisionId: input.recipeRevisionId,
  operationKey: input.definition.toolId,
  transportKind: "http",
  toolId: input.definition.toolId,
  title: input.definition.name,
  description: input.definition.description,
  operationKind:
    input.definition.method === "get" || input.definition.method === "head"
      ? "read"
      : input.definition.method === "delete"
        ? "delete"
        : "write",
  searchText: normalizeSearchText(
    input.definition.toolId,
    input.definition.rawToolId,
    input.definition.methodId,
    input.definition.name,
    input.definition.description ?? undefined,
    input.definition.method,
    input.definition.path,
    input.definition.group ?? undefined,
    input.definition.leaf,
    input.manifest.service,
    input.manifest.versionName,
    input.definition.scopes.join(" "),
  ),
  inputSchemaJson: input.definition.inputSchemaJson ?? null,
  outputSchemaJson: input.definition.outputSchemaJson ?? null,
  providerKind: "google_discovery",
  providerDataJson: googleDiscoveryProviderDataJsonFromDefinition({
    service: input.manifest.service,
    version: input.manifest.versionName,
    rootUrl: input.manifest.rootUrl,
    servicePath: input.manifest.servicePath,
    definition: input.definition,
  }),
  createdAt: input.now,
  updatedAt: input.now,
});

const googleDiscoveryDefinitionFromPersistedOperation = (input: {
  path: string;
  operation: StoredSourceRecipeOperationRecord;
}) => {
  const decoded = input.operation.providerDataJson
    ? decodeGoogleDiscoveryProviderDataJson(input.operation.providerDataJson)
    : Either.left(new Error("Missing providerDataJson"));

  if (Either.isLeft(decoded)) {
    throw new Error(`Invalid Google Discovery provider data for ${input.path}`);
  }

  const providerData = decoded.right;
  return {
    definition: {
      toolId: input.operation.toolId,
      rawToolId: providerData.rawToolId,
      methodId: providerData.methodId,
      name: input.operation.title ?? input.operation.toolId,
      description: input.operation.description,
      group: providerData.group,
      leaf: providerData.leaf,
      method: providerData.invocation.method,
      path: providerData.invocation.path,
      flatPath: providerData.invocation.flatPath,
      parameters: providerData.invocation.parameters,
      requestSchemaId: providerData.invocation.requestSchemaId,
      responseSchemaId: providerData.invocation.responseSchemaId,
      scopes: providerData.invocation.scopes,
      supportsMediaUpload: providerData.invocation.supportsMediaUpload,
      supportsMediaDownload: providerData.invocation.supportsMediaDownload,
      ...(input.operation.inputSchemaJson
        ? { inputSchemaJson: input.operation.inputSchemaJson }
        : {}),
      ...(input.operation.outputSchemaJson
        ? { outputSchemaJson: input.operation.outputSchemaJson }
        : {}),
    },
    providerData,
  };
};

const googleDiscoveryOauth2SetupConfig = (source: Source) =>
  Effect.gen(function* () {
    const bindingConfig = yield* googleDiscoveryBindingConfigFromSource(source);
    const configuredScopes = bindingConfig.scopes ?? [];
    const scopes = configuredScopes.length > 0
      ? configuredScopes
      : yield* fetchGoogleDiscoveryDocumentWithHeaders({
          url: bindingConfig.discoveryUrl,
          headers: bindingConfig.defaultHeaders ?? undefined,
        }).pipe(
          Effect.flatMap((document) => extractGoogleDiscoveryManifest(source.name, document)),
          Effect.map((manifest) => Object.keys(manifest.oauthScopes ?? {})),
        );

    if (scopes.length === 0) {
      return null;
    }

    return {
      providerKey: "google_workspace",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      scopes,
      headerName: "Authorization",
      prefix: "Bearer ",
      clientAuthentication: "client_secret_post" as const,
      authorizationParams: {
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
      },
    };
  });

export const googleDiscoverySourceAdapter: SourceAdapter = {
  key: "google_discovery",
  displayName: "Google Discovery",
  family: "http_api",
  bindingConfigVersion: GOOGLE_DISCOVERY_BINDING_CONFIG_VERSION,
  providerKey: "google_workspace",
  defaultImportAuthPolicy: "reuse_runtime",
  primaryDocumentKind: "google_discovery",
  primarySchemaBundleKind: "json_schema_ref_map",
  connectPayloadSchema: GoogleDiscoveryConnectPayloadSchema,
  executorAddInputSchema: GoogleDiscoveryExecutorAddInputSchema,
  executorAddHelpText: [
    "service is the Discovery service name, e.g. sheets or drive. version is the API version, e.g. v4 or v3.",
  ],
  executorAddInputSignatureWidth: 420,
  serializeBindingConfig: (source) =>
    encodeBindingConfig({
      adapterKey: "google_discovery",
      version: GOOGLE_DISCOVERY_BINDING_CONFIG_VERSION,
      payloadSchema: GoogleDiscoveryBindingConfigSchema,
      payload: Effect.runSync(googleDiscoveryBindingConfigFromSource(source)),
    }),
  deserializeBindingConfig: ({ id, bindingConfigJson }) =>
    Effect.map(
      decodeBindingConfig({
        sourceId: id,
        label: "Google Discovery",
        adapterKey: "google_discovery",
        version: GOOGLE_DISCOVERY_BINDING_CONFIG_VERSION,
        payloadSchema: GoogleDiscoveryBindingConfigSchema,
        value: bindingConfigJson,
      }),
      ({ version, payload }) => ({
        version,
        payload: {
          service: payload.service,
          version: payload.version,
          discoveryUrl: payload.discoveryUrl,
          defaultHeaders: payload.defaultHeaders ?? null,
          scopes: payload.scopes ?? [],
        },
      }),
    ),
  bindingStateFromSource: (source) =>
    Effect.map(googleDiscoveryBindingConfigFromSource(source), (bindingConfig) => ({
      ...emptySourceBindingState,
      defaultHeaders: bindingConfig.defaultHeaders ?? null,
    })),
  sourceConfigFromSource: (source) =>
    Effect.runSync(
      Effect.map(googleDiscoveryBindingConfigFromSource(source), (bindingConfig) => ({
        kind: "google_discovery",
        service: bindingConfig.service,
        version: bindingConfig.version,
        discoveryUrl: bindingConfig.discoveryUrl,
        defaultHeaders: bindingConfig.defaultHeaders,
        scopes: bindingConfig.scopes,
      })),
    ),
  validateSource: (source) =>
    Effect.gen(function* () {
      const bindingConfig = yield* googleDiscoveryBindingConfigFromSource(source);
      return {
        ...source,
        bindingVersion: GOOGLE_DISCOVERY_BINDING_CONFIG_VERSION,
        binding: {
          service: bindingConfig.service,
          version: bindingConfig.version,
          discoveryUrl: bindingConfig.discoveryUrl,
          defaultHeaders: bindingConfig.defaultHeaders ?? null,
          scopes: [...(bindingConfig.scopes ?? [])],
        },
      };
    }),
  shouldAutoProbe: (source) =>
    source.enabled && (source.status === "draft" || source.status === "probing"),
  parseManifest: ({ source, manifestJson }) =>
    parseJsonValue<GoogleDiscoveryToolManifest>({
      label: `Google Discovery manifest for ${source.id}`,
      value: manifestJson,
    }),
  describePersistedOperation: ({ path, operation }) =>
    Effect.gen(function* () {
      const decoded = operation.providerDataJson
        ? decodeGoogleDiscoveryProviderDataJson(operation.providerDataJson)
        : Either.left(new Error("Missing providerDataJson"));
      if (Either.isLeft(decoded)) {
        return yield* Effect.fail(
          new Error(`Invalid Google Discovery provider data for ${path}`),
        );
      }

      const providerData = decoded.right;
      const method = providerData.invocation.method.toUpperCase();
      return {
        method: providerData.invocation.method,
        pathTemplate: providerData.invocation.path,
        rawToolId: providerData.rawToolId,
        operationId: providerData.methodId,
        group: providerData.group,
        leaf: providerData.leaf,
        tags: [],
        searchText: normalizeSearchText(
          path,
          operation.toolId,
          operation.title ?? undefined,
          operation.description ?? undefined,
          providerData.rawToolId,
          providerData.methodId,
          method,
          providerData.invocation.path,
          providerData.group ?? undefined,
          providerData.leaf,
          providerData.service,
          providerData.version,
          providerData.invocation.scopes.join(" "),
          operation.searchText,
        ),
        interaction: method === "GET" || method === "HEAD" ? "auto" : "required",
        approvalLabel: `${method} ${providerData.invocation.path}`,
      } as const;
    }),
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
  materializeSource: ({ source, resolveAuthMaterialForSlot }): Effect.Effect<
    SourceAdapterMaterialization,
    Error,
    never
  > =>
    Effect.gen(function* () {
      const bindingConfig = yield* googleDiscoveryBindingConfigFromSource(source);
      const auth = yield* resolveAuthMaterialForSlot("import");
      const discoveryDocument = yield* fetchGoogleDiscoveryDocumentWithHeaders({
        url: bindingConfig.discoveryUrl,
        headers: {
          ...(bindingConfig.defaultHeaders ?? {}),
          ...auth.headers,
        },
        cookies: auth.cookies,
        queryParams: auth.queryParams,
      }).pipe(
        Effect.mapError((cause) =>
          isSourceCredentialRequiredError(cause)
            ? cause
            : new Error(
              `Failed fetching Google Discovery document for ${source.id}: ${cause.message}`,
            ),
        ),
      );
      const manifest = yield* extractGoogleDiscoveryManifest(
        source.name,
        discoveryDocument,
      );
      const definitions = compileGoogleDiscoveryToolDefinitions(manifest);
      const now = Date.now();
      const schemaBundle = toGoogleDiscoverySchemaBundleRecord({
        recipeRevisionId: GOOGLE_DISCOVERY_MATERIALIZATION_REVISION_ID,
        refTable: manifest.schemaRefTable,
        now,
      });

      return {
        manifestJson: JSON.stringify(manifest),
        manifestHash: manifest.sourceHash,
        sourceHash: manifest.sourceHash,
        documents: [
          {
            id: `src_recipe_doc_${crypto.randomUUID()}`,
            recipeRevisionId: GOOGLE_DISCOVERY_MATERIALIZATION_REVISION_ID,
            documentKind: "google_discovery",
            documentKey: bindingConfig.discoveryUrl,
            contentText: discoveryDocument,
            contentHash: contentHash(discoveryDocument),
            fetchedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        ],
        schemaBundles: schemaBundle ? [schemaBundle] : [],
        operations: definitions.map((definition) =>
          toGoogleDiscoveryRecipeOperationRecord({
            recipeRevisionId: GOOGLE_DISCOVERY_MATERIALIZATION_REVISION_ID,
            manifest,
            definition,
            now,
          })),
      };
    }),
  getOauth2SetupConfig: ({ source }) => googleDiscoveryOauth2SetupConfig(source),
  normalizeOauthClientInput: (input) =>
    Effect.succeed({
      ...input,
      redirectMode: input.redirectMode ?? "loopback",
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
      const bindingConfig = yield* googleDiscoveryBindingConfigFromSource(source);
      const schemaRefTable = schemaBundle
        ? decodeGoogleDiscoverySchemaRefTableJson(schemaBundle.refsJson)
        : Either.right({});
      if (Either.isLeft(schemaRefTable)) {
        return yield* Effect.fail(
          new Error(`Invalid Google Discovery schema bundle for ${path}`),
        );
      }

      const { definition, providerData } = googleDiscoveryDefinitionFromPersistedOperation({
        path,
        operation,
      });
      const stringRefTable = Object.fromEntries(
        Object.entries(schemaRefTable.right).map(([ref, value]) => [
          ref,
          typeof value === "string" ? value : JSON.stringify(value),
        ]),
      );

      const tool = createGoogleDiscoveryToolFromDefinition({
        definition,
        service: providerData.service,
        version: providerData.version,
        rootUrl: providerData.invocation.rootUrl,
        servicePath: providerData.invocation.servicePath,
        path,
        sourceKey: source.id,
        defaultHeaders: bindingConfig.defaultHeaders ?? {},
        credentialPlacements: auth,
        schemaRefTable: stringRefTable,
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
