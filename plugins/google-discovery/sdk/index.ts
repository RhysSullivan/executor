import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  createCatalogImportMetadata,
  createSourceCatalogSyncResult,
} from "@executor/source-core";
import type {
  LocalExecutorConfig,
  Source,
} from "@executor/platform-sdk/schema";
import {
  SourceSchema,
} from "@executor/platform-sdk/schema";
import {
  defineExecutorSourcePlugin,
} from "@executor/platform-sdk/plugins";
import {
  createPluginLocalConfigEntrySchema,
  decodeCurrentOrLegacyLocalConfigAuth,
  pluginLocalConfigSourceFromConfig,
  SecretMaterialDeleterService,
  SecretMaterialResolverService,
  SecretMaterialStorerService,
  SecretMaterialUpdaterService,
  provideExecutorRuntime,
  runtimeEffectError,
} from "@executor/platform-sdk/runtime";
import {
  GOOGLE_DISCOVERY_EXECUTOR_KEY,
  GOOGLE_DISCOVERY_SOURCE_KIND,
  GoogleDiscoveryBatchSourceInputSchema,
  GoogleDiscoveryConnectInputSchema,
  GoogleDiscoveryConnectionAuthSchema,
  GoogleDiscoveryOAuthPopupResultSchema,
  GoogleDiscoveryOAuthSessionSchema,
  GoogleDiscoverySourceConfigPayloadSchema,
  GoogleDiscoveryStartBatchOAuthInputSchema,
  GoogleDiscoveryStartOAuthInputSchema,
  GoogleDiscoveryStartOAuthResultSchema,
  defaultGoogleDiscoveryUrl,
  deriveGoogleDiscoveryNamespace,
  GoogleDiscoveryStoredSourceDataSchema,
  GoogleDiscoveryUpdateSourceInputSchema,
  type GoogleDiscoveryBatchSourceInput,
  type GoogleDiscoveryConnectInput,
  type GoogleDiscoveryConnectionAuth,
  type GoogleDiscoveryOAuthPopupResult,
  type GoogleDiscoveryOAuthSession,
  type GoogleDiscoverySourceConfigPayload,
  type GoogleDiscoveryStartBatchOAuthInput,
  type GoogleDiscoveryStartOAuthInput,
  type GoogleDiscoveryStartOAuthResult,
  type GoogleDiscoveryStoredSourceData,
  type GoogleDiscoveryUpdateSourceInput,
} from "@executor/plugin-google-discovery-shared";

import {
  createGoogleDiscoveryCatalogFragment,
  type GoogleDiscoveryCatalogOperationInput,
} from "./catalog";
import {
  compileGoogleDiscoveryToolDefinitions,
  extractGoogleDiscoveryManifest,
} from "./document";
import {
  buildGoogleDiscoveryToolPresentation,
} from "./tools";
import {
  GoogleDiscoveryToolProviderDataSchema,
  type GoogleDiscoveryToolManifest,
  type GoogleDiscoveryToolProviderData,
} from "./types";
import {
  buildOAuth2AuthorizationUrl,
  createPkceCodeVerifier,
  exchangeOAuth2AuthorizationCode,
  refreshOAuth2AccessToken,
} from "./oauth2";

const GoogleDiscoverySourceIdInputSchema = Schema.Struct({
  sourceId: Schema.String,
});
const GoogleDiscoveryCompleteOAuthInputSchema = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  errorDescription: Schema.optional(Schema.String),
});

const decodeStoredSourceData = Schema.decodeUnknownSync(
  GoogleDiscoveryStoredSourceDataSchema,
);
const decodeBatchSourceInput = Schema.decodeUnknownSync(
  GoogleDiscoveryBatchSourceInputSchema,
);
const decodeSession = Schema.decodeUnknownSync(GoogleDiscoveryOAuthSessionSchema);
const decodeProviderData = Schema.decodeUnknownSync(GoogleDiscoveryToolProviderDataSchema);
const decodeGoogleDiscoveryCurrentLocalConfigOption = Schema.decodeUnknownOption(
  createPluginLocalConfigEntrySchema({
    kind: GOOGLE_DISCOVERY_SOURCE_KIND,
    config: GoogleDiscoveryStoredSourceDataSchema,
  }),
);
const decodeGoogleDiscoveryLegacyLocalConfigOption = Schema.decodeUnknownOption(
  Schema.Struct({
    kind: Schema.Literal(GOOGLE_DISCOVERY_SOURCE_KIND),
    name: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    enabled: Schema.optional(Schema.Boolean),
    connection: Schema.Struct({
      endpoint: Schema.optional(Schema.NullOr(Schema.String)),
      auth: Schema.optional(Schema.Unknown),
    }),
    binding: Schema.Struct({
      service: Schema.String,
      version: Schema.String,
      discoveryUrl: Schema.optional(Schema.NullOr(Schema.String)),
      defaultHeaders: Schema.optional(
        Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.String })),
      ),
      scopes: Schema.optional(Schema.Array(Schema.String)),
    }),
    config: Schema.optional(Schema.Unknown),
  }),
);

export type GoogleDiscoverySourceStorage = {
  get: (input: {
    scopeId: string;
    sourceId: string;
  }) => Effect.Effect<GoogleDiscoveryStoredSourceData | null, Error, never>;
  put: (input: {
    scopeId: string;
    sourceId: string;
    value: GoogleDiscoveryStoredSourceData;
  }) => Effect.Effect<void, Error, never>;
  remove?: (input: {
    scopeId: string;
    sourceId: string;
  }) => Effect.Effect<void, Error, never>;
};

