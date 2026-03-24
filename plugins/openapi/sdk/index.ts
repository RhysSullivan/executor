import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import {
  buildOAuth2AuthorizationUrl,
  createPkceCodeVerifier,
  exchangeOAuth2AuthorizationCode,
  refreshOAuth2AccessToken,
} from "@executor/auth-oauth2";
import {
  createCatalogImportMetadata,
  createSourceCatalogSyncResult,
} from "@executor/source-core";
import {
  SecretMaterialIdSchema,
  type SecretRef,
  type Source,
} from "@executor/platform-sdk/schema";
import type {
  ExecutorSdkPlugin,
  ExecutorSdkPluginHost,
  ExecutorSourceConnector,
  SourcePluginRuntime,
} from "@executor/platform-sdk/plugins";
import {
  ExecutorStateStore,
  SecretMaterialResolverService,
  SecretMaterialStorerService,
  SecretMaterialUpdaterService,
  provideExecutorRuntime,
} from "@executor/platform-sdk/runtime";
import {
  OpenApiConnectionAuthSchema,
  OpenApiOAuthSessionSchema,
  deriveOpenApiNamespace,
  previewOpenApiDocument,
  type OpenApiConnectInput,
  type OpenApiOAuthPopupResult,
  type OpenApiOAuthSession,
  type OpenApiPreviewRequest,
  type OpenApiPreviewResponse,
  type OpenApiSourceConfigPayload,
  type OpenApiStartOAuthInput,
  type OpenApiStartOAuthResult,
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
  type OpenApiSecurityRequirement,
  OpenApiToolProviderDataSchema,
  type OpenApiToolProviderData,
} from "./types";

const OAUTH_REFRESH_SKEW_MS = 60_000;

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

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

export type OpenApiOAuthSessionStorage = {
  get: (sessionId: string) => Effect.Effect<OpenApiOAuthSession | null, Error, never>;
  put: (input: {
    sessionId: string;
    value: OpenApiOAuthSession;
  }) => Effect.Effect<void, Error, never>;
  remove?: (sessionId: string) => Effect.Effect<void, Error, never>;
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
  removeSource: (
    sourceId: Source["id"],
  ) => Effect.Effect<boolean, Error, never>;
  startOAuth: (
    input: OpenApiStartOAuthInput,
  ) => Effect.Effect<OpenApiStartOAuthResult, Error, never>;
  completeOAuth: (input: {
    state: string;
    code?: string;
    error?: string;
    errorDescription?: string;
  }) => Effect.Effect<Extract<OpenApiOAuthPopupResult, { ok: true }>, Error, never>;
};

export type OpenApiSdkPluginOptions = {
  storage: OpenApiSourceStorage;
  oauthSessions: OpenApiOAuthSessionStorage;
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
const decodeSession = Schema.decodeUnknownSync(OpenApiOAuthSessionSchema);

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

const headersRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
};

const secretRefFromSecretId = (secretId: string): Effect.Effect<SecretRef, Error, any> =>
  Effect.gen(function* () {
    const store = yield* ExecutorStateStore;
    const material = yield* store.secretMaterials.getById(
      SecretMaterialIdSchema.make(secretId),
    );
    if (Option.isNone(material)) {
      return yield* Effect.fail(new Error(`Secret not found: ${secretId}`));
    }

    return {
      providerId: material.value.providerId,
      handle: material.value.id,
    } satisfies SecretRef;
  });

const resolveSecretValueById = (secretId: string): Effect.Effect<string, Error, any> =>
  Effect.gen(function* () {
    const ref = yield* secretRefFromSecretId(secretId);
    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const value = yield* resolveSecretMaterial({
      ref,
    });
    return value.trim();
  });

const storeSecretValue = (input: {
  purpose: "oauth_access_token" | "oauth_refresh_token";
  value: string;
  name: string;
  expiresAt?: number | null;
}): Effect.Effect<string, Error, any> =>
  Effect.gen(function* () {
    const storeSecretMaterial = yield* SecretMaterialStorerService;
    const ref = yield* storeSecretMaterial({
      purpose: input.purpose,
      value: input.value,
      name: input.name,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    });
    return ref.handle;
  });

const updateSecretValueById = (input: {
  secretId: string;
  value: string;
  expiresAt?: number | null;
}): Effect.Effect<void, Error, any> =>
  Effect.gen(function* () {
    const ref = yield* secretRefFromSecretId(input.secretId);
    const updateSecretMaterial = yield* SecretMaterialUpdaterService;
    yield* updateSecretMaterial({
      ref,
      value: input.value,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    });
  });

