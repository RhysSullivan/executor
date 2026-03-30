import { createHash } from "node:crypto";
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
  createPluginScopeConfigEntrySchema,
  provideExecutorRuntime,
  pluginScopeConfigSourceFromConfig,
  runtimeEffectError,
  SecretMaterialResolverService,
} from "@executor/platform-sdk/runtime";
import {
  OpenApiConnectionAuthSchema,
  OpenApiConnectInputSchema,
  OpenApiPreviewRequestSchema,
  OpenApiPreviewResponseSchema,
  OpenApiSourceConfigPayloadSchema,
  OpenApiUpdateSourceInputSchema,
  deriveOpenApiNamespace,
  previewOpenApiDocument,
  type OpenApiConnectInput,
  type OpenApiPreviewRequest,
  type OpenApiPreviewResponse,
  type OpenApiSourceConfigPayload,
  type OpenApiStoredSourceData,
  type OpenApiUpdateSourceInput,
} from "@executor/plugin-openapi-shared";
import {
  createOpenApiCatalogFragment,
  openApiCatalogOperationFromDefinition,
} from "./catalog";
import {
  compileOpenApiToolDefinitions,
} from "./definitions";
import {
  extractOpenApiManifest,
} from "./extraction";
import {
  httpBodyModeFromContentType,
  serializeOpenApiParameterValue,
  serializeOpenApiRequestBody,
  withSerializedQueryEntries,
} from "./http-serialization";
import {
  OpenApiExecutableBindingSchema,
  type OpenApiExecutableBinding,
} from "./types";

const OpenApiSourceIdInputSchema = Schema.Struct({
  sourceId: Schema.String,
});

const stableSourceHash = (value: OpenApiStoredSourceData): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

export type OpenApiSourceStorage = {
  get: (input: {
    scopeId: string;
    sourceId: string;
  }) => Effect.Effect<OpenApiStoredSourceData | null, Error, never>;
  put: (input: {
    scopeId: string;
    sourceId: string;
    value: OpenApiStoredSourceData;
  }) => Effect.Effect<void, Error, never>;
  remove?: (input: {
    scopeId: string;
    sourceId: string;
  }) => Effect.Effect<void, Error, never>;
};

export type OpenApiSdk = {
  previewDocument: (
    input: OpenApiPreviewRequest,
  ) => Effect.Effect<OpenApiPreviewResponse, Error, never>;
  getSourceConfig: (
    sourceId: Source["id"],
  ) => Effect.Effect<OpenApiSourceConfigPayload, Error, never>;
  createSource: (
    input: OpenApiConnectInput,
  ) => Effect.Effect<Source, Error, never>;
  updateSource: (
    input: OpenApiUpdateSourceInput,
  ) => Effect.Effect<Source, Error, never>;
  refreshSource: (
    sourceId: Source["id"],
  ) => Effect.Effect<Source, Error, never>;
  removeSource: (
    sourceId: Source["id"],
  ) => Effect.Effect<boolean, Error, never>;
};

export type OpenApiSdkPluginOptions = {
  storage: OpenApiSourceStorage;
};

const OpenApiExecutorAddInputSchema = Schema.Struct({
  kind: Schema.Literal("openapi"),
  name: Schema.String,
  specUrl: Schema.String,
  baseUrl: Schema.NullOr(Schema.String),
  auth: OpenApiConnectionAuthSchema,
});

type OpenApiExecutorAddInput = typeof OpenApiExecutorAddInputSchema.Type;

const normalizeOpenApiAuth = (
  auth: Record<string, unknown>,
): OpenApiStoredSourceData["auth"] =>
  auth.kind === "bearer"
    ? {
        kind: "bearer",
        tokenSecretRef: auth.tokenSecretRef as Extract<
          OpenApiStoredSourceData["auth"],
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
  stored: OpenApiStoredSourceData,
): OpenApiStoredSourceData => ({
  ...stored,
  auth: normalizeOpenApiAuth(stored.auth as Record<string, unknown>),
});

