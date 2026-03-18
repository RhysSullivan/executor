import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import {
  applyCookiePlacementsToHeaders,
  applyHttpQueryPlacementsToUrl,
  applyJsonBodyPlacements,
} from "@executor/codemode-core";
import { buildOpenApiToolPresentation } from "./tool-presentation";
import { compileOpenApiToolDefinitions } from "./definitions";
import { detectOpenApiSource } from "./discovery";
import {
  httpBodyModeFromContentType,
  serializeOpenApiParameterValue,
  serializeOpenApiRequestBody,
  withSerializedQueryEntries,
} from "./http-serialization";
import { OpenApiLocalConfigBindingSchema } from "./local-config";
import {
  OpenApiToolProviderDataSchema,
  type OpenApiRefHintTable,
  type OpenApiToolProviderData,
} from "./types";
import {
  createOpenApiCatalogFragment,
  type OpenApiCatalogOperationInput,
} from "./catalog";
import { extractOpenApiManifest } from "./extraction";
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

const bindingHasAnyField = (
  value: unknown,
  fields: readonly string[],
): boolean =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  fields.some((field) => Object.prototype.hasOwnProperty.call(value, field));

const openApiBindingConfigFromSource = (
  source: Pick<Source, "id" | "bindingVersion" | "binding">,
): Effect.Effect<OpenApiBindingConfig, Error, never> =>
  Effect.gen(function* () {
    if (
      bindingHasAnyField(source.binding, [
        "transport",
        "queryParams",
        "headers",
      ])
    ) {
      return yield* sourceCoreEffectError("openapi/adapter", "OpenAPI sources cannot define MCP transport settings");
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

    const specUrl =
      typeof bindingConfig.specUrl === "string"
        ? bindingConfig.specUrl.trim()
        : "";
    if (specUrl.length === 0) {
      return yield* sourceCoreEffectError("openapi/adapter", "OpenAPI sources require specUrl");
    }

    return {
      specUrl,
      defaultHeaders: bindingConfig.defaultHeaders ?? null,
    } satisfies OpenApiBindingConfig;
  });

const fetchOpenApiDocumentWithHeaders = (input: {
  url: string;
  headers?: Readonly<Record<string, string>>;
  queryParams?: Readonly<Record<string, string>>;
  cookies?: Readonly<Record<string, string>>;
}): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(
      applyHttpQueryPlacementsToUrl({
        url: input.url,
        queryParams: input.queryParams,
      }).toString(),
    ).pipe(
      HttpClientRequest.setHeaders(
        applyCookiePlacementsToHeaders({
          headers: input.headers ?? {},
          cookies: input.cookies,
        }),
      ),
    );
    const response = yield* client
      .execute(request)
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
      );

    if (response.status === 401 || response.status === 403) {
      return yield* new SourceCredentialRequiredError(
          "import",
          `OpenAPI spec fetch requires credentials (status ${response.status})`,
        );
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* sourceCoreEffectError("openapi/adapter", `OpenAPI spec fetch failed with status ${response.status}`);
    }

    return yield* response.text.pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

type OpenApiToolArgs = Record<string, unknown>;
type OpenApiToolParameter =
  OpenApiToolProviderData["invocation"]["parameters"][number];

const parameterContainerKeys: Record<
  OpenApiToolParameter["location"],
  Array<string>
> = {
  path: ["path", "pathParams", "params"],
  query: ["query", "queryParams", "params"],
  header: ["headers", "header"],
  cookie: ["cookies", "cookie"],
};

const readParameterValue = (
  args: OpenApiToolArgs,
  parameter: OpenApiToolParameter,
): unknown => {
  const directValue = args[parameter.name];
  if (directValue !== undefined) {
    return directValue;
  }

  for (const key of parameterContainerKeys[parameter.location]) {
    const container = args[key];
    if (
      typeof container !== "object" ||
      container === null ||
      Array.isArray(container)
    ) {
      continue;
    }

    const nestedValue = (container as Record<string, unknown>)[parameter.name];
    if (nestedValue !== undefined) {
      return nestedValue;
    }
  }

  return undefined;
};