const expiresAtFromExpiresIn = (expiresIn: number | undefined): number | null =>
  typeof expiresIn === "number" && Number.isFinite(expiresIn)
    ? Date.now() + Math.max(0, expiresIn) * 1000
    : null;

const mergeRequiredScopes = (
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): Set<string> => new Set([...left, ...right]);

const requiredScopesForConfiguredScheme = (input: {
  authRequirement?: OpenApiSecurityRequirement;
  schemeName: string;
}): {
  matched: boolean;
  scopes: ReadonlySet<string>;
} => {
  const requirement = input.authRequirement;
  if (!requirement || requirement.kind === "none") {
    return {
      matched: true,
      scopes: new Set(),
    };
  }

  switch (requirement.kind) {
    case "scheme":
      return requirement.schemeName === input.schemeName
        ? {
            matched: true,
            scopes: new Set(requirement.scopes ?? []),
          }
        : {
            matched: false,
            scopes: new Set(),
          };
    case "anyOf": {
      for (const item of requirement.items) {
        const matched = requiredScopesForConfiguredScheme({
          authRequirement: item,
          schemeName: input.schemeName,
        });
        if (matched.matched) {
          return matched;
        }
      }
      return {
        matched: false,
        scopes: new Set(),
      };
    }
    case "allOf": {
      let scopes = new Set<string>();
      for (const item of requirement.items) {
        const matched = requiredScopesForConfiguredScheme({
          authRequirement: item,
          schemeName: input.schemeName,
        });
        if (!matched.matched) {
          return {
            matched: false,
            scopes: new Set(),
          };
        }
        scopes = mergeRequiredScopes(scopes, matched.scopes);
      }
      return {
        matched: true,
        scopes,
      };
    }
  }
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
    "Use `auth.kind = \"bearer\"` or `auth.kind = \"oauth2\"` when required.",
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
  stored: OpenApiStoredSourceData,
): Effect.Effect<string | null, Error, any> => {
  if (stored.auth.kind === "none") {
    return Effect.succeed(null);
  }

  if (stored.auth.kind !== "bearer") {
    return Effect.succeed(null);
  }

  return resolveSecretValueById(stored.auth.tokenSecretRef);
};

const resolveOauthAccessToken = (input: {
  scopeId: string;
  sourceId: string;
  auth: Extract<OpenApiStoredSourceData["auth"], { kind: "oauth2" }>;
  storage: OpenApiSourceStorage;
}): Effect.Effect<string, Error, any> =>
  Effect.gen(function* () {
    const now = Date.now();
    const needsRefresh =
      input.auth.refreshTokenRef !== null
      && input.auth.expiresAt !== null
      && input.auth.expiresAt <= now + OAUTH_REFRESH_SKEW_MS;
    if (!needsRefresh) {
      return yield* resolveSecretValueById(input.auth.accessTokenRef);
    }

    const refreshToken = yield* resolveSecretValueById(input.auth.refreshTokenRef!);
    const clientSecret = input.auth.clientSecretRef
      ? yield* resolveSecretValueById(input.auth.clientSecretRef)
      : null;
    const tokenResponse = yield* refreshOAuth2AccessToken({
      tokenEndpoint: input.auth.tokenEndpoint,
      clientId: input.auth.clientId,
      clientAuthentication: input.auth.clientAuthentication,
      clientSecret,
      refreshToken,
      scopes: input.auth.scopes,
    });
    const accessTokenExpiresAt = expiresAtFromExpiresIn(tokenResponse.expires_in);

    yield* updateSecretValueById({
      secretId: input.auth.accessTokenRef,
      value: tokenResponse.access_token,
      expiresAt: accessTokenExpiresAt,
    });

    let refreshTokenRef = input.auth.refreshTokenRef;
    if (tokenResponse.refresh_token) {
      if (refreshTokenRef) {
        yield* updateSecretValueById({
          secretId: refreshTokenRef,
          value: tokenResponse.refresh_token,
          expiresAt: null,
        });
      } else {
        refreshTokenRef = yield* storeSecretValue({
          purpose: "oauth_refresh_token",
          value: tokenResponse.refresh_token,
          name: `${input.sourceId} OpenAPI Refresh Token`,
          expiresAt: null,
        });
      }
    }

    const stored = yield* input.storage.get({
      scopeId: input.scopeId,
      sourceId: input.sourceId,
    });
    if (stored?.auth.kind === "oauth2") {
      yield* input.storage.put({
        scopeId: input.scopeId,
        sourceId: input.sourceId,
        value: {
          ...stored,
          auth: {
            ...stored.auth,
            refreshTokenRef,
            expiresAt: accessTokenExpiresAt,
          },
        },
      });
    }

    return tokenResponse.access_token;
  }).pipe(Effect.mapError(toError));