const OpenApiLocalSourceConfigSchema = Schema.Struct({
  specUrl: Schema.String,
  baseUrl: Schema.NullOr(Schema.String),
  auth: OpenApiConnectionAuthSchema,
  defaultHeaders: Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.String })),
});

const decodeOpenApiCurrentLocalConfigOption = Schema.decodeUnknownOption(
  createPluginScopeConfigEntrySchema({
    kind: "openapi",
    config: OpenApiLocalSourceConfigSchema,
  }),
);

const createStoredSourceData = (
  input: OpenApiConnectInput,
): OpenApiStoredSourceData => ({
  specUrl: input.specUrl.trim(),
  baseUrl: input.baseUrl?.trim() || null,
  auth:
    input.auth.kind === "bearer"
      ? {
          ...input.auth,
          headerName: input.auth.headerName ?? null,
          prefix: input.auth.prefix ?? null,
        }
      : input.auth,
  defaultHeaders: null,
  etag: null,
  lastSyncAt: null,
});

const configFromStoredSourceData = (
  source: Source,
  stored: OpenApiStoredSourceData,
): OpenApiSourceConfigPayload => ({
  name: source.name,
  specUrl: stored.specUrl,
  baseUrl: stored.baseUrl,
  auth: stored.auth,
});

const openApiStoredSourceDataFromLocalConfig = (input: {
  config: unknown;
  loadedConfig: ExecutorScopeConfig | null;
}): OpenApiStoredSourceData => {
  const current = decodeOpenApiCurrentLocalConfigOption(input.config);
  if (Option.isSome(current)) {
    return normalizeStoredSourceData({
      ...current.value.config,
      etag: null,
      lastSyncAt: null,
    });
  }
  throw new Error("Unsupported OpenAPI local source config.");
};

const decodeExecutableBinding = Schema.decodeUnknownSync(
  OpenApiExecutableBindingSchema,
);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

type OpenApiToolArgs = Record<string, unknown>;
type OpenApiToolParameter =
  OpenApiExecutableBinding["invocation"]["parameters"][number];

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
  payload: OpenApiExecutableBinding["invocation"],
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

    const serialized = serializeOpenApiParameterValue(parameter, parameterValue);
    resolvedPath = resolvedPath.replaceAll(
      `{${parameter.name}}`,
      serialized.kind === "path"
        ? serialized.value
        : encodeURIComponent(String(parameterValue)),
    );
  }

  const unresolved = [...resolvedPath.matchAll(/\{([^{}]+)\}/g)]
    .map((match) => match[1])
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  if (unresolved.length > 0) {
    const names = [...new Set(unresolved)].sort().join(", ");
    throw new Error(`Unresolved path parameters after substitution: ${names}`);
  }

  return resolvedPath;
};

