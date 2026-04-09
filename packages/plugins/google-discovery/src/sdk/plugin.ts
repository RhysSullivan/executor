import { randomUUID } from "node:crypto";

import { Effect, Option } from "effect";

import {
  Source,
  SourceDetectionResult,
  definePlugin,
  type ExecutorPlugin,
  type PluginContext,
  SecretId,
  ToolId,
  type ToolRegistration,
} from "@executor/sdk";

import type {
  GoogleDiscoveryBindingStore,
} from "./binding-store";
import { makeInMemoryBindingStore } from "./binding-store";
import { extractGoogleDiscoveryManifest } from "./document";
import { makeGoogleDiscoveryInvoker } from "./invoke";
import {
  GoogleDiscoveryParseError,
  GoogleDiscoveryOAuthError,
  GoogleDiscoverySourceError,
} from "./errors";
import {
  buildGoogleAuthorizationUrl,
  createPkceCodeVerifier,
  exchangeAuthorizationCode,
} from "./oauth";
import type {
  GoogleDiscoveryAuth,
  GoogleDiscoveryManifest,
  GoogleDiscoveryManifestMethod,
  GoogleDiscoveryOAuthSession,
  GoogleDiscoveryStoredSourceData,
} from "./types";
import { GoogleDiscoveryStoredSourceData as GoogleDiscoveryStoredSourceDataSchema } from "./types";

export interface GoogleDiscoveryProbeResult {
  readonly name: string;
  readonly title: string | null;
  readonly service: string;
  readonly version: string;
  readonly toolCount: number;
  readonly scopes: readonly string[];
}

export interface GoogleDiscoveryAddSourceInput {
  readonly name: string;
  readonly discoveryUrl: string;
  readonly namespace?: string;
  readonly auth: GoogleDiscoveryAuth;
}

export interface GoogleDiscoveryOAuthStartInput {
  readonly name: string;
  readonly discoveryUrl: string;
  readonly clientId: string;
  readonly clientSecretSecretId?: string | null;
  readonly redirectUrl: string;
  readonly scopes?: readonly string[];
}

export interface GoogleDiscoveryOAuthStartResponse {
  readonly sessionId: string;
  readonly authorizationUrl: string;
  readonly scopes: readonly string[];
}

export interface GoogleDiscoveryOAuthCompleteInput {
  readonly state: string;
  readonly code?: string;
  readonly error?: string;
}

export interface GoogleDiscoveryOAuthAuthResult {
  readonly kind: "oauth2";
  readonly clientId: string;
  readonly clientSecretSecretId: string | null;
  readonly accessTokenSecretId: string;
  readonly refreshTokenSecretId: string | null;
  readonly tokenType: string;
  readonly expiresAt: number | null;
  readonly scope: string | null;
  readonly scopes: readonly string[];
}

export interface GoogleDiscoveryPluginExtension {
  readonly probeDiscovery: (
    discoveryUrl: string,
  ) => Effect.Effect<
    GoogleDiscoveryProbeResult,
    GoogleDiscoveryParseError | GoogleDiscoverySourceError
  >;
  readonly addSource: (
    input: GoogleDiscoveryAddSourceInput,
  ) => Effect.Effect<
    { readonly toolCount: number; readonly namespace: string },
    GoogleDiscoveryParseError | GoogleDiscoverySourceError
  >;
  readonly removeSource: (namespace: string) => Effect.Effect<void>;
  readonly startOAuth: (
    input: GoogleDiscoveryOAuthStartInput,
  ) => Effect.Effect<
    GoogleDiscoveryOAuthStartResponse,
    GoogleDiscoveryParseError | GoogleDiscoverySourceError | GoogleDiscoveryOAuthError
  >;
  readonly completeOAuth: (
    input: GoogleDiscoveryOAuthCompleteInput,
  ) => Effect.Effect<GoogleDiscoveryOAuthAuthResult, GoogleDiscoveryOAuthError>;
}

const DISCOVERY_SERVICE_HOST = "https://www.googleapis.com/discovery/v1/apis";

const normalizeDiscoveryUrl = (discoveryUrl: string): string => {
  const trimmed = discoveryUrl.trim();
  if (trimmed.length === 0) return trimmed;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  if (parsed.pathname !== "/$discovery/rest") {
    return trimmed;
  }

  const version = parsed.searchParams.get("version")?.trim();
  if (!version) {
    return trimmed;
  }

  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith(".googleapis.com")) {
    return trimmed;
  }

  const rawService = host.slice(0, -".googleapis.com".length);
  const service =
    rawService === "calendar-json" ? "calendar"
    : rawService.endsWith("-json") ? rawService.slice(0, -5)
    : rawService;

  if (!service) {
    return trimmed;
  }

  return `${DISCOVERY_SERVICE_HOST}/${service}/${version}/rest`;
};