const replacePathTemplate = (
  pathTemplate: string,
  args: OpenApiToolArgs,
  payload: OpenApiToolProviderData["invocation"],
): string => {
  let resolvedPath = pathTemplate;

  for (const parameter of payload.parameters) {
    if (parameter.location !== "path") {
      continue;
    }

    const parameterValue = readParameterValue(args, parameter);
    if (parameterValue === undefined || parameterValue === null) {
      if (parameter.required) {
        throw new Error(`Missing required path parameter: ${parameter.name}`);
      }
      continue;
    }

    const serialized = serializeOpenApiParameterValue(
      parameter,
      parameterValue,
    );
    resolvedPath = resolvedPath.replaceAll(
      `{${parameter.name}}`,
      serialized.kind === "path"
        ? serialized.value
        : encodeURIComponent(String(parameterValue)),
    );
  }

  const unresolvedPathParameters = [...resolvedPath.matchAll(/\{([^{}]+)\}/g)]
    .map((match) => match[1])
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );

  for (const parameterName of unresolvedPathParameters) {
    const parameterValue =
      args[parameterName] ??
      (typeof args.path === "object" &&
      args.path !== null &&
      !Array.isArray(args.path)
        ? (args.path as Record<string, unknown>)[parameterName]
        : undefined) ??
      (typeof args.pathParams === "object" &&
      args.pathParams !== null &&
      !Array.isArray(args.pathParams)
        ? (args.pathParams as Record<string, unknown>)[parameterName]
        : undefined) ??
      (typeof args.params === "object" &&
      args.params !== null &&
      !Array.isArray(args.params)
        ? (args.params as Record<string, unknown>)[parameterName]
        : undefined);

    if (parameterValue === undefined || parameterValue === null) {
      continue;
    }

    resolvedPath = resolvedPath.replaceAll(
      `{${parameterName}}`,
      encodeURIComponent(String(parameterValue)),
    );
  }

  const stillUnresolved = [...resolvedPath.matchAll(/\{([^{}]+)\}/g)]
    .map((match) => match[1])
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  if (stillUnresolved.length > 0) {
    const names = [...new Set(stillUnresolved)].sort().join(", ");
    throw new Error(`Unresolved path parameters after substitution: ${names}`);
  }

  return resolvedPath;
};

const responseHeadersRecord = (response: Response): Record<string, string> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
};

const decodeResponseBody = async (response: Response): Promise<unknown> => {
  if (response.status === 204) {
    return null;
  }

  const bodyMode = httpBodyModeFromContentType(
    response.headers.get("content-type"),
  );
  if (bodyMode === "json") {
    return response.json();
  }
  if (bodyMode === "bytes") {
    return new Uint8Array(await response.arrayBuffer());
  }

  return response.text();
};

const resolveOpenApiBaseUrl = (input: {
  endpoint: string;
  providerData: OpenApiToolProviderData;
}): string => {
  const server =
    input.providerData.servers?.[0] ?? input.providerData.documentServers?.[0];
  if (!server) {
    return new URL(input.endpoint).toString();
  }

  const expanded = Object.entries(server.variables ?? {}).reduce(
    (url, [name, value]) => url.replaceAll(`{${name}}`, value),
    server.url,
  );

  return new URL(expanded, input.endpoint).toString();
};

const resolveRequestUrl = (baseUrl: string, resolvedPath: string): URL => {
  try {
    return new URL(resolvedPath);
  } catch {
    const resolved = new URL(baseUrl);
    const basePath =
      resolved.pathname === "/"
        ? ""
        : resolved.pathname.endsWith("/")
          ? resolved.pathname.slice(0, -1)
          : resolved.pathname;
    const pathPart = resolvedPath.startsWith("/")
      ? resolvedPath
      : `/${resolvedPath}`;

    resolved.pathname = `${basePath}${pathPart}`.replace(/\/{2,}/g, "/");
    resolved.search = "";
    resolved.hash = "";
    return resolved;
  }
};

const openApiCatalogOperationFromDefinition = (input: {
  definition: ReturnType<typeof compileOpenApiToolDefinitions>[number];
  refHintTable?: Readonly<OpenApiRefHintTable>;
}): OpenApiCatalogOperationInput => {
  const presentation = buildOpenApiToolPresentation({
    definition: input.definition,
    refHintTable: input.refHintTable,
  });
  const method = input.definition.method.toUpperCase();

  return {
    toolId: input.definition.toolId,
    title: input.definition.name,
    description: input.definition.description,
    effect:
      method === "GET" || method === "HEAD"
        ? "read"
        : method === "DELETE"
          ? "delete"
          : "write",
    inputSchema: presentation.inputSchema,
    outputSchema: presentation.outputSchema,
    providerData: presentation.providerData as OpenApiToolProviderData,
  };
};