export type GoogleDiscoveryOAuthSessionStorage = {
  get: (sessionId: string) => Effect.Effect<GoogleDiscoveryOAuthSession | null, Error, never>;
  put: (input: {
    sessionId: string;
    value: GoogleDiscoveryOAuthSession;
  }) => Effect.Effect<void, Error, never>;
  remove?: (sessionId: string) => Effect.Effect<void, Error, never>;
};

export type GoogleDiscoverySdk = {
  getSourceConfig: (
    sourceId: Source["id"],
  ) => Effect.Effect<GoogleDiscoverySourceConfigPayload, Error>;
  createSource: (
    input: GoogleDiscoveryConnectInput,
  ) => Effect.Effect<Source, Error>;
  updateSource: (
    input: GoogleDiscoveryUpdateSourceInput,
  ) => Effect.Effect<Source, Error>;
  removeSource: (
    sourceId: Source["id"],
  ) => Effect.Effect<boolean, Error>;
  startOAuth: (
    input: GoogleDiscoveryStartOAuthInput,
  ) => Effect.Effect<GoogleDiscoveryStartOAuthResult, Error>;
  startBatchOAuth: (
    input: GoogleDiscoveryStartBatchOAuthInput,
  ) => Effect.Effect<GoogleDiscoveryStartOAuthResult, Error>;
  completeOAuth: (input: {
    state: string;
    code?: string;
    error?: string;
    errorDescription?: string;
  }) => Effect.Effect<Extract<GoogleDiscoveryOAuthPopupResult, { ok: true }>, Error>;
};

const GoogleDiscoveryExecutorAddInputSchema = Schema.Struct({
  kind: Schema.Literal(GOOGLE_DISCOVERY_SOURCE_KIND),
  name: Schema.String,
  service: Schema.String,
  version: Schema.String,
  discoveryUrl: Schema.NullOr(Schema.String),
  defaultHeaders: Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.String })),
  scopes: Schema.Array(Schema.String),
  auth: GoogleDiscoveryConnectionAuthSchema,
});

type GoogleDiscoveryExecutorAddInput =
  typeof GoogleDiscoveryExecutorAddInputSchema.Type;

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const OAUTH_REFRESH_SKEW_MS = 60_000;

const responseHeadersRecord = (response: Response): Record<string, string> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
};

const decodeResponseBody = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const stringValuesFromParameter = (
  value: unknown,
  repeated: boolean,
): string[] => {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    const normalized = value.flatMap((entry) =>
      entry === undefined || entry === null ? [] : [String(entry)],
    );
    return repeated ? normalized : [normalized.join(",")];
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [String(value)];
  }
  return [JSON.stringify(value)];
};

const replacePathParameters = (input: {
  pathTemplate: string;
  args: Record<string, unknown>;
  parameters: ReadonlyArray<
    GoogleDiscoveryToolProviderData["invocation"]["parameters"][number]
  >;
}): string =>
  input.pathTemplate.replaceAll(/\{([^}]+)\}/g, (_, name: string) => {
    const parameter = input.parameters.find(
      (entry) => entry.location === "path" && entry.name === name,
    );
    const rawValue = input.args[name];
    if ((rawValue === undefined || rawValue === null) && parameter?.required) {
      throw new Error(`Missing required path parameter: ${name}`);
    }

    const values = stringValuesFromParameter(rawValue, false);
    return values.length > 0 ? encodeURIComponent(values[0]!) : "";
  });

const resolveGoogleDiscoveryBaseUrl = (input: {
  providerData: GoogleDiscoveryToolProviderData;
}): string =>
  new URL(
    input.providerData.invocation.servicePath || "",
    input.providerData.invocation.rootUrl,
  ).toString();

const googleDiscoveryCatalogOperationFromDefinition = (input: {
  manifest: Parameters<typeof compileGoogleDiscoveryToolDefinitions>[0];
  definition: ReturnType<typeof compileGoogleDiscoveryToolDefinitions>[number];
}): GoogleDiscoveryCatalogOperationInput => {
  const presentation = buildGoogleDiscoveryToolPresentation({
    manifest: input.manifest,
    definition: input.definition,
  });

  return {
    toolId: input.definition.toolId,
    title: input.definition.name,
    description: input.definition.description,
    effect:
      input.definition.method === "get" || input.definition.method === "head"
        ? "read"
        : input.definition.method === "delete"
          ? "delete"
          : "write",
    inputSchema: presentation.inputSchema,
    outputSchema: presentation.outputSchema,
    providerData: presentation.providerData as GoogleDiscoveryToolProviderData,
  };
};

const computeMaximalScopes = (
  manifest: GoogleDiscoveryToolManifest,
): ReadonlyArray<string> => {
  const topLevelScopes = Object.keys(manifest.oauthScopes ?? {});
  if (topLevelScopes.length === 0) {
    return [];
  }

  const scopeToMethods = new Map<string, Set<string>>();
  for (const scope of topLevelScopes) {
    scopeToMethods.set(scope, new Set());
  }
  for (const method of manifest.methods) {
    for (const scope of method.scopes) {
      scopeToMethods.get(scope)?.add(method.methodId);
    }
  }

  return topLevelScopes.filter((scope) => {
    const methods = scopeToMethods.get(scope);
    if (!methods || methods.size === 0) {
      return true;
    }

    return !topLevelScopes.some((other) => {
      if (other === scope) {
        return false;
      }

      const otherMethods = scopeToMethods.get(other);
      if (!otherMethods || otherMethods.size <= methods.size) {
        return false;
      }

      for (const method of methods) {
        if (!otherMethods.has(method)) {
          return false;
        }
      }

      return true;
    });
  });
};