const resolveOpenApiAuthHeaders = (input: {
  scopeId: string;
  sourceId: string;
  stored: OpenApiStoredSourceData;
  providerData?: OpenApiToolProviderData;
  storage: OpenApiSourceStorage;
}): Effect.Effect<Record<string, string>, Error, any> =>
  Effect.gen(function* () {
    const headers = new Headers();

    for (const [key, value] of Object.entries(input.stored.defaultHeaders ?? {})) {
      headers.set(key, value);
    }

    if (input.providerData && input.stored.auth.kind === "oauth2") {
      const required = requiredScopesForConfiguredScheme({
        authRequirement: input.providerData.authRequirement,
        schemeName: input.stored.auth.schemeName,
      });
      if (!required.matched) {
        return yield* Effect.fail(
          new Error(
            `Configured OAuth scheme '${input.stored.auth.schemeName}' does not satisfy this OpenAPI operation.`,
          ),
        );
      }

      const configuredScopes = new Set(input.stored.auth.scopes);
      const missingScopes = [...required.scopes].filter(
        (scope) => !configuredScopes.has(scope),
      );
      if (missingScopes.length > 0) {
        return yield* Effect.fail(
          new Error(
            `Configured OAuth scopes are missing required scopes: ${missingScopes.sort().join(", ")}`,
          ),
        );
      }
    }

    if (input.stored.auth.kind === "bearer") {
      const bearerToken = yield* resolveBearerToken(input.stored);
      if (bearerToken && bearerToken.length > 0) {
        headers.set("authorization", `Bearer ${bearerToken}`);
      }
    }

    if (input.stored.auth.kind === "oauth2") {
      const token = yield* resolveOauthAccessToken({
        scopeId: input.scopeId,
        sourceId: input.sourceId,
        auth: input.stored.auth,
        storage: input.storage,
      });
      headers.set("authorization", `Bearer ${token.trim()}`);
    }

    return headersRecord(headers);
  }).pipe(Effect.mapError(toError));

