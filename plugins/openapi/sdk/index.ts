import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  createCatalogImportMetadata,
  createSourceCatalogSyncResult,
} from "@executor/source-core";
import type { Source } from "@executor/platform-sdk/schema";
import type {
  ExecutorSdkPlugin,
  ExecutorSdkPluginHost,
  ExecutorSourceConnector,
  SourcePluginRuntime,
} from "@executor/platform-sdk/plugins";
import {
  OpenApiConnectionAuthSchema,
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
  OpenApiToolProviderDataSchema,
  type OpenApiToolProviderData,
} from "./types";

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

export type OpenApiSecrets = {
  resolve: (input: {
    ref: string;
  }) => Effect.Effect<string, Error, never>;
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
  secrets?: OpenApiSecrets;
};

const OpenApiExecutorAddInputSchema = Schema.Struct({
  kind: Schema.Literal("openapi"),
  name: Schema.String,
  specUrl: Schema.String,
  baseUrl: Schema.NullOr(Schema.String),
  auth: OpenApiConnectionAuthSchema,
});

type OpenApiExecutorAddInput = typeof OpenApiExecutorAddInputSchema.Type;

const createStoredSourceData = (
  input: OpenApiConnectInput,
): OpenApiStoredSourceData => ({
  specUrl: input.specUrl.trim(),
  baseUrl: input.baseUrl?.trim() || null,
  auth: input.auth,
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

const decodeProviderData = Schema.decodeUnknownSync(OpenApiToolProviderDataSchema);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

type OpenApiToolArgs = Record<string, unknown>;
type OpenApiToolParameter = OpenApiToolProviderData["invocation"]["parameters"][number];

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
  providerData: OpenApiToolProviderData;
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

const createOpenApiSourceSdk = (
  options: OpenApiSdkPluginOptions,
  host: ExecutorSdkPluginHost,
) => ({
  getSourceConfig: (sourceId: Source["id"]) =>
    Effect.gen(function* () {
      const source = yield* host.sources.get(sourceId);
      if (source.kind !== "openapi") {
        return yield* Effect.fail(
          new Error(`Source ${sourceId} is not an OpenAPI source.`),
        );
      }

      const stored = yield* options.storage.get({
        scopeId: source.scopeId,
        sourceId: source.id,
      });
      if (stored === null) {
        return yield* Effect.fail(
          new Error(`OpenAPI source storage missing for ${source.id}`),
        );
      }

      return configFromStoredSourceData(source, stored);
    }),
  createSource: (input: OpenApiConnectInput) =>
    Effect.gen(function* () {
      const stored = createStoredSourceData(input);
      const createdSource = yield* host.sources.create({
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
      });

      yield* options.storage.put({
        scopeId: createdSource.scopeId,
        sourceId: createdSource.id,
        value: stored,
      });

      return yield* host.sources.refreshCatalog(createdSource.id);
    }),
  updateSource: (input: OpenApiUpdateSourceInput) =>
    Effect.gen(function* () {
      const source = yield* host.sources.get(input.sourceId as Source["id"]);
      if (source.kind !== "openapi") {
        return yield* Effect.fail(
          new Error(`Source ${input.sourceId} is not an OpenAPI source.`),
        );
      }

      const nextStored = createStoredSourceData(input.config);
      const savedSource = yield* host.sources.save({
        ...source,
        name: input.config.name.trim(),
        namespace: deriveOpenApiNamespace({
          specUrl: input.config.specUrl,
          title: input.config.name,
        }),
      });

      yield* options.storage.put({
        scopeId: savedSource.scopeId,
        sourceId: savedSource.id,
        value: nextStored,
      });

      return yield* host.sources.refreshCatalog(savedSource.id);
    }),
  refreshSource: (sourceId: Source["id"]) =>
    Effect.gen(function* () {
      const source = yield* host.sources.get(sourceId);
      if (source.kind !== "openapi") {
        return yield* Effect.fail(
          new Error(`Source ${sourceId} is not an OpenAPI source.`),
        );
      }

      const stored = yield* options.storage.get({
        scopeId: source.scopeId,
        sourceId: source.id,
      });
      if (stored === null) {
        return yield* Effect.fail(
          new Error(`OpenAPI source storage missing for ${source.id}`),
        );
      }

      return yield* host.sources.refreshCatalog(source.id);
    }),
  removeSource: (sourceId: Source["id"]) =>
    Effect.gen(function* () {
      const source = yield* host.sources.get(sourceId);
      if (source.kind !== "openapi") {
        return yield* Effect.fail(
          new Error(`Source ${sourceId} is not an OpenAPI source.`),
        );
      }

      if (options.storage.remove) {
        yield* options.storage.remove({
          scopeId: source.scopeId,
          sourceId: source.id,
        });
      }

      return yield* host.sources.remove(source.id);
    }),
});

const openApiSourceConnector = (
  options: OpenApiSdkPluginOptions,
): ExecutorSourceConnector<OpenApiExecutorAddInput> => ({
  kind: "openapi",
  displayName: "OpenAPI",
  inputSchema: OpenApiExecutorAddInputSchema,
  inputSignatureWidth: 280,
  helpText: [
    "Provide the OpenAPI document URL and optional base URL override.",
    "Use `auth.kind = \"bearer\"` with a stored secret ref when required.",
  ],
  createSource: ({ args, host }) =>
    createOpenApiSourceSdk(options, host).createSource(args),
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
  options: OpenApiSdkPluginOptions,
  stored: OpenApiStoredSourceData,
): Effect.Effect<string | null, Error, never> => {
  if (stored.auth.kind === "none") {
    return Effect.succeed(null);
  }

  if (!options.secrets) {
    return Effect.fail(
      new Error("OpenAPI bearer auth is configured, but no secret resolver is available."),
    );
  }

  return options.secrets.resolve({
    ref: stored.auth.tokenSecretRef,
  }).pipe(Effect.map((token) => token.trim()));
};

const openApiDocumentHeaders = (input: {
  stored: OpenApiStoredSourceData;
  bearerToken: string | null;
  etag?: string | null;
}): Headers => {
  const headers = new Headers();

  for (const [key, value] of Object.entries(input.stored.defaultHeaders ?? {})) {
    headers.set(key, value);
  }
  if (input.bearerToken && input.bearerToken.length > 0) {
    headers.set("authorization", `Bearer ${input.bearerToken}`);
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
      return yield* Effect.fail(
        new Error(
          `Failed fetching OpenAPI spec (${response.status} ${response.statusText})`,
        ),
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

const createOpenApiSourceRuntime = (
  options: OpenApiSdkPluginOptions,
): SourcePluginRuntime => ({
  kind: "openapi",
  displayName: "OpenAPI",
  catalogKind: "imported",
  catalogIdentity: ({ source }) => ({
    kind: "openapi",
    sourceId: source.id,
  }),
  getIrModel: ({ source }) =>
    Effect.gen(function* () {
      const stored = yield* options.storage.get({
        scopeId: source.scopeId,
        sourceId: source.id,
      });
      if (stored === null) {
        return createSourceCatalogSyncResult({
          fragment: {
            version: "ir.v1.fragment",
          },
          importMetadata: {
            ...createCatalogImportMetadata({
              source,
              pluginKey: "openapi",
            }),
            importerVersion: "ir.v1.openapi",
            sourceConfigHash: "missing",
          },
          sourceHash: null,
        });
      }

      const bearerToken = yield* resolveBearerToken(options, stored);
      const fetched = yield* fetchOpenApiDocument({
        stored,
        bearerToken,
      });
      const manifest = yield* extractOpenApiManifest(source.name, fetched.text, {
        documentUrl: stored.specUrl,
        loadDocument: async (url) => {
          const response = await fetch(url, {
            headers: openApiDocumentHeaders({
              stored,
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
          ...stored,
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
              documentKey: stored.specUrl,
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
          sourceConfigHash: stableSourceHash(stored),
        },
        sourceHash: manifest.sourceHash,
      });
    }),
  invoke: (input) =>
    Effect.gen(function* () {
      const stored = yield* options.storage.get({
        scopeId: input.source.scopeId,
        sourceId: input.source.id,
      });
      if (stored === null) {
        return yield* Effect.fail(
          new Error(`OpenAPI source storage missing for ${input.source.id}`),
        );
      }

      const providerData = decodeProviderData(
        input.executable.binding,
      ) as OpenApiToolProviderData;
      const args = asRecord(input.args);
      const resolvedPath = replacePathTemplate(
        providerData.invocation.pathTemplate,
        args,
        providerData.invocation,
      );
      const headers: Record<string, string> = {
        ...(stored.defaultHeaders ?? {}),
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

      const bearerToken = yield* resolveBearerToken(options, stored);
      if (bearerToken && bearerToken.length > 0) {
        headers.authorization = `Bearer ${bearerToken}`;
      }

      const requestUrl = resolveRequestUrl(
        resolveOpenApiBaseUrl({
          stored,
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
            method: providerData.method.toUpperCase(),
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
});

export const openApiSdkPlugin = (
  options: OpenApiSdkPluginOptions,
): ExecutorSdkPlugin<"openapi", OpenApiSdk> => ({
  key: "openapi",
  sources: [createOpenApiSourceRuntime(options)],
  sourceConnectors: [openApiSourceConnector(options)],
  extendExecutor: ({ host, executor }) => {
    const sourceSdk = createOpenApiSourceSdk(options, host);
    const provideRuntime = <A>(
      effect: Effect.Effect<A, Error, any>,
    ): Effect.Effect<A, Error, never> =>
      effect.pipe(Effect.provide(executor.runtime.managedRuntime));

    return {
    previewDocument: (input) =>
      Effect.tryPromise({
        try: () => previewOpenApiDocument(input),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      }),
      getSourceConfig: (sourceId) =>
        provideRuntime(sourceSdk.getSourceConfig(sourceId)),
      createSource: (input) =>
        provideRuntime(sourceSdk.createSource(input)),
      updateSource: (input) =>
        provideRuntime(sourceSdk.updateSource(input)),
      refreshSource: (sourceId) =>
        provideRuntime(sourceSdk.refreshSource(sourceId)),
      removeSource: (sourceId) =>
        provideRuntime(sourceSdk.removeSource(sourceId)),
    };
  },
});