const resolveOpenApiBaseUrl = (input: {
  stored: OpenApiStoredSourceData;
  providerData: OpenApiExecutableBinding;
}): string => {
  if (input.stored.baseUrl && input.stored.baseUrl.trim().length > 0) {
    return new URL(input.stored.baseUrl).toString();
  }

  const server =
    input.providerData.servers?.[0] ?? input.providerData.documentServers?.[0];
  if (server) {
    const expanded = Object.entries(server.variables ?? {}).reduce(
      (url, [name, value]) => url.replaceAll(`{${name}}`, value),
      server.url,
    );
    return new URL(expanded, input.stored.specUrl).toString();
  }

  return new URL("/", input.stored.specUrl).toString();
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
    const pathPart = resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`;

    resolved.pathname = `${basePath}${pathPart}`.replace(/\/{2,}/g, "/");
    resolved.search = "";
    resolved.hash = "";
    return resolved;
  }
};

const responseHeadersRecord = (response: Response): Record<string, string> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
};

const openApiConnectInputFromAddInput = (
  input: OpenApiExecutorAddInput,
): OpenApiConnectInput => ({
  name: input.name,
  specUrl: input.specUrl,
  baseUrl: input.baseUrl,
  auth: input.auth,
});

const decodeResponseBody = async (response: Response): Promise<unknown> => {
  if (response.status === 204) {
    return null;
  }

  const bodyMode = httpBodyModeFromContentType(response.headers.get("content-type"));
  if (bodyMode === "json") {
    return response.json();
  }
  if (bodyMode === "bytes") {
    return new Uint8Array(await response.arrayBuffer());
  }

  return response.text();
};

const resolveBearerToken = (
  stored: OpenApiStoredSourceData,
): Effect.Effect<string | null, Error, SecretMaterialResolverService> => {
  const { auth } = stored;
  if (auth.kind === "none") {
    return Effect.succeed(null);
  }

  return Effect.flatMap(SecretMaterialResolverService, (resolveSecretMaterial) =>
    resolveSecretMaterial({
      ref: auth.tokenSecretRef,
    }).pipe(Effect.map((token) => token.trim()))
  );
};

const resolveBearerHeaderName = (
  auth: Extract<OpenApiStoredSourceData["auth"], { kind: "bearer" }>,
): string => {
  const trimmed = auth.headerName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "Authorization";
};

const resolveBearerPrefix = (
  auth: Extract<OpenApiStoredSourceData["auth"], { kind: "bearer" }>,
): string => auth.prefix ?? "Bearer ";

const openApiDocumentHeaders = (input: {
  stored: OpenApiStoredSourceData;
  bearerToken: string | null;
  etag?: string | null;
}): Headers => {
  const headers = new Headers();

  for (const [key, value] of Object.entries(input.stored.defaultHeaders ?? {})) {
    headers.set(key, value);
  }
  if (
    input.bearerToken &&
    input.bearerToken.length > 0 &&
    input.stored.auth.kind === "bearer"
  ) {
    headers.set(
      resolveBearerHeaderName(input.stored.auth),
      `${resolveBearerPrefix(input.stored.auth)}${input.bearerToken}`,
    );
  }
  if (input.etag) {
    headers.set("if-none-match", input.etag);
  }

  return headers;
};

const requestOpenApiDocument = (input: {
  url: string;
  stored: OpenApiStoredSourceData;
  bearerToken: string | null;
  etag?: string | null;
}): Effect.Effect<Response, Error, never> =>
  Effect.tryPromise({
    try: () =>
      fetch(input.url, {
        headers: openApiDocumentHeaders({
          stored: input.stored,
          bearerToken: input.bearerToken,
          etag: input.etag,
        }),
      }),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  });

const fetchOpenApiDocument = (
  input: {
    stored: OpenApiStoredSourceData;
    bearerToken: string | null;
  },
): Effect.Effect<{
  text: string;
  etag: string | null;
}, Error, never> =>
  Effect.gen(function* () {
    const conditionalResponse = yield* requestOpenApiDocument({
      url: input.stored.specUrl,
      stored: input.stored,
      bearerToken: input.bearerToken,
      etag: input.stored.etag,
    });
    // A 304 has no body. Re-fetch without the ETag so refresh can rebuild the
    // catalog with the current importer even when the upstream document itself
    // has not changed.
    const response =
      conditionalResponse.status === 304
        ? yield* requestOpenApiDocument({
            url: input.stored.specUrl,
            stored: input.stored,
            bearerToken: input.bearerToken,
          })
        : conditionalResponse;

    if (!response.ok) {
      return yield* runtimeEffectError(
        "plugins/openapi/sdk",
        `Failed fetching OpenAPI spec (${response.status} ${response.statusText})`,
      );
    }

    return {
      text: yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      }),
      etag: response.headers.get("etag") ?? conditionalResponse.headers.get("etag"),
    };
  });

export const openApiSdkPlugin = (
  options: OpenApiSdkPluginOptions,
) => defineExecutorSourcePlugin<
  "openapi",
  OpenApiExecutorAddInput,
  OpenApiConnectInput,
  OpenApiSourceConfigPayload,
  OpenApiStoredSourceData,
  OpenApiUpdateSourceInput,
  OpenApiSdk
>({
  key: "openapi",
  source: {
    kind: "openapi",
    displayName: "OpenAPI",
    add: {
      inputSchema: OpenApiExecutorAddInputSchema,
      inputSignatureWidth: 280,
      helpText: [
        "Provide the OpenAPI document URL and optional base URL override.",
        "Use `auth.kind = \"bearer\"` with a stored secret ref when required.",
      ],
      toConnectInput: openApiConnectInputFromAddInput,
    },
    storage: options.storage,
    source: {
      create: (input) => ({
        source: {
          name: input.name.trim(),
          kind: "openapi",
          status: "connected",
          enabled: true,
          namespace: deriveOpenApiNamespace({
            specUrl: input.specUrl,
            title: input.name,
          }),
        },
        stored: createStoredSourceData(input),
      }),
      update: ({ source, config }) => ({
        source: {
          ...source,
          name: config.name.trim(),
          namespace: deriveOpenApiNamespace({
            specUrl: config.specUrl,
            title: config.name,
          }),
        },
        stored: createStoredSourceData(config),
      }),
      toConfig: ({ source, stored }) =>
        configFromStoredSourceData(source, normalizeStoredSourceData(stored)),
    },
    scopeConfig: {
      toConfigSource: ({ source, stored }) =>
        pluginScopeConfigSourceFromConfig({
          source,
          config: {
            specUrl: stored.specUrl,
            baseUrl: stored.baseUrl,
            auth: stored.auth,
            defaultHeaders: stored.defaultHeaders,
          },
        }),
      recoverStored: ({ config, loadedConfig }) =>
        openApiStoredSourceDataFromLocalConfig({
          config,
          loadedConfig,
        }),
    },
    catalog: {
      kind: "imported",
      identity: ({ source }) => ({
        kind: "openapi",
        sourceId: source.id,
      }),
      sync: ({ source, stored }) =>
        Effect.gen(function* () {
          if (stored === null) {
            return yield* runtimeEffectError(
              "plugins/openapi/sdk",
              `OpenAPI source storage missing for ${source.id}`,
            );
          }

          const normalizedStored = normalizeStoredSourceData(stored);
          const bearerToken = yield* resolveBearerToken(normalizedStored);
          const fetched = yield* fetchOpenApiDocument({
            stored: normalizedStored,
            bearerToken,
          });
          const manifest = yield* extractOpenApiManifest(source.name, fetched.text, {
            documentUrl: normalizedStored.specUrl,
            loadDocument: async (url) => {
              const response = await fetch(url, {
                headers: openApiDocumentHeaders({
                  stored: normalizedStored,
                  bearerToken,
                }),
              });
              if (!response.ok) {
                throw new Error(
                  `Failed fetching OpenAPI document ${url} (${response.status} ${response.statusText})`,
                );
              }
              return response.text();
            },
          });
          const definitions = compileOpenApiToolDefinitions(manifest);
          const now = Date.now();

          yield* options.storage.put({
            scopeId: source.scopeId,
            sourceId: source.id,
            value: {
              ...normalizedStored,
              etag: fetched.etag,
              lastSyncAt: now,
            },
          });

          return createSourceCatalogSyncResult({
            fragment: createOpenApiCatalogFragment({
              source,
              documents: [
                {
                  documentKind: "openapi",
                  documentKey: normalizedStored.specUrl,
                  contentText: fetched.text,
                  fetchedAt: now,
                },
              ],
              operations: definitions.map(openApiCatalogOperationFromDefinition),
            }),
            importMetadata: {
              ...createCatalogImportMetadata({
                source,
                pluginKey: "openapi",
              }),
              importerVersion: "ir.v1.openapi",
              sourceConfigHash: stableSourceHash(normalizedStored),
            },
            sourceHash: manifest.sourceHash,
          });
        }),
      invoke: (input) =>
        Effect.gen(function* () {
          if (input.stored === null) {
            return yield* runtimeEffectError(
              "plugins/openapi/sdk",
              `OpenAPI source storage missing for ${input.source.id}`,
            );
          }

          const normalizedStored = normalizeStoredSourceData(input.stored);
          const providerData = decodeExecutableBinding(
            input.executable.binding,
          ) as OpenApiExecutableBinding;
          const args = asRecord(input.args);
          const resolvedPath = replacePathTemplate(
            providerData.invocation.pathTemplate,
            args,
            providerData.invocation,
          );
          const headers: Record<string, string> = {
            ...normalizedStored.defaultHeaders,
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
                body: bodyValue,
              });
              headers["content-type"] = serializedBody.contentType;
              body = serializedBody.body;
            }
          }

          const bearerToken = yield* resolveBearerToken(normalizedStored);
          if (
            bearerToken &&
            bearerToken.length > 0 &&
            normalizedStored.auth.kind === "bearer"
          ) {
            headers[resolveBearerHeaderName(normalizedStored.auth)] =
              `${resolveBearerPrefix(normalizedStored.auth)}${bearerToken}`;
          }

          const requestUrl = resolveRequestUrl(
            resolveOpenApiBaseUrl({
              stored: normalizedStored,
              providerData,
            }),
            resolvedPath,
          );
          const finalUrl = withSerializedQueryEntries(requestUrl, queryEntries);

          const requestHeaders = new Headers(headers);
          if (cookieParts.length > 0) {
            const existingCookie = requestHeaders.get("cookie");
            requestHeaders.set(
              "cookie",
              existingCookie
                ? `${existingCookie}; ${cookieParts.join("; ")}`
                : cookieParts.join("; "),
            );
          }

          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(finalUrl.toString(), {
                method: providerData.invocation.method.toUpperCase(),
                headers: requestHeaders,
                ...(body !== undefined
                  ? {
                      body:
                        typeof body === "string"
                          ? body
                          : new Uint8Array(body).buffer,
                    }
                  : {}),
              }),
            catch: (cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
          });
          const responseBody = yield* Effect.tryPromise({
            try: () => decodeResponseBody(response),
            catch: (cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
          });

          return {
            data: response.ok ? responseBody : null,
            error: response.ok ? null : responseBody,
            headers: responseHeadersRecord(response),
            status: response.status,
          };
        }),
    },
  },
  tools: [
    {
      name: "previewDocument",
      description: "Preview an OpenAPI document before creating a source.",
      inputSchema: OpenApiPreviewRequestSchema,
      outputSchema: OpenApiPreviewResponseSchema,
      execute: ({ args }) =>
        Effect.tryPromise({
          try: () => previewOpenApiDocument(args),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
        }),
    },
    {
      name: "getSourceConfig",
      description: "Load the saved configuration for an OpenAPI source.",
      inputSchema: OpenApiSourceIdInputSchema,
      outputSchema: OpenApiSourceConfigPayloadSchema,
      execute: ({ args, source }) => source.getSourceConfig(args.sourceId),
    },
    {
      name: "createSource",
      description: "Create an OpenAPI source.",
      inputSchema: OpenApiConnectInputSchema,
      outputSchema: SourceSchema,
      execute: ({ args, source }) => source.createSource(args),
    },
    {
      name: "updateSource",
      description: "Update an OpenAPI source configuration.",
      inputSchema: OpenApiUpdateSourceInputSchema,
      outputSchema: SourceSchema,
      execute: ({ args, source }) => source.updateSource(args),
    },
    {
      name: "refreshSource",
      description: "Refresh an OpenAPI source and resync its catalog.",
      inputSchema: OpenApiSourceIdInputSchema,
      outputSchema: SourceSchema,
      execute: ({ args, source }) => source.refreshSource(args.sourceId),
    },
    {
      name: "removeSource",
      description: "Remove an OpenAPI source and its stored plugin data.",
      inputSchema: OpenApiSourceIdInputSchema,
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
      previewDocument: (input) =>
        Effect.tryPromise({
          try: () => previewOpenApiDocument(input),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
        }),
      getSourceConfig: (sourceId) =>
        provideRuntime(source.getSourceConfig(sourceId)),
      createSource: (input) =>
        provideRuntime(source.createSource(input)),
      updateSource: (input) =>
        provideRuntime(source.updateSource(input)),
      refreshSource: (sourceId) =>
        provideRuntime(source.refreshSource(sourceId)),
      removeSource: (sourceId) =>
        provideRuntime(source.removeSource(sourceId)),
    };
  },
});