const fetchOpenApiDocument = (
  options: OpenApiSdkPluginOptions,
  input: {
    scopeId: string;
    sourceId: string;
    stored: OpenApiStoredSourceData;
  },
): Effect.Effect<{
  text: string;
  etag: string | null;
}, Error, any> =>
  Effect.gen(function* () {
    const authenticatedHeaders = new Headers(
      yield* resolveOpenApiAuthHeaders({
        scopeId: input.scopeId,
        sourceId: input.sourceId,
        stored: input.stored,
        storage: options.storage,
      }),
    );
    if (input.stored.etag) {
      authenticatedHeaders.set("if-none-match", input.stored.etag);
    }

    const fetchWithHeaders = (headers: Headers) =>
      Effect.tryPromise({
        try: () =>
          fetch(input.stored.specUrl, {
            headers,
          }),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      });

    let response = yield* fetchWithHeaders(authenticatedHeaders);
    const usedAuthorizationHeader = authenticatedHeaders.has("authorization");

    // Some providers publish a public spec endpoint but reject OAuth bearer tokens.
    // If the authenticated fetch is denied, retry once without the auth header.
    if (
      usedAuthorizationHeader
      && (response.status === 401 || response.status === 403)
    ) {
      const fallbackHeaders = new Headers();
      if (input.stored.etag) {
        fallbackHeaders.set("if-none-match", input.stored.etag);
      }
      response = yield* fetchWithHeaders(fallbackHeaders);
    }

    if (!response.ok) {
      throw new Error(
        `Failed fetching OpenAPI spec (${response.status} ${response.statusText})`,
      );
    }

    return {
      text: yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      }),
      etag: response.headers.get("etag"),
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

      const fetched = yield* fetchOpenApiDocument(options, {
        scopeId: source.scopeId,
        sourceId: source.id,
        stored,
      });
      const manifest = yield* extractOpenApiManifest(source.name, fetched.text);
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
      const headers = yield* resolveOpenApiAuthHeaders({
        scopeId: input.source.scopeId,
        sourceId: input.source.id,
        stored,
        providerData,
        storage: options.storage,
      });
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
      provideExecutorRuntime(effect, executor.runtime);

    return {
      previewDocument: (input) =>
        Effect.tryPromise({
          try: () => previewOpenApiDocument(input),
          catch: toError,
        }),
      getSourceConfig: (sourceId) =>
        provideRuntime(sourceSdk.getSourceConfig(sourceId)),
      createSource: (input) =>
        provideRuntime(sourceSdk.createSource(input)),
      updateSource: (input) =>
        provideRuntime(sourceSdk.updateSource(input)),
      removeSource: (sourceId) =>
        provideRuntime(sourceSdk.removeSource(sourceId)),
      startOAuth: (input) =>
        provideRuntime(
          Effect.gen(function* () {
            const sessionId = `openapi_oauth_${crypto.randomUUID()}`;
            const codeVerifier = createPkceCodeVerifier();
            const clientAuthentication =
              input.clientSecretRef !== null ? "client_secret_basic" : "none";

            yield* options.oauthSessions.put({
              sessionId,
              value: decodeSession({
                schemeName: input.schemeName.trim(),
                flow: "authorizationCode",
                authorizationEndpoint: input.authorizationEndpoint.trim(),
                tokenEndpoint: input.tokenEndpoint.trim(),
                scopes: [...new Set(input.scopes.map((scope) => scope.trim()).filter(Boolean))],
                clientId: input.clientId.trim(),
                clientSecretRef: input.clientSecretRef?.trim() || null,
                clientAuthentication,
                redirectUrl: input.redirectUrl,
                codeVerifier,
              }),
            });

            const session = yield* options.oauthSessions.get(sessionId);
            if (session === null) {
              return yield* Effect.fail(
                new Error(`OpenAPI OAuth session not found after creation: ${sessionId}`),
              );
            }

            return {
              sessionId,
              authorizationUrl: buildOAuth2AuthorizationUrl({
                authorizationEndpoint: session.authorizationEndpoint,
                clientId: session.clientId,
                redirectUri: session.redirectUrl,
                scopes: session.scopes,
                state: sessionId,
                codeVerifier: session.codeVerifier,
              }),
              scopes: [...session.scopes],
            };
          }).pipe(Effect.mapError(toError)),
        ),
      completeOAuth: (input) =>
        provideRuntime(
          Effect.gen(function* () {
            if (input.error) {
              return yield* Effect.fail(
                new Error(input.errorDescription || input.error || "OpenAPI OAuth failed"),
              );
            }
            if (!input.code) {
              return yield* Effect.fail(new Error("Missing OpenAPI OAuth code."));
            }

            const session = yield* options.oauthSessions.get(input.state);
            if (session === null) {
              return yield* Effect.fail(
                new Error(`OpenAPI OAuth session not found: ${input.state}`),
              );
            }

            const clientSecret = session.clientSecretRef
              ? yield* resolveSecretValueById(session.clientSecretRef)
              : null;
            const tokenResponse = yield* exchangeOAuth2AuthorizationCode({
              tokenEndpoint: session.tokenEndpoint,
              clientId: session.clientId,
              clientAuthentication: session.clientAuthentication,
              clientSecret,
              redirectUri: session.redirectUrl,
              codeVerifier: session.codeVerifier,
              code: input.code,
            });
            if (!tokenResponse.refresh_token) {
              return yield* Effect.fail(
                new Error(
                  "OpenAPI OAuth did not return a refresh token. This connection requires renewable OAuth credentials.",
                ),
              );
            }

            const accessTokenExpiresAt = expiresAtFromExpiresIn(tokenResponse.expires_in);
            const accessTokenRef = yield* storeSecretValue({
              purpose: "oauth_access_token",
              value: tokenResponse.access_token,
              name: `${session.schemeName} OpenAPI Access Token`,
              expiresAt: accessTokenExpiresAt,
            });
            const refreshTokenRef = yield* storeSecretValue({
              purpose: "oauth_refresh_token",
              value: tokenResponse.refresh_token,
              name: `${session.schemeName} OpenAPI Refresh Token`,
              expiresAt: null,
            });

            if (options.oauthSessions.remove) {
              yield* options.oauthSessions.remove(input.state);
            }

            return {
              type: "executor:oauth-result" as const,
              ok: true as const,
              sessionId: input.state,
              auth: {
                kind: "oauth2" as const,
                schemeName: session.schemeName,
                flow: "authorizationCode" as const,
                authorizationEndpoint: session.authorizationEndpoint,
                tokenEndpoint: session.tokenEndpoint,
                scopes: [...session.scopes],
                clientId: session.clientId,
                clientSecretRef: session.clientSecretRef,
                clientAuthentication: session.clientAuthentication,
                accessTokenRef,
                refreshTokenRef,
                expiresAt: accessTokenExpiresAt,
              },
            };
          }).pipe(Effect.mapError(toError)),
        ),
    };
  },
});