export const openApiSourceAdapter = {
  key: "openapi",
  displayName: "OpenAPI",
  catalogKind: "imported",
  connectStrategy: "direct",
  credentialStrategy: "credential_managed",
  bindingConfigVersion: OPENAPI_BINDING_CONFIG_VERSION,
  providerKey: "generic_http",
  defaultImportAuthPolicy: "reuse_runtime",
  connectPayloadSchema: OpenApiConnectPayloadSchema,
  executorAddInputSchema: OpenApiExecutorAddInputSchema,
  executorAddHelpText: [
    "endpoint is the base API URL. specUrl is the OpenAPI document URL.",
  ],
  executorAddInputSignatureWidth: 420,
  localConfigBindingSchema: OpenApiLocalConfigBindingSchema,
  localConfigBindingFromSource: (source) =>
    Effect.runSync(
      Effect.map(openApiBindingConfigFromSource(source), (bindingConfig) => ({
        specUrl: bindingConfig.specUrl,
        defaultHeaders: bindingConfig.defaultHeaders,
      })),
    ),
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
    source.enabled &&
    (source.status === "draft" || source.status === "probing"),
  discoveryPriority: ({ normalizedUrl }) =>
    looksLikeGraphqlEndpoint(normalizedUrl) ? 50 : 250,
  detectSource: ({ normalizedUrl, headers }) =>
    detectOpenApiSource({
      normalizedUrl,
      headers,
    }),
  syncCatalog: ({ source, resolveAuthMaterialForSlot }) =>
    Effect.gen(function* () {
      const bindingConfig = yield* openApiBindingConfigFromSource(source);

      const auth = yield* resolveAuthMaterialForSlot("import");
      const openApiDocument = yield* fetchOpenApiDocumentWithHeaders({
        url: bindingConfig.specUrl,
        headers: {
          ...bindingConfig.defaultHeaders,
          ...auth.headers,
        },
        queryParams: auth.queryParams,
        cookies: auth.cookies,
      }).pipe(
        Effect.mapError((cause) =>
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

      return createSourceCatalogSyncResult({
        fragment: createOpenApiCatalogFragment({
          source,
          documents: [
            {
              documentKind: "openapi",
              documentKey: bindingConfig.specUrl,
              contentText: openApiDocument,
              fetchedAt: now,
            },
          ],
          operations: definitions.map((definition) =>
            openApiCatalogOperationFromDefinition({
              definition,
              refHintTable: manifest.refHintTable,
            }),
          ),
        }),
        importMetadata: createCatalogImportMetadata({
          source,
          adapterKey: "openapi",
        }),
        sourceHash: manifest.sourceHash,
      });
    }),
  invoke: (input) =>
    Effect.tryPromise({
      try: async () => {
        const bindingConfig = Effect.runSync(
          openApiBindingConfigFromSource(input.source),
        );
        const providerData = decodeExecutableBindingPayload({
          executableId: input.executable.id,
          label: "OpenAPI",
          version: input.executable.bindingVersion,
          expectedVersion: EXECUTABLE_BINDING_VERSION,
          schema: OpenApiToolProviderDataSchema,
          value: input.executable.binding,
        }) as OpenApiToolProviderData;
        const args = asRecord(input.args);
        const resolvedPath = replacePathTemplate(
          providerData.invocation.pathTemplate,
          args,
          providerData.invocation,
        );
        const headers: Record<string, string> = {
          ...bindingConfig.defaultHeaders,
        };
        const queryEntries: Array<{
          name: string;
          value: string;
          allowReserved?: boolean;
        }> = [];
        const cookieParts: string[] = [];

        for (const parameter of providerData.invocation.parameters) {
          if (parameter.location === "path") {
            continue;
          }

          const value = readParameterValue(args, parameter);
          if (value === undefined || value === null) {
            if (parameter.required) {
              throw new Error(
                `Missing required ${parameter.location} parameter ${parameter.name}`,
              );
            }
            continue;
          }

          const serialized = serializeOpenApiParameterValue(parameter, value);
          if (serialized.kind === "query") {
            queryEntries.push(...serialized.entries);
            continue;
          }
          if (serialized.kind === "header") {
            headers[parameter.name] = serialized.value;
            continue;
          }
          if (serialized.kind === "cookie") {
            cookieParts.push(
              ...serialized.pairs.map(
                (pair) => `${pair.name}=${encodeURIComponent(pair.value)}`,
              ),
            );
          }
        }

        let body: string | Uint8Array | undefined;
        if (providerData.invocation.requestBody) {
          const bodyValue = args.body ?? args.input;
          if (bodyValue !== undefined) {
            const serializedBody = serializeOpenApiRequestBody({
              requestBody: providerData.invocation.requestBody,
              body: applyJsonBodyPlacements({
                body: bodyValue,
                bodyValues: input.auth.bodyValues,
                label: `${providerData.method.toUpperCase()} ${providerData.path}`,
              }),
            });
            headers["content-type"] = serializedBody.contentType;
            body = serializedBody.body;
          }
        }

        const requestUrl = resolveRequestUrl(
          resolveOpenApiBaseUrl({
            endpoint: input.source.endpoint,
            providerData,
          }),
          resolvedPath,
        );
        const urlWithAuth = applyHttpQueryPlacementsToUrl({
          url: requestUrl,
          queryParams: input.auth.queryParams,
        });
        const finalUrl = withSerializedQueryEntries(urlWithAuth, queryEntries);
        const requestHeaders = applyCookiePlacementsToHeaders({
          headers: {
            ...headers,
            ...input.auth.headers,
          },
          cookies: {
            ...input.auth.cookies,
          },
        });

        if (cookieParts.length > 0) {
          const existingCookie = requestHeaders.cookie;
          requestHeaders.cookie = existingCookie
            ? `${existingCookie}; ${cookieParts.join("; ")}`
            : cookieParts.join("; ");
        }

        const response = await fetch(finalUrl.toString(), {
          method: providerData.method.toUpperCase(),
          headers: requestHeaders,
          ...(body !== undefined
            ? {
                body:
                  typeof body === "string" ? body : new Uint8Array(body).buffer,
              }
            : {}),
        });
        const responseBody = await decodeResponseBody(response);

        return {
          data: response.ok ? responseBody : null,
          error: response.ok ? null : responseBody,
          headers: responseHeadersRecord(response),
          status: response.status,
        };
      },
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }),
} satisfies SourceAdapter;