const fetchDiscoveryDocument = (discoveryUrl: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(normalizeDiscoveryUrl(discoveryUrl), {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new GoogleDiscoverySourceError({
          message: `Google Discovery fetch failed with status ${response.status}`,
        });
      }
      return response.text();
    },
    catch: (cause) =>
      cause instanceof GoogleDiscoverySourceError
        ? cause
        : new GoogleDiscoverySourceError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
  });

const normalizeSlug = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

const deriveNamespace = (input: {
  name: string;
  service: string;
  version: string;
}): string =>
  normalizeSlug(
    input.name ||
      `google_${input.service}_${input.version.replace(/[^a-zA-Z0-9]+/g, "_")}`,
  ) || `google_${input.service}`;

const registerManifest = (
  ctx: PluginContext,
  bindingStore: GoogleDiscoveryBindingStore,
  namespace: string,
  manifest: GoogleDiscoveryManifest,
  sourceData: GoogleDiscoveryStoredSourceData,
) =>
  Effect.gen(function* () {
    const existingToolIds = yield* bindingStore.listByNamespace(namespace);
    if (existingToolIds.length > 0) {
      yield* ctx.tools.unregister(existingToolIds);
      yield* bindingStore.removeByNamespace(namespace);
    }

    if (Object.keys(manifest.schemaDefinitions).length > 0) {
      yield* ctx.tools.registerDefinitions(manifest.schemaDefinitions);
    }

    const registrations: ToolRegistration[] = manifest.methods.map(
      (method: GoogleDiscoveryManifestMethod) => ({
        id: ToolId.make(`${namespace}.${method.toolPath}`),
        pluginKey: "googleDiscovery",
        sourceId: namespace,
        name: method.toolPath,
        description: Option.getOrUndefined(method.description),
        inputSchema: Option.getOrUndefined(method.inputSchema),
        outputSchema: Option.getOrUndefined(method.outputSchema),
      }),
    );

    yield* Effect.forEach(
      manifest.methods,
      (method) =>
        bindingStore.put(
          ToolId.make(`${namespace}.${method.toolPath}`),
          namespace,
          method.binding,
        ),
      { discard: true },
    );

    yield* ctx.tools.register(registrations);
    yield* bindingStore.putSource({
      namespace,
      name: sourceData.name,
      config: sourceData,
    });

    return registrations.length;
  });

const storeSecret = (ctx: PluginContext, input: {
  readonly idPrefix: string;
  readonly name: string;
  readonly value: string;
  readonly purpose: string;
}) =>
  ctx.secrets
    .set({
      id: SecretId.make(`${input.idPrefix}_${randomUUID().slice(0, 8)}`),
      scopeId: ctx.scope.id,
      name: input.name,
      value: input.value,
      purpose: input.purpose,
    })
    .pipe(
      Effect.mapError(
        (error) =>
          new GoogleDiscoveryOAuthError({
            message: error.message,
          }),
      ),
    );

