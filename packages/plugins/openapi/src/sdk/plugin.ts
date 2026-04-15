import { randomUUID } from "node:crypto";

import { Effect, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import type { Layer } from "effect";

import {
  buildAuthorizationUrl,
  createPkceCodeVerifier,
  exchangeAuthorizationCode,
  storeOAuthTokens,
  type OAuth2TokenResponse,
} from "@executor/plugin-oauth2";

import {
  Source,
  SourceDetectionResult,
  definePlugin,
  registerRuntimeTools,
  runtimeTool,
  SecretId,
  type ExecutorPlugin,
  type PluginContext,
  ToolId,
  type ToolRegistration,
} from "@executor/sdk";

import { OpenApiOAuthError } from "./errors";
import { parse } from "./parse";
import { extract } from "./extract";
import { compileToolDefinitions, type ToolDefinition } from "./definitions";
import { makeOpenApiInvoker } from "./invoke";
import { resolveBaseUrl } from "./openapi-utils";
import type { OpenApiOperationStore, StoredSource } from "./operation-store";
import { makeInMemoryOperationStore } from "./kv-operation-store";
import { previewSpec, SpecPreview } from "./preview";
import {
  HeaderValue as HeaderValueSchema,
  InvocationConfig,
  OAuth2Auth,
  OpenApiOAuthSession,
  OperationBinding,
  type HeaderValue as HeaderValueValue,
} from "./types";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

/** A header value — either a static string or a reference to a secret */
export type HeaderValue = HeaderValueValue;

export interface OpenApiSpecConfig {
  readonly spec: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly namespace?: string;
  /** Headers applied to every request. Values can reference secrets. */
  readonly headers?: Record<string, HeaderValue>;
  /** OAuth2 auth descriptor (as returned from completeOAuth). */
  readonly oauth2?: OAuth2Auth;
}

// ---------------------------------------------------------------------------
// Plugin extension
// ---------------------------------------------------------------------------

export interface OpenApiUpdateSourceInput {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly headers?: Record<string, HeaderValue>;
}

// ---------------------------------------------------------------------------
// OAuth2 onboarding inputs / outputs
// ---------------------------------------------------------------------------

export interface OpenApiStartOAuthInput {
  /** Display name used for stored token secret labels. */
  readonly displayName: string;
  /** Which security scheme in `components.securitySchemes` this flow belongs to. */
  readonly securitySchemeName: string;
  readonly flow: "authorizationCode";
  /** Authorization endpoint from the spec flow. */
  readonly authorizationUrl: string;
  /** Token endpoint from the spec flow. */
  readonly tokenUrl: string;
  /** Public redirect URL the user-agent will return to. */
  readonly redirectUrl: string;
  readonly clientIdSecretId: string;
  readonly clientSecretSecretId?: string | null;
  /** Scopes the user requested (subset of the flow's declared scopes). */
  readonly scopes: readonly string[];
}

export interface OpenApiStartOAuthResponse {
  readonly sessionId: string;
  readonly authorizationUrl: string;
  readonly scopes: readonly string[];
}

export interface OpenApiCompleteOAuthInput {
  /** sessionId passed via the OAuth `state` param. */
  readonly state: string;
  readonly code?: string;
  readonly error?: string;
}

export interface OpenApiPluginExtension {
  /** Preview a spec without registering — returns metadata, auth strategies, header presets */
  readonly previewSpec: (specText: string) => Effect.Effect<SpecPreview, Error>;

  /** Add an OpenAPI spec and register its operations as tools */
  readonly addSpec: (
    config: OpenApiSpecConfig,
  ) => Effect.Effect<{ readonly toolCount: number }, Error>;

  /** Remove all tools from a previously added spec by namespace */
  readonly removeSpec: (namespace: string) => Effect.Effect<void>;

  /** Fetch the full stored source by namespace (or null if missing) */
  readonly getSource: (namespace: string) => Effect.Effect<StoredSource | null>;

  /** Update config (baseUrl, headers) for an existing OpenAPI source */
  readonly updateSource: (
    namespace: string,
    input: OpenApiUpdateSourceInput,
  ) => Effect.Effect<void>;

  /** Begin an OAuth2 authorization-code flow; returns the authorization URL + sessionId. */
  readonly startOAuth: (
    input: OpenApiStartOAuthInput,
  ) => Effect.Effect<OpenApiStartOAuthResponse, OpenApiOAuthError>;

  /** Exchange a code for tokens; returns the auth descriptor to pass to addSpec. */
  readonly completeOAuth: (
    input: OpenApiCompleteOAuthInput,
  ) => Effect.Effect<OAuth2Auth, OpenApiOAuthError>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PreviewSpecInputSchema = Schema.Struct({
  spec: Schema.String,
});
type PreviewSpecInput = typeof PreviewSpecInputSchema.Type;

const AddSourceInputSchema = Schema.Struct({
  spec: Schema.String,
  baseUrl: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: HeaderValueSchema })),
});
type AddSourceInput = typeof AddSourceInputSchema.Type;