const fetchGoogleDiscoveryDocumentWithHeaders = (input: {
  url: string;
  headers?: Readonly<Record<string, string>>;
}): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(input.url, {
        headers: input.headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Google Discovery fetch requires credentials (status ${response.status})`,
        );
      }
      if (!response.ok) {
        throw new Error(`Google Discovery fetch failed with status ${response.status}`);
      }
      return response.text();
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  });

const inferScopesFromDiscoveryDocument = (input: {
  service: string;
  document: string;
}): Effect.Effect<ReadonlyArray<string>, Error> =>
  Effect.gen(function* () {
    const manifest = yield* extractGoogleDiscoveryManifest(input.service, input.document);
    return computeMaximalScopes(manifest);
  });

const resolveOauthAccessToken = (input: {
  scopeId: string;
  sourceId: string;
  auth: Extract<GoogleDiscoveryConnectionAuth, { kind: "oauth2" }>;
  storage: GoogleDiscoverySourceStorage;
}): Effect.Effect<string, Error, any> =>
  Effect.gen(function* () {
    const now = Date.now();
    const needsRefresh =
      input.auth.refreshTokenRef !== null &&
      input.auth.expiresAt !== null &&
      input.auth.expiresAt <= now + OAUTH_REFRESH_SKEW_MS;
    if (!needsRefresh) {
      const resolveSecretMaterial = yield* SecretMaterialResolverService;
      return yield* resolveSecretMaterial({
        ref: input.auth.accessTokenRef,
      });
    }

    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const updateSecretMaterial = yield* SecretMaterialUpdaterService;
    const storeSecretMaterial = yield* SecretMaterialStorerService;
    const refreshToken = yield* resolveSecretMaterial({
      ref: input.auth.refreshTokenRef!,
    });
    const clientSecret = input.auth.clientSecretRef
      ? yield* resolveSecretMaterial({
          ref: input.auth.clientSecretRef,
        })
      : null;
    const tokenResponse = yield* refreshOAuth2AccessToken({
      tokenEndpoint: input.auth.tokenEndpoint,
      clientId: input.auth.clientId,
      clientAuthentication: input.auth.clientAuthentication,
      clientSecret,
      refreshToken,
      scopes: input.auth.scopes,
    });

    yield* updateSecretMaterial({
      ref: input.auth.accessTokenRef,
      value: tokenResponse.access_token,
    });

    let refreshTokenRef = input.auth.refreshTokenRef;
    if (tokenResponse.refresh_token) {
      if (refreshTokenRef) {
        yield* updateSecretMaterial({
          ref: refreshTokenRef,
          value: tokenResponse.refresh_token,
        });
      } else {
        refreshTokenRef = yield* storeSecretMaterial({
          purpose: "oauth_refresh_token",
          value: tokenResponse.refresh_token,
          name: `${input.sourceId} Google Refresh Token`,
        });
      }
    }

    const stored = yield* input.storage.get({
      scopeId: input.scopeId,
      sourceId: input.sourceId,
    });
    if (stored) {
      yield* input.storage.put({
        scopeId: input.scopeId,
        sourceId: input.sourceId,
        value: decodeStoredSourceData({
          ...stored,
          auth: {
            ...stored.auth,
            ...(stored.auth.kind === "oauth2"
              ? {
                  refreshTokenRef,
                  expiresAt:
                    typeof tokenResponse.expires_in === "number"
                      ? Date.now() + tokenResponse.expires_in * 1000
                      : stored.auth.expiresAt,
                }
              : {}),
          },
        }),
      });
    }

    return tokenResponse.access_token;
  });

const resolveGoogleAuthHeaders = (input: {
  scopeId: string;
  sourceId: string;
  stored: GoogleDiscoveryStoredSourceData;
  storage: GoogleDiscoverySourceStorage;
}): Effect.Effect<Record<string, string>, Error, any> =>
  Effect.gen(function* () {
    if (input.stored.auth.kind === "none") {
      return {
        ...input.stored.defaultHeaders,
      };
    }

    if (input.stored.auth.kind === "bearer") {
      const resolveSecretMaterial = yield* SecretMaterialResolverService;
      const token = yield* resolveSecretMaterial({
        ref: input.stored.auth.tokenSecretRef,
      });
      return {
        ...input.stored.defaultHeaders,
        authorization: `Bearer ${token.trim()}`,
      };
    }

    const token = yield* resolveOauthAccessToken({
      scopeId: input.scopeId,
      sourceId: input.sourceId,
      auth: input.stored.auth,
      storage: input.storage,
    });

    return {
      ...input.stored.defaultHeaders,
      authorization: `Bearer ${token.trim()}`,
    };
  });

const storedSourceDataFromInput = (
  input: GoogleDiscoveryConnectInput,
): GoogleDiscoveryStoredSourceData =>
  decodeStoredSourceData({
    service: input.service.trim(),
    version: input.version.trim(),
    discoveryUrl: input.discoveryUrl?.trim() || defaultGoogleDiscoveryUrl(input.service, input.version),
    defaultHeaders: input.defaultHeaders,
    scopes: [...input.scopes],
    auth: input.auth,
  });

const sourceConfigFromStored = (
  source: Source,
  stored: GoogleDiscoveryStoredSourceData,
): GoogleDiscoverySourceConfigPayload => ({
  name: source.name,
  service: stored.service,
  version: stored.version,
  discoveryUrl: stored.discoveryUrl,
  defaultHeaders: stored.defaultHeaders,
  scopes: [...stored.scopes],
  auth: stored.auth,
});

const normalizeBatchSourceInput = (
  input: GoogleDiscoveryBatchSourceInput,
): GoogleDiscoveryBatchSourceInput =>
  decodeBatchSourceInput({
    name: input.name.trim(),
    service: input.service.trim(),
    version: input.version.trim(),
    discoveryUrl:
      input.discoveryUrl?.trim()
      || defaultGoogleDiscoveryUrl(input.service, input.version),
    defaultHeaders: input.defaultHeaders,
    scopes: [...new Set(input.scopes.map((scope) => scope.trim()).filter(Boolean))],
  });

const resolveScopesForBatchSource = (input: {
  source: GoogleDiscoveryBatchSourceInput;
}): Effect.Effect<ReadonlyArray<string>, Error> =>
  input.source.scopes.length > 0
    ? Effect.succeed([...input.source.scopes])
    : fetchGoogleDiscoveryDocumentWithHeaders({
        url: input.source.discoveryUrl ?? defaultGoogleDiscoveryUrl(input.source.service, input.source.version),
        headers: input.source.defaultHeaders ?? {},
      }).pipe(
        Effect.flatMap((document) =>
          inferScopesFromDiscoveryDocument({
            service: input.source.service,
            document,
          })
        ),
      );

const googleDiscoveryConnectInputFromAddInput = (
  input: GoogleDiscoveryExecutorAddInput,
): GoogleDiscoveryConnectInput => ({
  name: input.name,
  service: input.service,
  version: input.version,
  discoveryUrl: input.discoveryUrl,
  defaultHeaders: input.defaultHeaders,
  scopes: input.scopes,
  auth: input.auth,
});

const googleDiscoveryStoredSourceDataFromLocalConfig = (input: {
  config: unknown;
  loadedConfig: LocalExecutorConfig | null;
}): GoogleDiscoveryStoredSourceData => {
  const current = decodeGoogleDiscoveryCurrentLocalConfigOption(input.config);
  if (Option.isSome(current)) {
    return current.value.config;
  }

  const legacy = decodeGoogleDiscoveryLegacyLocalConfigOption(input.config);
  if (Option.isSome(legacy)) {
    return storedSourceDataFromInput({
      name:
        legacy.value.name
        ?? `${legacy.value.binding.service} ${legacy.value.binding.version}`,
      service: legacy.value.binding.service,
      version: legacy.value.binding.version,
      discoveryUrl: legacy.value.binding.discoveryUrl ?? null,
      defaultHeaders: legacy.value.binding.defaultHeaders ?? null,
      scopes: legacy.value.binding.scopes ?? [],
      auth: decodeCurrentOrLegacyLocalConfigAuth({
        auth: legacy.value.connection.auth,
        authSchema: GoogleDiscoveryConnectionAuthSchema,
        loadedConfig: input.loadedConfig,
        onLegacySecretRef: (tokenSecretRef) => ({
          kind: "bearer",
          tokenSecretRef,
        }),
        fallback: {
          kind: "none",
        },
      }),
    });
  }

  throw new Error("Unsupported Google Discovery local source config.");
};

export const googleDiscoverySdkPlugin = (options: {
  storage: GoogleDiscoverySourceStorage;
  oauthSessions: GoogleDiscoveryOAuthSessionStorage;
}) => defineExecutorSourcePlugin<
  typeof GOOGLE_DISCOVERY_EXECUTOR_KEY,
  GoogleDiscoveryExecutorAddInput,
  GoogleDiscoveryConnectInput,
  GoogleDiscoverySourceConfigPayload,
  GoogleDiscoveryStoredSourceData,
  GoogleDiscoveryUpdateSourceInput,
  GoogleDiscoverySdk
>({
  key: GOOGLE_DISCOVERY_EXECUTOR_KEY,
  source: {
    kind: GOOGLE_DISCOVERY_SOURCE_KIND,
    displayName: "Google Discovery",
    add: {
      inputSchema: GoogleDiscoveryExecutorAddInputSchema,
      inputSignatureWidth: 320,
      helpText: [
        "Provide the Google API service and version plus the final auth configuration.",
        "OAuth browser flows stay on the plugin-owned HTTP/UI surfaces.",
      ],
      toConnectInput: googleDiscoveryConnectInputFromAddInput,
    },
    storage: options.storage,
    source: {
      create: (input) => ({
        source: {
          name: input.name.trim(),
          kind: GOOGLE_DISCOVERY_SOURCE_KIND,
          status: "connected",
          enabled: true,
          namespace: deriveGoogleDiscoveryNamespace(input.service),
        },
        stored: storedSourceDataFromInput(input),
      }),
      update: ({ source, config }) => ({
        source: {
          ...source,
          name: config.name.trim(),
          namespace: deriveGoogleDiscoveryNamespace(config.service),
        },
        stored: storedSourceDataFromInput(config),
      }),
      toConfig: ({ source, stored }) => sourceConfigFromStored(source, stored),
      remove: ({ stored }) =>
        Effect.gen(function* () {
          const deleteSecretMaterial = yield* SecretMaterialDeleterService;
          if (stored?.auth.kind === "oauth2") {
            yield* Effect.either(deleteSecretMaterial(stored.auth.accessTokenRef));
            if (stored.auth.refreshTokenRef) {
              yield* Effect.either(deleteSecretMaterial(stored.auth.refreshTokenRef));
            }
          }
        }),
    },
    localConfig: {
      toConfigSource: ({ source, stored }) =>
        pluginLocalConfigSourceFromConfig({
          source,
          config: stored,
        }),
      recoverStored: ({ config, loadedConfig }) =>
        googleDiscoveryStoredSourceDataFromLocalConfig({
          config,
          loadedConfig,
        }),
    },
    catalog: {
      kind: "imported",
      identity: ({ source }) => ({
        kind: GOOGLE_DISCOVERY_SOURCE_KIND,
        sourceId: source.id,
      }),
      sync: ({ source, stored }) =>
        Effect.gen(function* () {
          if (stored === null) {
            return yield* runtimeEffectError(
              "plugins/google-discovery/sdk",
              `Google Discovery source storage missing for ${source.id}`,
            );
          }

          const headers = yield* resolveGoogleAuthHeaders({
            scopeId: source.scopeId,
            sourceId: source.id,
            stored,
            storage: options.storage,
          });
          const document = yield* fetchGoogleDiscoveryDocumentWithHeaders({
            url: stored.discoveryUrl,
            headers,
          });
          const manifest = yield* extractGoogleDiscoveryManifest(source.name, document);
          const definitions = compileGoogleDiscoveryToolDefinitions(manifest);
          const operations = definitions.map((definition) =>
            googleDiscoveryCatalogOperationFromDefinition({
              manifest,
              definition,
            })
          );
          const now = Date.now();

          return createSourceCatalogSyncResult({
            fragment: createGoogleDiscoveryCatalogFragment({
              source,
              documents: [
                {
                  documentKind: GOOGLE_DISCOVERY_SOURCE_KIND,
                  documentKey: stored.discoveryUrl,
                  contentText: document,
                  fetchedAt: now,
                },
              ],
              operations,
            }),
            importMetadata: {
              ...createCatalogImportMetadata({
                source,
                pluginKey: GOOGLE_DISCOVERY_SOURCE_KIND,
              }),
              importerVersion: "ir.v1.google_discovery",
            },
            sourceHash: manifest.sourceHash,
          });
        }),
      invoke: (input) =>
        Effect.gen(function* () {
          if (input.stored === null) {
            return yield* runtimeEffectError(
              "plugins/google-discovery/sdk",
              `Google Discovery source storage missing for ${input.source.id}`,
            );
          }

          const providerData = decodeProviderData(
            input.executable.binding,
          ) as GoogleDiscoveryToolProviderData;
          const args = asRecord(input.args);
          const headers: Record<string, string> = yield* resolveGoogleAuthHeaders({
            scopeId: input.source.scopeId,
            sourceId: input.source.id,
            stored: input.stored,
            storage: options.storage,
          });
          const requestUrl = new URL(
            replacePathParameters({
              pathTemplate: providerData.invocation.path,
              args,
              parameters: providerData.invocation.parameters,
            }),
            resolveGoogleDiscoveryBaseUrl({
              providerData,
            }),
          );

          let body: string | undefined;
          for (const parameter of providerData.invocation.parameters) {
            const rawValue = args[parameter.name];
            if (rawValue === undefined || rawValue === null) {
              continue;
            }

            if (parameter.location === "query") {
              for (const entry of stringValuesFromParameter(rawValue, parameter.repeated)) {
                requestUrl.searchParams.append(parameter.name, entry);
              }
              continue;
            }

            if (parameter.location === "header") {
              headers[parameter.name] = stringValuesFromParameter(rawValue, false)[0] ?? "";
            }
          }

          if (providerData.invocation.requestSchemaId) {
            const payload = args.body ?? args.input;
            if (payload !== undefined) {
              headers["content-type"] = "application/json";
              body = JSON.stringify(payload);
            }
          }

          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(requestUrl.toString(), {
                method: providerData.invocation.method.toUpperCase(),
                headers,
                ...(body ? { body } : {}),
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
      name: "getSourceConfig",
      description: "Load the saved configuration for a Google Discovery source.",
      inputSchema: GoogleDiscoverySourceIdInputSchema,
      outputSchema: GoogleDiscoverySourceConfigPayloadSchema,
      execute: ({ args, source }) => source.getSourceConfig(args.sourceId),
    },
    {
      name: "createSource",
      description: "Create a Google Discovery source.",
      inputSchema: GoogleDiscoveryConnectInputSchema,
      outputSchema: SourceSchema,
      execute: ({ args, source }) => source.createSource(args),
    },
    {
      name: "updateSource",
      description: "Update a Google Discovery source configuration.",
      inputSchema: GoogleDiscoveryUpdateSourceInputSchema,
      outputSchema: SourceSchema,
      execute: ({ args, source }) => source.updateSource(args),
    },
    {
      name: "removeSource",
      description:
        "Remove a Google Discovery source and its stored plugin data.",
      inputSchema: GoogleDiscoverySourceIdInputSchema,
      outputSchema: Schema.Boolean,
      execute: ({ args, source }) => source.removeSource(args.sourceId),
    },
    {
      name: "startOAuth",
      description: "Start a Google OAuth flow for a single API source.",
      inputSchema: GoogleDiscoveryStartOAuthInputSchema,
      outputSchema: GoogleDiscoveryStartOAuthResultSchema,
      execute: ({ args }) =>
        Effect.gen(function* () {
          const discoveryUrl =
            args.discoveryUrl?.trim()
            || defaultGoogleDiscoveryUrl(args.service, args.version);
          let scopes: ReadonlyArray<string>;
          if (args.scopes.length > 0) {
            const configuredScopes: Array<string> = args.scopes
              .map((scope: string) => scope.trim())
              .filter((scope: string) => scope.length > 0);
            scopes = [...new Set(configuredScopes)];
          } else {
            scopes = yield* fetchGoogleDiscoveryDocumentWithHeaders({
              url: discoveryUrl,
              headers: args.defaultHeaders ?? {},
            }).pipe(
              Effect.flatMap((document) =>
                inferScopesFromDiscoveryDocument({
                  service: args.service,
                  document,
                })
              ),
            );
          }
          const sessionId = `gdisc_oauth_${crypto.randomUUID()}`;
          const codeVerifier = createPkceCodeVerifier();

          yield* options.oauthSessions.put({
            sessionId,
            value: decodeSession({
              kind: "single",
              service: args.service.trim(),
              version: args.version.trim(),
              discoveryUrl,
              defaultHeaders: args.defaultHeaders,
              scopes: [...scopes],
              clientId: args.clientId.trim(),
              clientSecretRef: args.clientSecretRef,
              clientAuthentication: args.clientAuthentication,
              redirectUrl: args.redirectUrl,
              codeVerifier,
            }),
          });

          return {
            sessionId,
            authorizationUrl: buildOAuth2AuthorizationUrl({
              authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
              clientId: args.clientId.trim(),
              redirectUri: args.redirectUrl,
              scopes,
              state: sessionId,
              codeVerifier,
              extraParams: {
                access_type: "offline",
                prompt: "consent",
                include_granted_scopes: "true",
              },
            }),
            scopes: [...scopes],
          };
        }),
    },
    {
      name: "startBatchOAuth",
      description: "Start one Google OAuth flow for multiple API sources.",
      inputSchema: GoogleDiscoveryStartBatchOAuthInputSchema,
      outputSchema: GoogleDiscoveryStartOAuthResultSchema,
      execute: ({ args }) =>
        Effect.gen(function* () {
          const normalizedSources: Array<GoogleDiscoveryBatchSourceInput> =
            args.sources.map((source: GoogleDiscoveryBatchSourceInput) =>
              normalizeBatchSourceInput(source)
            );
          if (normalizedSources.length === 0) {
            return yield* runtimeEffectError(
              "plugins/google-discovery/sdk",
              "Select at least one Google API to connect.",
            );
          }

          const inferredScopes: ReadonlyArray<ReadonlyArray<string>> = yield* Effect.forEach(
            normalizedSources,
            (source: GoogleDiscoveryBatchSourceInput) =>
              resolveScopesForBatchSource({
                source,
              }),
          );
          const scopes: ReadonlyArray<string> = [
            ...new Set(inferredScopes.flat()),
          ];
          const sessionId = `gdisc_oauth_${crypto.randomUUID()}`;
          const codeVerifier = createPkceCodeVerifier();

          yield* options.oauthSessions.put({
            sessionId,
            value: decodeSession({
              kind: "batch",
              sources: normalizedSources.map((
                source: GoogleDiscoveryBatchSourceInput,
                index: number,
              ) => ({
                ...source,
                scopes: inferredScopes[index] ?? [],
              })),
              scopes,
              clientId: args.clientId.trim(),
              clientSecretRef: args.clientSecretRef,
              clientAuthentication: args.clientAuthentication,
              redirectUrl: args.redirectUrl,
              codeVerifier,
            }),
          });

          return {
            sessionId,
            authorizationUrl: buildOAuth2AuthorizationUrl({
              authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
              clientId: args.clientId.trim(),
              redirectUri: args.redirectUrl,
              scopes,
              state: sessionId,
              codeVerifier,
              extraParams: {
                access_type: "offline",
                prompt: "consent",
                include_granted_scopes: "true",
              },
            }),
            scopes,
          };
        }),
    },
    {
      name: "completeOAuth",
      description:
        "Complete a Google OAuth callback and return the connected auth payload.",
      inputSchema: GoogleDiscoveryCompleteOAuthInputSchema,
      outputSchema: GoogleDiscoveryOAuthPopupResultSchema,
      execute: ({ args, source }) =>
        Effect.gen(function* () {
          if (args.error) {
            return yield* runtimeEffectError(
              "plugins/google-discovery/sdk",
              args.errorDescription || args.error || "Google OAuth failed",
            );
          }
          if (!args.code) {
            return yield* runtimeEffectError(
              "plugins/google-discovery/sdk",
              "Missing Google OAuth code.",
            );
          }

          const session = yield* options.oauthSessions.get(args.state);
          if (session === null) {
            return yield* runtimeEffectError(
              "plugins/google-discovery/sdk",
              `Google OAuth session not found: ${args.state}`,
            );
          }

          const resolveSecretMaterial = yield* SecretMaterialResolverService;
          const clientSecret = session.clientSecretRef
            ? yield* resolveSecretMaterial({
                ref: session.clientSecretRef,
              })
            : null;
          const tokenResponse = yield* exchangeOAuth2AuthorizationCode({
            tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
            clientId: session.clientId,
            clientAuthentication: session.clientAuthentication,
            clientSecret,
            redirectUri: session.redirectUrl,
            codeVerifier: session.codeVerifier,
            code: args.code,
          });
          const expiresAt =
            typeof tokenResponse.expires_in === "number"
              ? Date.now() + tokenResponse.expires_in * 1000
              : null;
          const storeSecretMaterial = yield* SecretMaterialStorerService;

          if (session.kind === "single") {
            const accessTokenRef = yield* storeSecretMaterial({
              purpose: "oauth_access_token",
              value: tokenResponse.access_token,
              name: `${session.service} Google Access Token`,
            });
            const refreshTokenRef = tokenResponse.refresh_token
              ? yield* storeSecretMaterial({
                  purpose: "oauth_refresh_token",
                  value: tokenResponse.refresh_token,
                  name: `${session.service} Google Refresh Token`,
                })
              : null;

            if (options.oauthSessions.remove) {
              yield* options.oauthSessions.remove(args.state);
            }

            return {
              type: "executor:oauth-result" as const,
              ok: true as const,
              sessionId: args.state,
              mode: "single" as const,
              auth: {
                kind: "oauth2" as const,
                clientId: session.clientId,
                clientSecretRef: session.clientSecretRef,
                clientAuthentication: session.clientAuthentication,
                authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
                tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
                scopes: session.scopes,
                accessTokenRef,
                refreshTokenRef,
                expiresAt,
              },
            };
          }

          const createdSources = [];
          for (const sessionSource of session.sources) {
            const accessTokenRef = yield* storeSecretMaterial({
              purpose: "oauth_access_token",
              value: tokenResponse.access_token,
              name: `${sessionSource.service} Google Access Token`,
            });
            const refreshTokenRef = tokenResponse.refresh_token
              ? yield* storeSecretMaterial({
                  purpose: "oauth_refresh_token",
                  value: tokenResponse.refresh_token,
                  name: `${sessionSource.service} Google Refresh Token`,
                })
              : null;

            const createdSource = yield* source.createSource({
              name: sessionSource.name,
              service: sessionSource.service,
              version: sessionSource.version,
              discoveryUrl: sessionSource.discoveryUrl,
              defaultHeaders: sessionSource.defaultHeaders,
              scopes:
                sessionSource.scopes.length > 0
                  ? sessionSource.scopes
                  : session.scopes,
              auth: {
                kind: "oauth2",
                clientId: session.clientId,
                clientSecretRef: session.clientSecretRef,
                clientAuthentication: session.clientAuthentication,
                authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
                tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
                scopes:
                  sessionSource.scopes.length > 0
                    ? sessionSource.scopes
                    : session.scopes,
                accessTokenRef,
                refreshTokenRef,
                expiresAt,
              },
            });
            createdSources.push(createdSource);
          }

          if (options.oauthSessions.remove) {
            yield* options.oauthSessions.remove(args.state);
          }

          return {
            type: "executor:oauth-result" as const,
            ok: true as const,
            sessionId: args.state,
            mode: "batch" as const,
            sources: createdSources.map((createdSource) => ({
              id: createdSource.id,
              name: createdSource.name,
            })),
          };
        }),
    },
  ] as const,
  extendExecutor: ({ source, executor }) => {
    const provideRuntime = <A>(
      effect: Effect.Effect<A, Error, any>,
    ): Effect.Effect<A, Error, never> =>
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
      startOAuth: (input) =>
        provideRuntime(
          Effect.gen(function* () {
            const discoveryUrl =
              input.discoveryUrl?.trim()
              || defaultGoogleDiscoveryUrl(input.service, input.version);
            const scopes =
              input.scopes.length > 0
                ? [...new Set(input.scopes.map((scope) => scope.trim()).filter(Boolean))]
                : yield* fetchGoogleDiscoveryDocumentWithHeaders({
                    url: discoveryUrl,
                    headers: input.defaultHeaders ?? {},
                  }).pipe(
                    Effect.flatMap((document) =>
                      inferScopesFromDiscoveryDocument({
                        service: input.service,
                        document,
                      })
                    ),
                  );
            const sessionId = `gdisc_oauth_${crypto.randomUUID()}`;
            const codeVerifier = createPkceCodeVerifier();

            yield* options.oauthSessions.put({
              sessionId,
              value: decodeSession({
                kind: "single",
                service: input.service.trim(),
                version: input.version.trim(),
                discoveryUrl,
                defaultHeaders: input.defaultHeaders,
                scopes: [...scopes],
                clientId: input.clientId.trim(),
                clientSecretRef: input.clientSecretRef,
                clientAuthentication: input.clientAuthentication,
                redirectUrl: input.redirectUrl,
                codeVerifier,
              }),
            });

            return {
              sessionId,
              authorizationUrl: buildOAuth2AuthorizationUrl({
                authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
                clientId: input.clientId.trim(),
                redirectUri: input.redirectUrl,
                scopes,
                state: sessionId,
                codeVerifier,
                extraParams: {
                  access_type: "offline",
                  prompt: "consent",
                  include_granted_scopes: "true",
                },
              }),
              scopes: [...scopes],
            };
          }),
        ),
      startBatchOAuth: (input) =>
        provideRuntime(
          Effect.gen(function* () {
            const normalizedSources = input.sources.map((source) =>
              normalizeBatchSourceInput(source)
            );
            if (normalizedSources.length === 0) {
              return yield* runtimeEffectError(
                "plugins/google-discovery/sdk",
                "Select at least one Google API to connect.",
              );
            }

            const inferredScopes = yield* Effect.forEach(
              normalizedSources,
              (source) =>
                resolveScopesForBatchSource({
                  source,
                }),
            );
            const scopes = [...new Set(inferredScopes.flat())];
            const sessionId = `gdisc_oauth_${crypto.randomUUID()}`;
            const codeVerifier = createPkceCodeVerifier();

            yield* options.oauthSessions.put({
              sessionId,
              value: decodeSession({
                kind: "batch",
                sources: normalizedSources.map((source, index) => ({
                  ...source,
                  scopes: inferredScopes[index] ?? [],
                })),
                scopes,
                clientId: input.clientId.trim(),
                clientSecretRef: input.clientSecretRef,
                clientAuthentication: input.clientAuthentication,
                redirectUrl: input.redirectUrl,
                codeVerifier,
              }),
            });

            return {
              sessionId,
              authorizationUrl: buildOAuth2AuthorizationUrl({
                authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
                clientId: input.clientId.trim(),
                redirectUri: input.redirectUrl,
                scopes,
                state: sessionId,
                codeVerifier,
                extraParams: {
                  access_type: "offline",
                  prompt: "consent",
                  include_granted_scopes: "true",
                },
              }),
              scopes,
            };
          }),
        ),
      completeOAuth: (input) =>
        provideRuntime(
          Effect.gen(function* () {
            if (input.error) {
              return yield* runtimeEffectError(
                "plugins/google-discovery/sdk",
                input.errorDescription || input.error || "Google OAuth failed",
              );
            }
            if (!input.code) {
              return yield* runtimeEffectError(
                "plugins/google-discovery/sdk",
                "Missing Google OAuth code.",
              );
            }

            const session = yield* options.oauthSessions.get(input.state);
            if (session === null) {
              return yield* runtimeEffectError(
                "plugins/google-discovery/sdk",
                `Google OAuth session not found: ${input.state}`,
              );
            }

            const resolveSecretMaterial = yield* SecretMaterialResolverService;
            const storeSecretMaterial = yield* SecretMaterialStorerService;
            const clientSecret = session.clientSecretRef
              ? yield* resolveSecretMaterial({
                  ref: session.clientSecretRef,
                })
              : null;
            const tokenResponse = yield* exchangeOAuth2AuthorizationCode({
              tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
              clientId: session.clientId,
              clientAuthentication: session.clientAuthentication,
              clientSecret,
              redirectUri: session.redirectUrl,
              codeVerifier: session.codeVerifier,
              code: input.code,
            });
            const expiresAt =
              typeof tokenResponse.expires_in === "number"
                ? Date.now() + tokenResponse.expires_in * 1000
                : null;

            if (session.kind === "single") {
              const accessTokenRef = yield* storeSecretMaterial({
                purpose: "oauth_access_token",
                value: tokenResponse.access_token,
                name: `${session.service} Google Access Token`,
              });
              const refreshTokenRef = tokenResponse.refresh_token
                ? yield* storeSecretMaterial({
                    purpose: "oauth_refresh_token",
                    value: tokenResponse.refresh_token,
                    name: `${session.service} Google Refresh Token`,
                  })
                : null;

              if (options.oauthSessions.remove) {
                yield* options.oauthSessions.remove(input.state);
              }

              return {
                type: "executor:oauth-result" as const,
                ok: true as const,
                sessionId: input.state,
                mode: "single" as const,
                auth: {
                  kind: "oauth2" as const,
                  clientId: session.clientId,
                  clientSecretRef: session.clientSecretRef,
                  clientAuthentication: session.clientAuthentication,
                  authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
                  tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
                  scopes: [...session.scopes],
                  accessTokenRef,
                  refreshTokenRef,
                  expiresAt,
                },
              };
            }

              const createdSources = [];
              for (const sessionSource of session.sources) {
                const accessTokenRef = yield* storeSecretMaterial({
                  purpose: "oauth_access_token",
                  value: tokenResponse.access_token,
                  name: `${sessionSource.service} Google Access Token`,
                });
                const refreshTokenRef = tokenResponse.refresh_token
                  ? yield* storeSecretMaterial({
                      purpose: "oauth_refresh_token",
                      value: tokenResponse.refresh_token,
                      name: `${sessionSource.service} Google Refresh Token`,
                    })
                  : null;

                const createdSource = yield* source.createSource({
                  name: sessionSource.name,
                  service: sessionSource.service,
                  version: sessionSource.version,
                  discoveryUrl: sessionSource.discoveryUrl,
                  defaultHeaders: sessionSource.defaultHeaders,
                  scopes:
                    sessionSource.scopes.length > 0
                      ? sessionSource.scopes
                      : session.scopes,
                  auth: {
                    kind: "oauth2",
                    clientId: session.clientId,
                    clientSecretRef: session.clientSecretRef,
                    clientAuthentication: session.clientAuthentication,
                    authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
                    tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
                    scopes:
                      sessionSource.scopes.length > 0
                        ? sessionSource.scopes
                        : session.scopes,
                    accessTokenRef,
                    refreshTokenRef,
                    expiresAt,
                  },
                });
                createdSources.push(createdSource);
              }

            if (options.oauthSessions.remove) {
              yield* options.oauthSessions.remove(input.state);
            }

            return {
              type: "executor:oauth-result" as const,
              ok: true as const,
              sessionId: input.state,
              mode: "batch" as const,
              sources: createdSources.map((source) => ({
                id: source.id,
                name: source.name,
              })),
            };
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
            ),
          ),
      ),
    };
  },
});