export const googleDiscoveryPlugin = (options?: {
  readonly bindingStore?: GoogleDiscoveryBindingStore;
}): ExecutorPlugin<"googleDiscovery", GoogleDiscoveryPluginExtension> => {
  const bindingStore = options?.bindingStore ?? makeInMemoryBindingStore();
  const oauthSessions = new Map<string, GoogleDiscoveryOAuthSession>();

  return definePlugin({
    key: "googleDiscovery",
    init: (ctx: PluginContext) =>
      Effect.gen(function* () {
        yield* ctx.tools.registerInvoker(
          "googleDiscovery",
          makeGoogleDiscoveryInvoker({
            bindingStore,
            secrets: ctx.secrets,
            scopeId: ctx.scope.id,
          }),
        );

        yield* ctx.sources.addManager({
          kind: "googleDiscovery",
          list: () =>
            bindingStore.listSources().pipe(
              Effect.map((sources) =>
                sources.map(
                  (s) =>
                    new Source({
                      id: s.namespace,
                      name: s.name,
                      kind: "googleDiscovery",
                      runtime: false,
                      canRemove: true,
                      canRefresh: true,
                      canEdit: true,
                    }),
                ),
              ),
            ),
          remove: (sourceId) =>
            Effect.gen(function* () {
              const toolIds = yield* bindingStore.removeByNamespace(sourceId);
              if (toolIds.length > 0) {
                yield* ctx.tools.unregister(toolIds);
              }
              yield* bindingStore.removeSource(sourceId);
            }),
          getConfig: (sourceId: string) =>
            Effect.gen(function* () {
              const config = yield* bindingStore.getSourceConfig(sourceId);
              if (!config) return null;
              return config as unknown as Record<string, unknown>;
            }),
          update: (sourceId: string, config: Record<string, unknown>) =>
            Effect.gen(function* () {
              const existingConfig = yield* bindingStore.getSourceConfig(sourceId);
              if (!existingConfig) return;

              // Merge auth changes
              const updatedConfig = new GoogleDiscoveryStoredSourceDataSchema({
                ...existingConfig,
                ...(config.auth !== undefined ? { auth: config.auth as GoogleDiscoveryAuth } : {}),
              });

              // Find existing source meta
              const sources = yield* bindingStore.listSources();
              const existingMeta = sources.find((s) => s.namespace === sourceId);

              yield* bindingStore.putSource({
                namespace: sourceId,
                name: existingMeta?.name ?? sourceId,
                config: updatedConfig,
              });
            }),
          detect: (url: string) =>
            Effect.gen(function* () {
              const trimmed = url.trim();
              if (!trimmed) return null;
              const parsed = yield* Effect.try(() => new URL(trimmed)).pipe(Effect.option);
              if (parsed._tag === "None") return null;

              // Only probe URLs that look like Google Discovery docs
              const isGoogleUrl = trimmed.includes("googleapis.com");
              const isDiscoveryPath = trimmed.includes("/discovery/") || trimmed.includes("$discovery");
              if (!isGoogleUrl && !isDiscoveryPath) return null;

              const discoveryText = yield* fetchDiscoveryDocument(trimmed).pipe(
                Effect.catchAll(() => Effect.succeed(null)),
              );
              if (!discoveryText) return null;

              const manifest = yield* extractGoogleDiscoveryManifest(discoveryText).pipe(
                Effect.catchAll(() => Effect.succeed(null)),
              );
              if (!manifest) return null;

              const name = Option.getOrElse(manifest.title, () => `${manifest.service} ${manifest.version}`);

              return new SourceDetectionResult({
                kind: "googleDiscovery",
                confidence: "high",
                endpoint: trimmed,
                name,
                namespace: deriveNamespace({
                  name,
                  service: manifest.service,
                  version: manifest.version,
                }),
              });
            }),
          refresh: (sourceId) =>
            Effect.gen(function* () {
              const sourceData = yield* bindingStore.getSourceConfig(sourceId);
              if (!sourceData) return;
              const discoveryText = yield* fetchDiscoveryDocument(
                sourceData.discoveryUrl,
              );
              const manifest = yield* extractGoogleDiscoveryManifest(
                discoveryText,
              );
              const nextSourceData = new GoogleDiscoveryStoredSourceDataSchema({
                ...sourceData,
                service: manifest.service,
                version: manifest.version,
                rootUrl: manifest.rootUrl,
                servicePath: manifest.servicePath,
              });
              yield* registerManifest(
                ctx,
                bindingStore,
                sourceId,
                manifest,
                nextSourceData,
              );
            }).pipe(Effect.orDie),
        });

        const extension: GoogleDiscoveryPluginExtension = {
          probeDiscovery: (discoveryUrl: string) =>
            Effect.gen(function* () {
              const discoveryText = yield* fetchDiscoveryDocument(discoveryUrl);
              const manifest = yield* extractGoogleDiscoveryManifest(
                discoveryText,
              );
              const scopes = Object.keys(
                manifest.oauthScopes._tag === "Some"
                  ? manifest.oauthScopes.value
                  : {},
              ).sort();
              return {
                name:
                  manifest.title._tag === "Some"
                    ? manifest.title.value
                    : `${manifest.service} ${manifest.version}`,
                title:
                  manifest.title._tag === "Some"
                    ? manifest.title.value
                    : null,
                service: manifest.service,
                version: manifest.version,
                toolCount: manifest.methods.length,
                scopes,
              };
            }),

          addSource: (input) =>
            Effect.gen(function* () {
              const discoveryText = yield* fetchDiscoveryDocument(
                input.discoveryUrl,
              );
              const manifest = yield* extractGoogleDiscoveryManifest(
                discoveryText,
              );
              const namespace =
                input.namespace ??
                deriveNamespace({
                  name: input.name,
                  service: manifest.service,
                  version: manifest.version,
                });
              const sourceData = new GoogleDiscoveryStoredSourceDataSchema({
                name: input.name,
                discoveryUrl: normalizeDiscoveryUrl(input.discoveryUrl),
                service: manifest.service,
                version: manifest.version,
                rootUrl: manifest.rootUrl,
                servicePath: manifest.servicePath,
                auth: input.auth,
              });
              const toolCount = yield* registerManifest(
                ctx,
                bindingStore,
                namespace,
                manifest,
                sourceData,
              );
              return { toolCount, namespace };
            }),

          removeSource: (namespace: string) =>
            Effect.gen(function* () {
              const toolIds = yield* bindingStore.removeByNamespace(namespace);
              if (toolIds.length > 0) {
                yield* ctx.tools.unregister(toolIds);
              }
              yield* bindingStore.removeSource(namespace);
            }),

          startOAuth: (input) =>
            Effect.gen(function* () {
              const discoveryText = yield* fetchDiscoveryDocument(
                input.discoveryUrl,
              );
              const manifest = yield* extractGoogleDiscoveryManifest(
                discoveryText,
              );
              const scopes =
                input.scopes && input.scopes.length > 0
                  ? [...input.scopes]
                  : Object.keys(
                      manifest.oauthScopes._tag === "Some"
                        ? manifest.oauthScopes.value
                        : {},
                    ).sort();
              if (scopes.length === 0) {
                return yield* new GoogleDiscoveryOAuthError({
                  message:
                    "This Google Discovery document does not declare any OAuth scopes",
                });
              }
              const sessionId = randomUUID();
              const codeVerifier = createPkceCodeVerifier();
              oauthSessions.set(sessionId, {
                discoveryUrl: normalizeDiscoveryUrl(input.discoveryUrl),
                name: input.name,
                clientId: input.clientId,
                clientSecretSecretId: input.clientSecretSecretId ?? null,
                redirectUrl: input.redirectUrl,
                scopes,
                codeVerifier,
              });
              return {
                sessionId,
                authorizationUrl: buildGoogleAuthorizationUrl({
                  clientId: input.clientId,
                  redirectUrl: input.redirectUrl,
                  scopes,
                  state: sessionId,
                  codeVerifier,
                }),
                scopes,
              };
            }),

          completeOAuth: (input) =>
            Effect.gen(function* () {
              const session = oauthSessions.get(input.state);
              if (!session) {
                return yield* new GoogleDiscoveryOAuthError({
                  message: "OAuth session not found or has expired",
                });
              }
              oauthSessions.delete(input.state);

              if (input.error) {
                return yield* new GoogleDiscoveryOAuthError({
                  message: input.error,
                });
              }
              if (!input.code) {
                return yield* new GoogleDiscoveryOAuthError({
                  message: "OAuth callback did not include an authorization code",
                });
              }

              const tokenResponse = yield* exchangeAuthorizationCode({
                clientId: session.clientId,
                clientSecret:
                  session.clientSecretSecretId === null
                    ? null
                    : yield* ctx.secrets
                        .resolve(
                          SecretId.make(session.clientSecretSecretId),
                          ctx.scope.id,
                        )
                        .pipe(
                          Effect.mapError(
                            (error) =>
                              new GoogleDiscoveryOAuthError({
                                message: error.message,
                              }),
                          ),
                        ),
                redirectUrl: session.redirectUrl,
                codeVerifier: session.codeVerifier,
                code: input.code,
              });

              const accessTokenRef = yield* storeSecret(ctx, {
                idPrefix: `${normalizeSlug(session.name)}_google_access_token`,
                name: `${session.name} Access Token`,
                value: tokenResponse.access_token,
                purpose: "google_oauth_access_token",
              });
              const refreshTokenRef = tokenResponse.refresh_token
                ? yield* storeSecret(ctx, {
                    idPrefix: `${normalizeSlug(session.name)}_google_refresh_token`,
                    name: `${session.name} Refresh Token`,
                    value: tokenResponse.refresh_token,
                    purpose: "google_oauth_refresh_token",
                  })
                : null;
              return {
                kind: "oauth2" as const,
                clientId: session.clientId,
                clientSecretSecretId: session.clientSecretSecretId,
                accessTokenSecretId: accessTokenRef.id,
                refreshTokenSecretId: refreshTokenRef?.id ?? null,
                tokenType: tokenResponse.token_type ?? "Bearer",
                expiresAt:
                  typeof tokenResponse.expires_in === "number"
                    ? Date.now() + tokenResponse.expires_in * 1000
                    : null,
                scope: tokenResponse.scope ?? null,
                scopes: [...session.scopes],
              };
            }),
        };

        return {
          extension,
          close: () =>
            Effect.sync(() => {
              oauthSessions.clear();
            }),
        };
      }),
  });
};
