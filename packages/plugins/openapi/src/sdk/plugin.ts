import { randomUUID } from "node:crypto";

import { Effect, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import type { Layer } from "effect";

import {
  buildAuthorizationUrl,
  createPkceCodeVerifier,
  exchangeAuthorizationCode,
  withRefreshedAccessToken,
  type OAuth2TokenResponse,
} from "@executor/plugin-oauth2";

import {
  ScopeId,
  SecretId,
  SetSecretInput,
  SourceDetectionResult,
  definePlugin,
  type PluginCtx,
  type StorageFailure,
  type ToolAnnotations,
  type ToolRow,
} from "@executor/sdk";

import {
  headersToConfigValues,
  type ConfigFileSink,
  type OpenApiSourceConfig,
} from "@executor/config";

import {
  OpenApiExtractionError,
  OpenApiOAuthError,
  OpenApiParseError,
} from "./errors";
import { parse, resolveSpecText } from "./parse";
import { extract } from "./extract";
import { compileToolDefinitions, type ToolDefinition } from "./definitions";
import {
  annotationsForOperation,
  invokeWithLayer,
  resolveHeaders,
} from "./invoke";
import { resolveBaseUrl } from "./openapi-utils";
import { previewSpec, SpecPreview } from "./preview";
import {
  makeDefaultOpenapiStore,
  openapiSchema,
  type OpenapiStore,
  type SourceConfig,
  type StoredOperation,
  type StoredSource,
} from "./store";
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

export type HeaderValue = HeaderValueValue;

export interface OpenApiSpecConfig {
  readonly spec: string;
  /**
   * Executor scope id that owns this source row. Must be one of the
   * executor's configured scopes. Typical shape: an admin adds the
   * source at the outermost (organization) scope so it's visible to
   * every inner (per-user) scope via fall-through reads.
   */
  readonly scope: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly namespace?: string;
  readonly headers?: Record<string, HeaderValue>;
  readonly oauth2?: OAuth2Auth;
}

export interface OpenApiUpdateSourceInput {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly headers?: Record<string, HeaderValue>;
}

// ---------------------------------------------------------------------------
// OAuth2 onboarding inputs / outputs
// ---------------------------------------------------------------------------

export interface OpenApiStartOAuthInput {
  readonly displayName: string;
  readonly securitySchemeName: string;
  readonly flow: "authorizationCode";
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly redirectUrl: string;
  readonly clientIdSecretId: string;
  readonly clientSecretSecretId?: string | null;
  readonly scopes: readonly string[];
  /**
   * Executor scope id where the minted access/refresh tokens will land
   * on completeOAuth. Defaults to `ctx.scopes[0].id` (the innermost
   * scope) — which for a single-scope executor is the only scope, and
   * for a stacked executor pins tokens to the per-user scope so
   * org-level shadowing works by id.
   */
  readonly tokenScope?: string;
  /**
   * Pre-decided secret ids for the minted access + refresh tokens. Use
   * deterministic ids (e.g. `${namespace}_access_token`) so the source's
   * stored `OAuth2Auth` can reference them and `ctx.secrets.get` resolves
   * via scope fall-through — per-user tokens shadow org-level fallbacks
   * on the same source.
   */
  readonly accessTokenSecretId: string;
  readonly refreshTokenSecretId?: string | null;
}

export interface OpenApiStartOAuthResponse {
  readonly sessionId: string;
  readonly authorizationUrl: string;
  readonly scopes: readonly string[];
}

export interface OpenApiCompleteOAuthInput {
  readonly state: string;
  readonly code?: string;
  readonly error?: string;
}

/**
 * Errors any OpenAPI extension method may surface. The first three are
 * plugin-domain tagged errors that flow directly to clients (4xx, each
 * carrying its own `HttpApiSchema` status). `StorageFailure` covers
 * raw backend failures (`StorageError`) plus `UniqueViolationError`;
 * the HTTP edge (`@executor/api`'s `withCapture`) translates
 * `StorageError` to the opaque `InternalError({ traceId })` at Layer
 * composition. `UniqueViolationError` passes through — plugins can
 * `Effect.catchTag` it if they want a friendlier user-facing error.
 */
export type OpenApiExtensionFailure =
  | OpenApiParseError
  | OpenApiExtractionError
  | OpenApiOAuthError
  | StorageFailure;

export interface OpenApiPluginExtension {
  readonly previewSpec: (
    specText: string,
  ) => Effect.Effect<SpecPreview, OpenApiParseError | OpenApiExtractionError>;
  readonly addSpec: (
    config: OpenApiSpecConfig,
  ) => Effect.Effect<
    { readonly sourceId: string; readonly toolCount: number },
    OpenApiParseError | OpenApiExtractionError | StorageFailure
  >;
  readonly removeSpec: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;
  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<StoredSource | null, StorageFailure>;
  readonly updateSource: (
    namespace: string,
    scope: string,
    input: OpenApiUpdateSourceInput,
  ) => Effect.Effect<void, StorageFailure>;
  readonly startOAuth: (
    input: OpenApiStartOAuthInput,
  ) => Effect.Effect<OpenApiStartOAuthResponse, OpenApiOAuthError>;
  readonly completeOAuth: (
    input: OpenApiCompleteOAuthInput,
  ) => Effect.Effect<OAuth2Auth, OpenApiOAuthError>;
}

// ---------------------------------------------------------------------------
// Control-tool input/output schemas
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const toBinding = (def: ToolDefinition): OperationBinding =>
  new OperationBinding({
    method: def.operation.method,
    pathTemplate: def.operation.pathTemplate,
    parameters: [...def.operation.parameters],
    requestBody: def.operation.requestBody,
  });

const descriptionFor = (def: ToolDefinition): string => {
  const op = def.operation;
  return Option.getOrElse(op.description, () =>
    Option.getOrElse(op.summary, () => `${op.method.toUpperCase()} ${op.pathTemplate}`),
  );
};

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface OpenApiPluginOptions {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  /** If provided, source add/remove is mirrored to executor.jsonc
   *  (best-effort — file errors are logged, not raised). */
  readonly configFile?: ConfigFileSink;
}

const toOpenApiSourceConfig = (
  namespace: string,
  config: OpenApiSpecConfig,
): OpenApiSourceConfig => ({
  kind: "openapi",
  spec: config.spec,
  baseUrl: config.baseUrl,
  namespace,
  headers: headersToConfigValues(config.headers),
});

const isHttpUrl = (s: string): boolean =>
  s.startsWith("http://") || s.startsWith("https://");

export const openApiPlugin = definePlugin(
  (options?: OpenApiPluginOptions) => {
    const httpClientLayer = options?.httpClientLayer ?? FetchHttpClient.layer;

    type RebuildInput = {
      readonly specText: string;
      readonly scope: string;
      readonly sourceUrl?: string;
      readonly name?: string;
      readonly baseUrl?: string;
      readonly namespace?: string;
      readonly headers?: Record<string, HeaderValue>;
      readonly oauth2?: OAuth2Auth;
    };

    // ctx comes from the plugin runtime — the same instance is passed to
    // `extension(ctx)` and to every lifecycle hook (`refreshSource`, etc.),
    // so helpers parameterised on ctx can be called from either surface.
    const rebuildSource = (
      ctx: PluginCtx<OpenapiStore>,
      input: RebuildInput,
    ) =>
      Effect.gen(function* () {
        const doc = yield* parse(input.specText);
        const result = yield* extract(doc);

        const namespace =
          input.namespace ??
          Option.getOrElse(result.title, () => "api")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_");

        const hoistedDefs: Record<string, unknown> = {};
        if (doc.components?.schemas) {
          for (const [k, v] of Object.entries(doc.components.schemas)) {
            hoistedDefs[k] = normalizeOpenApiRefs(v);
          }
        }

        const baseUrl = input.baseUrl ?? resolveBaseUrl(result.servers);
        const oauth2 = input.oauth2 ?? undefined;
        const invocationConfig = new InvocationConfig({
          baseUrl,
          headers: input.headers ?? {},
          oauth2: oauth2 ? Option.some(oauth2) : Option.none(),
        });

        const definitions = compileToolDefinitions(result.operations);
        const sourceName =
          input.name ?? Option.getOrElse(result.title, () => namespace);

        const sourceConfig: SourceConfig = {
          spec: input.specText,
          sourceUrl: input.sourceUrl,
          baseUrl: input.baseUrl,
          namespace: input.namespace,
          headers: input.headers,
          oauth2,
        };

        const storedSource: StoredSource = {
          namespace,
          scope: input.scope,
          name: sourceName,
          config: sourceConfig,
          invocationConfig,
        };

        const storedOps: StoredOperation[] = definitions.map((def) => ({
          toolId: `${namespace}.${def.toolPath}`,
          sourceId: namespace,
          binding: toBinding(def),
        }));

        yield* ctx.transaction(
          Effect.gen(function* () {
            yield* ctx.storage.upsertSource(storedSource, storedOps);

            yield* ctx.core.sources.register({
              id: namespace,
              scope: input.scope,
              kind: "openapi",
              name: sourceName,
              url: baseUrl || undefined,
              canRemove: true,
              // `canRefresh` reflects whether we still know the
              // origin URL — sources added from raw spec text have
              // nothing to re-fetch, so refresh stays disabled.
              canRefresh: input.sourceUrl != null,
              canEdit: true,
              tools: definitions.map((def) => ({
                name: def.toolPath,
                description: descriptionFor(def),
                inputSchema: normalizeOpenApiRefs(
                  Option.getOrUndefined(def.operation.inputSchema),
                ),
                outputSchema: normalizeOpenApiRefs(
                  Option.getOrUndefined(def.operation.outputSchema),
                ),
              })),
            });

            if (Object.keys(hoistedDefs).length > 0) {
              yield* ctx.core.definitions.register({
                sourceId: namespace,
                scope: input.scope,
                definitions: hoistedDefs,
              });
            }
          }),
        );

        return { sourceId: namespace, toolCount: definitions.length };
      });

    // No-op for missing sources and for sources added from raw spec
    // text (no URL to re-fetch from). UIs gate the action via
    // `canRefresh` on the source row; reaching here without a URL
    // means the caller bypassed that gate, so we stay quiet rather
    // than surface a 500 through the unwhitelisted error channel.
    const refreshSourceInternal = (
      ctx: PluginCtx<OpenapiStore>,
      sourceId: string,
      scope: string,
    ) =>
      Effect.gen(function* () {
        const existing = yield* ctx.storage.getSource(sourceId, scope);
        if (!existing) return;
        const sourceUrl = existing.config.sourceUrl;
        if (!sourceUrl) return;
        const specText = yield* resolveSpecText(sourceUrl).pipe(
          Effect.provide(httpClientLayer),
        );
        yield* rebuildSource(ctx, {
          specText,
          scope,
          sourceUrl,
          name: existing.name,
          baseUrl: existing.config.baseUrl,
          namespace: existing.namespace,
          headers: existing.config.headers,
          oauth2: existing.config.oauth2,
        });
      });

    return {
      id: "openapi" as const,
      schema: openapiSchema,
      storage: (deps): OpenapiStore => makeDefaultOpenapiStore(deps),

      extension: (ctx) => {
        // Write a token secret at a caller-pinned id and scope. The
        // session persisted by `startOAuth` names both, so the plugin
        // never picks them itself — that keeps shadowing by id
        // deterministic (user scope overrides org scope for the same
        // secret id) instead of minting random suffixes per completion.
        const writeOAuthSecret = (args: {
          readonly id: string;
          readonly scope: string;
          readonly name: string;
          readonly value: string;
        }) =>
          ctx.secrets
            .set(
              new SetSecretInput({
                id: SecretId.make(args.id),
                scope: ScopeId.make(args.scope),
                name: args.name,
                value: args.value,
              }),
            )
            .pipe(Effect.map((ref) => ({ id: ref.id as string })));

        const addSpecInternal = (config: OpenApiSpecConfig) =>
          Effect.gen(function* () {
            // Resolve URL → text and parse BEFORE opening a transaction.
            // Holding `BEGIN` on the pool=1 Postgres connection across a
            // network fetch is the Hyperdrive deadlock path in production.
            const specText = yield* resolveSpecText(config.spec).pipe(
              Effect.provide(httpClientLayer),
            );
            return yield* rebuildSource(ctx, {
              specText,
              scope: config.scope,
              sourceUrl: isHttpUrl(config.spec) ? config.spec : undefined,
              name: config.name,
              baseUrl: config.baseUrl,
              namespace: config.namespace,
              headers: config.headers,
              oauth2: config.oauth2,
            });
          });

        const configFile = options?.configFile;

        return {
          previewSpec: (specText) =>
            previewSpec(specText).pipe(Effect.provide(httpClientLayer)),

          addSpec: (config) =>
            Effect.gen(function* () {
              const result = yield* addSpecInternal(config);
              if (configFile) {
                yield* configFile.upsertSource(
                  toOpenApiSourceConfig(result.sourceId, config),
                );
              }
              return result;
            }),

          removeSpec: (namespace, scope) =>
            Effect.gen(function* () {
              yield* ctx.transaction(
                Effect.gen(function* () {
                  yield* ctx.storage.removeSource(namespace, scope);
                  yield* ctx.core.sources.unregister(namespace);
                }),
              );
              if (configFile) {
                yield* configFile.removeSource(namespace);
              }
            }),

          getSource: (namespace, scope) => ctx.storage.getSource(namespace, scope),

          updateSource: (namespace, scope, input) =>
            ctx.storage.updateSourceMeta(namespace, scope, {
              name: input.name?.trim() || undefined,
              baseUrl: input.baseUrl,
              headers: input.headers,
            }),

          startOAuth: (input) =>
            Effect.gen(function* () {
              const sessionId = randomUUID();
              const codeVerifier = createPkceCodeVerifier();
              const scopesArray = [...input.scopes];
              const tokenScope = input.tokenScope ?? (ctx.scopes[0]!.id as string);

              yield* ctx.storage
                .putOAuthSession(
                  sessionId,
                  new OpenApiOAuthSession({
                    displayName: input.displayName,
                    securitySchemeName: input.securitySchemeName,
                    flow: input.flow,
                    tokenUrl: input.tokenUrl,
                    redirectUrl: input.redirectUrl,
                    clientIdSecretId: input.clientIdSecretId,
                    clientSecretSecretId: input.clientSecretSecretId ?? null,
                    tokenScope,
                    accessTokenSecretId: input.accessTokenSecretId,
                    refreshTokenSecretId: input.refreshTokenSecretId ?? null,
                    scopes: scopesArray,
                    codeVerifier,
                  }),
                )
                .pipe(
                  Effect.mapError((err) => new OpenApiOAuthError({ message: err.message })),
                );

              const clientId = yield* ctx.secrets.get(input.clientIdSecretId).pipe(
                Effect.mapError((err) => new OpenApiOAuthError({ message: err.message })),
              );
              if (clientId === null) {
                return yield* new OpenApiOAuthError({
                  message: `Missing client ID secret: ${input.clientIdSecretId}`,
                });
              }

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

          completeOAuth: (input) =>
            ctx.transaction(
              Effect.gen(function* () {
                const session = yield* ctx.storage.getOAuthSession(input.state).pipe(
                  Effect.mapError((err) => new OpenApiOAuthError({ message: err.message })),
                );
                if (!session) {
                  return yield* new OpenApiOAuthError({
                    message: "OAuth session not found or has expired",
                  });
                }
                yield* ctx.storage.deleteOAuthSession(input.state).pipe(
                  Effect.mapError((err) => new OpenApiOAuthError({ message: err.message })),
                );

                if (input.error) {
                  return yield* new OpenApiOAuthError({ message: input.error });
                }
                if (!input.code) {
                  return yield* new OpenApiOAuthError({
                    message: "OAuth callback did not include an authorization code",
                  });
                }

                const clientId = yield* ctx.secrets.get(session.clientIdSecretId).pipe(
                  Effect.mapError((err) => new OpenApiOAuthError({ message: err.message })),
                );
                if (clientId === null) {
                  return yield* new OpenApiOAuthError({
                    message: `Missing client ID secret: ${session.clientIdSecretId}`,
                  });
                }

                const clientSecret = session.clientSecretSecretId
                  ? yield* ctx.secrets.get(session.clientSecretSecretId).pipe(
                      Effect.mapError(
                        (err) => new OpenApiOAuthError({ message: err.message }),
                      ),
                    )
                  : null;

                const tokenResponse: OAuth2TokenResponse =
                  yield* exchangeAuthorizationCode({
                    tokenUrl: session.tokenUrl,
                    clientId,
                    clientSecret,
                    redirectUrl: session.redirectUrl,
                    codeVerifier: session.codeVerifier,
                    code: input.code,
                  }).pipe(
                    Effect.mapError(
                      (err) => new OpenApiOAuthError({ message: err.message }),
                    ),
                  );

                // Write tokens at the exact id + scope named by the
                // session. Shadowing by id (per-user scope wins over
                // org fall-through) is what makes a single stored
                // `OAuth2Auth` on the source resolve to per-user
                // values at invoke time.
                const accessRef = yield* writeOAuthSecret({
                  id: session.accessTokenSecretId,
                  scope: session.tokenScope,
                  name: `${session.displayName} Access Token`,
                  value: tokenResponse.access_token,
                }).pipe(
                  Effect.mapError(
                    (err) => new OpenApiOAuthError({ message: err.message }),
                  ),
                );

                let refreshSecretId: string | null = null;
                if (
                  tokenResponse.refresh_token &&
                  session.refreshTokenSecretId
                ) {
                  const refreshRef = yield* writeOAuthSecret({
                    id: session.refreshTokenSecretId,
                    scope: session.tokenScope,
                    name: `${session.displayName} Refresh Token`,
                    value: tokenResponse.refresh_token,
                  }).pipe(
                    Effect.mapError(
                      (err) => new OpenApiOAuthError({ message: err.message }),
                    ),
                  );
                  refreshSecretId = refreshRef.id;
                }

                const expiresAt =
                  typeof tokenResponse.expires_in === "number"
                    ? Date.now() + tokenResponse.expires_in * 1000
                    : null;

                return new OAuth2Auth({
                  kind: "oauth2",
                  securitySchemeName: session.securitySchemeName,
                  flow: session.flow,
                  tokenUrl: session.tokenUrl,
                  clientIdSecretId: session.clientIdSecretId,
                  clientSecretSecretId: session.clientSecretSecretId,
                  accessTokenSecretId: accessRef.id,
                  refreshTokenSecretId: refreshSecretId,
                  tokenType: tokenResponse.token_type ?? "Bearer",
                  expiresAt,
                  scope: tokenResponse.scope ?? null,
                  scopes: [...session.scopes],
                });
              }),
            ).pipe(
              Effect.mapError((err) =>
                err instanceof OpenApiOAuthError
                  ? err
                  : new OpenApiOAuthError({ message: err.message }),
              ),
            ),
        } satisfies OpenApiPluginExtension;
      },

      staticSources: (self) => [
        {
          id: "openapi",
          kind: "control",
          name: "OpenAPI",
          tools: [
            {
              name: "previewSpec",
              description:
                "Preview an OpenAPI document before adding it as a source",
              inputSchema: {
                type: "object",
                properties: { spec: { type: "string" } },
                required: ["spec"],
              },
              handler: ({ args }) =>
                self.previewSpec((args as PreviewSpecInput).spec),
            },
            {
              name: "addSource",
              description:
                "Add an OpenAPI source and register its operations as tools",
              inputSchema: {
                type: "object",
                properties: {
                  spec: { type: "string" },
                  baseUrl: { type: "string" },
                  namespace: { type: "string" },
                  headers: { type: "object" },
                },
                required: ["spec"],
              },
              outputSchema: {
                type: "object",
                properties: {
                  sourceId: { type: "string" },
                  toolCount: { type: "number" },
                },
                required: ["sourceId", "toolCount"],
              },
              // Static-tool callers don't name a scope. Default to the
              // outermost scope in the executor's stack — for a single-
              // scope executor that's the only scope; for a per-user
              // stack `[user, org]` it writes at `org` so the source is
              // visible across every user.
              handler: ({ ctx, args }) =>
                self.addSpec({
                  ...(args as AddSourceInput),
                  scope: ctx.scopes.at(-1)!.id as string,
                }),
            },
          ],
        },
      ],

      invokeTool: ({ ctx, toolRow, args }) =>
        Effect.gen(function* () {
          // toolRow.scope_id is the resolved owning scope of the tool
          // (innermost-wins from the executor's stack). The matching
          // openapi_operation + openapi_source rows live at the same
          // scope, so pin every store lookup to it instead of relying
          // on the scoped adapter's stack-wide fall-through.
          const toolScope = toolRow.scope_id as string;
          const op = yield* ctx.storage.getOperationByToolId(toolRow.id, toolScope);
          if (!op) {
            return yield* Effect.fail(
              new Error(`No OpenAPI operation found for tool "${toolRow.id}"`),
            );
          }
          const source = yield* ctx.storage.getSource(op.sourceId, toolScope);
          if (!source) {
            return yield* Effect.fail(
              new Error(`No OpenAPI source found for "${op.sourceId}"`),
            );
          }

          const config = source.invocationConfig;
          const resolvedHeaders = yield* resolveHeaders(
            config.headers,
            { get: ctx.secrets.get },
          );

          // If the source has OAuth2 auth, resolve/refresh access token and
          // inject Authorization header (wins over a manually-set one).
          if (Option.isSome(config.oauth2)) {
            const auth = config.oauth2.value;
            const accessToken = yield* withRefreshedAccessToken({
              auth: {
                clientIdSecretId: auth.clientIdSecretId,
                clientSecretSecretId: auth.clientSecretSecretId,
                accessTokenSecretId: auth.accessTokenSecretId,
                refreshTokenSecretId: auth.refreshTokenSecretId,
                tokenType: auth.tokenType,
                expiresAt: auth.expiresAt,
                scopes: auth.scopes,
              },
              tokenUrl: auth.tokenUrl,
              secrets: {
                resolve: (id) =>
                  ctx.secrets.get(id).pipe(
                    Effect.flatMap((v) =>
                      v === null
                        ? Effect.fail(new Error(`Missing secret: ${id}`))
                        : Effect.succeed(v),
                    ),
                  ),
                setValue: ({ secretId, value, name }) =>
                  // Refresh writes land at the innermost scope of the
                  // executor that invoked the tool. When a per-user
                  // stack calls, that's the user scope — their token
                  // shadows the org fall-through on the same id.
                  ctx.secrets
                    .set(
                      new SetSecretInput({
                        id: SecretId.make(secretId),
                        scope: ctx.scopes[0]!.id,
                        name,
                        value,
                      }),
                    )
                    .pipe(Effect.asVoid),
              },
              displayName: source.name,
              accessTokenPurpose: "openapi_oauth_access_token",
              refreshTokenPurpose: "openapi_oauth_refresh_token",
              persistAuth: (snapshot) =>
                Effect.gen(function* () {
                  const updatedOAuth = new OAuth2Auth({
                    ...auth,
                    tokenType: snapshot.tokenType,
                    expiresAt: snapshot.expiresAt,
                    scope: snapshot.scope ?? auth.scope,
                  });
                  // Pin the meta update to the source's own scope so a
                  // refreshed token snapshot can't accidentally land on
                  // a shadowed source row at another scope in the stack.
                  yield* ctx.storage.updateSourceMeta(source.namespace, source.scope, {
                    oauth2: updatedOAuth,
                  });
                }),
            }).pipe(
              Effect.mapError(
                (err) => new Error(`OAuth token refresh failed: ${err.message}`),
              ),
            );
            resolvedHeaders["Authorization"] = `${auth.tokenType || "Bearer"} ${accessToken}`;
          }

          const result = yield* invokeWithLayer(
            op.binding,
            (args ?? {}) as Record<string, unknown>,
            config.baseUrl,
            resolvedHeaders,
            httpClientLayer,
          );

          return result;
        }),

      resolveAnnotations: ({ ctx, sourceId, toolRows }) =>
        Effect.gen(function* () {
          // toolRows for a single (plugin_id, source_id) group can still
          // straddle multiple scopes when the source is shadowed (e.g. an
          // org-level openapi source plus a per-user override that
          // re-registers the same tool ids). Run one listOperationsBySource
          // per distinct scope so each lookup pins {source_id, scope_id}
          // and we don't fall through to the wrong scope's bindings.
          const scopes = new Set<string>();
          for (const row of toolRows as readonly ToolRow[]) {
            scopes.add(row.scope_id as string);
          }
          const byScope = new Map<string, Map<string, OperationBinding>>();
          for (const scope of scopes) {
            const ops = yield* ctx.storage.listOperationsBySource(sourceId, scope);
            const byId = new Map<string, OperationBinding>();
            for (const op of ops) byId.set(op.toolId, op.binding);
            byScope.set(scope, byId);
          }

          const out: Record<string, ToolAnnotations> = {};
          for (const row of toolRows as readonly ToolRow[]) {
            const binding = byScope.get(row.scope_id as string)?.get(row.id);
            if (binding) {
              out[row.id] = annotationsForOperation(binding.method, binding.pathTemplate);
            }
          }
          return out;
        }),

      removeSource: ({ ctx, sourceId, scope }) =>
        ctx.storage.removeSource(sourceId, scope),

      // Re-fetch the spec from its origin URL (captured at addSpec time)
      // and replay the same parse → extract → upsertSource → register
      // path used by addSpec. Sources without a stored URL surface a
      // typed `OpenApiParseError` — the executor only dispatches refresh
      // when `canRefresh: true`, so a raw-text source reaching here
      // means stale UI state, which is worth surfacing to the caller.
      refreshSource: ({ ctx, sourceId, scope }) =>
        refreshSourceInternal(ctx, sourceId, scope),

      detect: ({ url }) =>
        Effect.gen(function* () {
          const trimmed = url.trim();
          if (!trimmed) return null;
          const parsed = yield* Effect.try(() => new URL(trimmed)).pipe(
            Effect.option,
          );
          if (parsed._tag === "None") return null;
          const specText = yield* resolveSpecText(trimmed).pipe(
            Effect.provide(httpClientLayer),
            Effect.catchAll(() => Effect.succeed(null)),
          );
          if (specText === null) return null;
          const doc = yield* parse(specText).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          );
          if (!doc) return null;
          const result = yield* extract(doc).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          );
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
    };
  },
);