const AddSourceOutputSchema = Schema.Struct({
  sourceId: Schema.String,
  toolCount: Schema.Number,
});

/** Rewrite OpenAPI `#/components/schemas/X` refs to standard `#/$defs/X`. */
const normalizeOpenApiRefs = (node: unknown): unknown => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((item) => {
      const n = normalizeOpenApiRefs(item);
      if (n !== item) changed = true;
      return n;
    });
    return changed ? out : node;
  }

  const obj = node as Record<string, unknown>;

  if (typeof obj.$ref === "string") {
    const match = obj.$ref.match(/^#\/components\/schemas\/(.+)$/);
    if (match) return { ...obj, $ref: `#/$defs/${match[1]}` };
    return obj;
  }

  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = normalizeOpenApiRefs(v);
    if (n !== v) changed = true;
    result[k] = n;
  }
  return changed ? result : obj;
};

const toRegistration = (def: ToolDefinition, namespace: string): ToolRegistration => {
  const op = def.operation;
  const description = Option.getOrElse(op.description, () =>
    Option.getOrElse(op.summary, () => `${op.method.toUpperCase()} ${op.pathTemplate}`),
  );
  return {
    id: ToolId.make(`${namespace}.${def.toolPath}`),
    pluginKey: "openapi",
    sourceId: namespace,
    name: def.toolPath,
    description,
    inputSchema: normalizeOpenApiRefs(Option.getOrUndefined(op.inputSchema)),
    outputSchema: normalizeOpenApiRefs(Option.getOrUndefined(op.outputSchema)),
  };
};

const toBinding = (def: ToolDefinition): OperationBinding =>
  new OperationBinding({
    method: def.operation.method,
    pathTemplate: def.operation.pathTemplate,
    parameters: [...def.operation.parameters],
    requestBody: def.operation.requestBody,
  });

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export const openApiPlugin = (options?: {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly operationStore?: OpenApiOperationStore;
}): ExecutorPlugin<"openapi", OpenApiPluginExtension> => {
  const httpClientLayer = options?.httpClientLayer ?? FetchHttpClient.layer;
  const operationStore = options?.operationStore ?? makeInMemoryOperationStore();

  return definePlugin({
    key: "openapi",
    init: (ctx: PluginContext) =>
      Effect.gen(function* () {
        yield* ctx.tools.registerInvoker(
          "openapi",
          makeOpenApiInvoker({
            operationStore,
            httpClientLayer,
            secrets: ctx.secrets,
            scopeId: ctx.scope.id,
          }),
        );

        // Tools are already persisted in the KV tool registry — no need to
        // re-register them. We only need the source list and the invoker.
        // Register source manager so the core can list/remove/refresh our sources
        yield* ctx.sources.addManager({
          kind: "openapi",

          list: () =>
            operationStore.listSources().pipe(
              Effect.map((metas) =>
                metas.map(
                  (s) =>
                    new Source({
                      id: s.namespace,
                      name: s.name,
                      kind: "openapi",
                      url: s.config.baseUrl,
                      runtime: false,
                      canRemove: true,
                      canRefresh: false,
                      canEdit: true,
                    }),
                ),
              ),
            ),

          remove: (sourceId: string) =>
            Effect.gen(function* () {
              yield* operationStore.removeByNamespace(sourceId);
              yield* operationStore.removeSource(sourceId);
              yield* ctx.tools.unregisterBySource(sourceId);
            }),

          detect: (url: string) =>
            Effect.gen(function* () {
              const trimmed = url.trim();
              if (!trimmed) return null;
              const parsed = yield* Effect.try(() => new URL(trimmed)).pipe(Effect.option);
              if (parsed._tag === "None") return null;

              // Try fetching the URL and parsing as OpenAPI spec
              // parse() handles both URLs directly and spec text
              const doc = yield* parse(trimmed).pipe(Effect.catchAll(() => Effect.succeed(null)));
              if (!doc) return null;

              const result = yield* extract(doc).pipe(Effect.catchAll(() => Effect.succeed(null)));
              if (!result) return null;

              const namespace = Option.getOrElse(result.title, () => "api")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_");
              const name = Option.getOrElse(result.title, () => namespace);

              return new SourceDetectionResult({
                kind: "openapi",
                confidence: "high",
                endpoint: trimmed,
                name,
                namespace,
              });
            }),
        });

        const addSpecInternal = (config: OpenApiSpecConfig) =>
          Effect.gen(function* () {
            const doc = yield* parse(config.spec);
            const result = yield* extract(doc);

            const namespace =
              config.namespace ??
              Option.getOrElse(result.title, () => "api")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_");

            if (doc.components?.schemas) {
              // Normalize OpenAPI $ref format to standard JSON Schema $defs
              const defs: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(doc.components.schemas)) {
                defs[k] = normalizeOpenApiRefs(v);
              }
              yield* ctx.tools.registerDefinitions(defs);
            }

            const baseUrl = config.baseUrl ?? resolveBaseUrl(result.servers);
            const oauth2 = config.oauth2 ?? null;
            const invocationConfig = new InvocationConfig({
              baseUrl,
              headers: config.headers ?? {},
              oauth2: oauth2 ? Option.some(oauth2) : Option.none(),
            });

            const definitions = compileToolDefinitions(result.operations);

            const registrations = definitions.map((def) => toRegistration(def, namespace));

            yield* operationStore.put(
              definitions.map((def) => ({
                toolId: ToolId.make(`${namespace}.${def.toolPath}`),
                namespace,
                binding: toBinding(def),
              })),
            );

            yield* ctx.tools.register(registrations);

            const sourceName = config.name ?? Option.getOrElse(result.title, () => namespace);
            yield* operationStore.putSource({
              namespace,
              name: sourceName,
              config: {
                spec: config.spec,
                baseUrl: config.baseUrl,
                namespace: config.namespace,
                headers: config.headers,
                oauth2: oauth2 ?? undefined,
              },
              invocationConfig,
            });

            return { sourceId: namespace, toolCount: registrations.length };
          });

        const runtimeTools = yield* registerRuntimeTools({
          registry: ctx.tools,
          sources: ctx.sources,
          pluginKey: "openapi",
          source: {
            id: "built-in",
            name: "Built In",
            kind: "built-in",
          },
          tools: [
            runtimeTool({
              id: "openapi.previewSpec",
              name: "openapi.previewSpec",
              description: "Preview an OpenAPI document before adding it as a source",
              inputSchema: PreviewSpecInputSchema,
              outputSchema: SpecPreview,
              handler: ({ spec }: PreviewSpecInput) => previewSpec(spec),
            }),
            runtimeTool({
              id: "openapi.addSource",
              name: "openapi.addSource",
              description: "Add an OpenAPI source and register its operations as tools",
              inputSchema: AddSourceInputSchema,
              outputSchema: AddSourceOutputSchema,
              handler: (input: AddSourceInput) => addSpecInternal(input),
            }),
          ],
        });

        const storeSecretFromTokens = (args: {
          readonly idPrefix: string;
          readonly name: string;
          readonly value: string;
          readonly purpose: string;
        }) =>
          ctx.secrets
            .set({
              id: SecretId.make(`${args.idPrefix}_${randomUUID().slice(0, 8)}`),
              scopeId: ctx.scope.id,
              name: args.name,
              value: args.value,
              purpose: args.purpose,
            })
            .pipe(Effect.map((ref) => ({ id: ref.id as string })));

        return {
          extension: {
            previewSpec: (specText: string) => previewSpec(specText),

            addSpec: (config: OpenApiSpecConfig) =>
              addSpecInternal(config).pipe(Effect.map(({ toolCount }) => ({ toolCount }))),

            removeSpec: (namespace: string) =>
              Effect.gen(function* () {
                const toolIds = yield* operationStore.removeByNamespace(namespace);
                if (toolIds.length > 0) {
                  yield* ctx.tools.unregister(toolIds);
                }
                yield* operationStore.removeSource(namespace);
              }),

            getSource: (namespace: string) => operationStore.getSource(namespace),

            updateSource: (namespace: string, input: OpenApiUpdateSourceInput) =>
              Effect.gen(function* () {
                const existing = yield* operationStore.getSource(namespace);
                if (!existing) return;

                const updatedConfig = {
                  ...existing.config,
                  ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
                  ...(input.headers !== undefined
                    ? { headers: input.headers as Record<string, HeaderValueValue> }
                    : {}),
                };

                const newInvocationConfig = new InvocationConfig({
                  baseUrl: updatedConfig.baseUrl ?? existing.invocationConfig.baseUrl,
                  headers: (updatedConfig.headers ?? {}) as Record<string, HeaderValueValue>,
                  oauth2: existing.invocationConfig.oauth2,
                });

                yield* operationStore.putSource({
                  namespace,
                  name: input.name?.trim() || existing.name,
                  config: updatedConfig,
                  invocationConfig: newInvocationConfig,
                });
              }),

            startOAuth: (input: OpenApiStartOAuthInput) =>
              Effect.gen(function* () {
                const sessionId = randomUUID();
                const codeVerifier = createPkceCodeVerifier();
                const scopesArray = [...input.scopes];

                yield* operationStore.putOAuthSession(
                  sessionId,
                  new OpenApiOAuthSession({
                    displayName: input.displayName,
                    securitySchemeName: input.securitySchemeName,
                    flow: input.flow,
                    tokenUrl: input.tokenUrl,
                    redirectUrl: input.redirectUrl,
                    clientIdSecretId: input.clientIdSecretId,
                    clientSecretSecretId: input.clientSecretSecretId ?? null,
                    scopes: scopesArray,
                    codeVerifier,
                  }),
                );

                const clientId = yield* ctx.secrets
                  .resolve(SecretId.make(input.clientIdSecretId), ctx.scope.id)
                  .pipe(
                    Effect.mapError(
                      (error) => new OpenApiOAuthError({ message: error.message }),
                    ),
                  );

                const authorizationUrl = buildAuthorizationUrl({
                  authorizationUrl: input.authorizationUrl,
                  clientId,
                  redirectUrl: input.redirectUrl,
                  scopes: scopesArray,
                  state: sessionId,
                  codeVerifier,
                });

                return {
                  sessionId,
                  authorizationUrl,
                  scopes: scopesArray,
                };
              }),

            completeOAuth: (input: OpenApiCompleteOAuthInput) =>
              Effect.gen(function* () {
                const session = yield* operationStore.getOAuthSession(input.state);
                if (!session) {
                  return yield* new OpenApiOAuthError({
                    message: "OAuth session not found or has expired",
                  });
                }
                yield* operationStore.deleteOAuthSession(input.state);

                if (input.error) {
                  return yield* new OpenApiOAuthError({ message: input.error });
                }
                if (!input.code) {
                  return yield* new OpenApiOAuthError({
                    message: "OAuth callback did not include an authorization code",
                  });
                }

                const clientId = yield* ctx.secrets
                  .resolve(SecretId.make(session.clientIdSecretId), ctx.scope.id)
                  .pipe(
                    Effect.mapError(
                      (error) => new OpenApiOAuthError({ message: error.message }),
                    ),
                  );

                const clientSecret = session.clientSecretSecretId
                  ? yield* ctx.secrets
                      .resolve(SecretId.make(session.clientSecretSecretId), ctx.scope.id)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new OpenApiOAuthError({ message: error.message }),
                        ),
                      )
                  : null;

                const tokenResponse: OAuth2TokenResponse = yield* exchangeAuthorizationCode(
                  {
                    tokenUrl: session.tokenUrl,
                    clientId,
                    clientSecret,
                    redirectUrl: session.redirectUrl,
                    codeVerifier: session.codeVerifier,
                    code: input.code,
                  },
                ).pipe(
                  Effect.mapError(
                    (error) => new OpenApiOAuthError({ message: error.message }),
                  ),
                );

                const slug = session.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_");

                const stored = yield* storeOAuthTokens({
                  tokens: tokenResponse,
                  slug: `${slug}_openapi`,
                  displayName: session.displayName,
                  accessTokenPurpose: "openapi_oauth_access_token",
                  refreshTokenPurpose: "openapi_oauth_refresh_token",
                  createSecret: storeSecretFromTokens,
                }).pipe(
                  Effect.mapError(
                    (error) => new OpenApiOAuthError({ message: error.message }),
                  ),
                );

                return new OAuth2Auth({
                  kind: "oauth2",
                  securitySchemeName: session.securitySchemeName,
                  flow: session.flow,
                  tokenUrl: session.tokenUrl,
                  clientIdSecretId: session.clientIdSecretId,
                  clientSecretSecretId: session.clientSecretSecretId,
                  accessTokenSecretId: stored.accessTokenSecretId,
                  refreshTokenSecretId: stored.refreshTokenSecretId,
                  tokenType: stored.tokenType,
                  expiresAt: stored.expiresAt,
                  scope: stored.scope,
                  scopes: [...session.scopes],
                });
              }),
          },

          close: () => runtimeTools.close(),
        };
      }),
  });
};
