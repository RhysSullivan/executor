import { Effect, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import type { Layer } from "effect";

import {
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
  /** Refresh the source's stored OAuth2 metadata after a successful
   *  re-authenticate. */
  readonly oauth2?: OAuth2Auth;
}

// ---------------------------------------------------------------------------
// OAuth2 onboarding inputs / outputs — callers pre-decide identity knobs
// (display name, scheme name, scopes, target scope) and the SDK mints a
// Connection when the flow completes. The caller receives an OAuth2Auth
// carrying just the resulting connection id.
// ---------------------------------------------------------------------------

interface StartOAuthIdentity {
  readonly displayName: string;
  readonly securitySchemeName: string;
  readonly clientIdSecretId: string;
  readonly scopes: readonly string[];
  /** Stable logical Connection id this source should resolve at invoke time.
   *  Physical ownership still comes from `tokenScope`; the same id can
   *  have separate rows at user/org scopes. Defaults to the legacy
   *  source-derived id for compatibility. */
  readonly connectionId?: string;
  /**
   * Source (namespace) the resulting Connection will back. Used as the
   * compatibility default for the stable Connection *name* so repeat
   * sign-ins refresh a single row per scope instead of spawning a
   * fresh UUID every click:
   *
   *   clientCredentials → `openapi-oauth2-app-${sourceId}`
   *   authorizationCode → `openapi-oauth2-user-${sourceId}`
   *
   * The resulting Connection is written at the innermost executor
   * scope so per-user credentials (secrets shadowed at user scope via
   * `ctx.secrets.get`'s scope-stacked resolution) and per-user consent
   * (authorizationCode) both produce per-user rows. Because
   * `findInnermostConnectionRow` resolves by id across the caller's
   * stack, the single `source.oauth2.connectionId` string on a shared
   * org source still lets every user reach their own physical row.
   */
  readonly sourceId: string;
  /** Executor scope that will own the resulting Connection (and its
   *  backing token secrets). Defaults to `ctx.scopes[0].id`. Callers
   *  can override to write at a different stack scope (e.g. an admin
   *  writing an org-wide shared connection). */
  readonly tokenScope?: string;
}

const defaultOAuthConnectionId = (
  flow: "authorizationCode" | "clientCredentials",
  sourceId: string,
): string =>
  flow === "clientCredentials"
    ? `openapi-oauth2-app-${sourceId}`
    : `openapi-oauth2-user-${sourceId}`;

export interface StartAuthorizationCodeOAuthInput extends StartOAuthIdentity {
  readonly flow: "authorizationCode";
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly redirectUrl: string;
  readonly clientSecretSecretId?: string | null;
}

/**
 * RFC 6749 §4.4 has no user-interactive step. `startOAuth` exchanges
 * tokens inline, creates the Connection, and returns a completed
 * `OAuth2Auth` pointing at it. No `authorizationUrl`, no session row,
 * no `completeOAuth`.
 */
export interface StartClientCredentialsOAuthInput extends StartOAuthIdentity {
  readonly flow: "clientCredentials";
  readonly tokenUrl: string;
  /** RFC 6749 §2.3.1 — client_credentials is unusable without the secret. */
  readonly clientSecretSecretId: string;
}

export type OpenApiStartOAuthInput =
  | StartAuthorizationCodeOAuthInput
  | StartClientCredentialsOAuthInput;

export interface StartAuthorizationCodeOAuthResponse {
  readonly flow: "authorizationCode";
  readonly sessionId: string;
  readonly authorizationUrl: string;
  readonly scopes: readonly string[];
}

export interface StartClientCredentialsOAuthResponse {
  readonly flow: "clientCredentials";
  /** Completed auth ready to attach to the source's `OAuth2Auth`. */
  readonly auth: OAuth2Auth;
  readonly scopes: readonly string[];
}

export type OpenApiStartOAuthResponse =
  | StartAuthorizationCodeOAuthResponse
  | StartClientCredentialsOAuthResponse;

export interface OpenApiCompleteOAuthInput {
  readonly state: string;
  readonly code?: string;
  readonly error?: string;
}

/** Shape returned by `completeOAuth`. The minted Connection's id is
 *  all the caller needs to stitch together an `OAuth2Auth` value — the
 *  UI already has the securityScheme metadata from the matching
 *  `startOAuth` call. */
export interface OpenApiCompleteOAuthResponse {
  readonly connectionId: string;
  readonly expiresAt: number | null;
  readonly scope: string | null;
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
  ) => Effect.Effect<OpenApiCompleteOAuthResponse, OpenApiOAuthError>;
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

// Connection refresh for oauth2-minted sources is owned by the
// canonical `"oauth2"` ConnectionProvider registered by the core
// `makeOAuth2Service`. The plugin no longer needs its own provider-
// state schema, refresh handler, or session storage.

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
              oauth2: input.oauth2,
            }),

          // Thin forwarders over `ctx.oauth.*`. The core service owns
          // session storage, the code exchange, the Connection mint,
          // and refresh via the canonical `"oauth2"` ConnectionProvider.
          // The plugin maps OpenAPI's `flow` string + secret refs onto
          // the strategy discriminated union the service accepts.
          startOAuth: (input) =>
            Effect.gen(function* () {
              const scopesArray = [...input.scopes];
              // Innermost = user scope in a stacked [user, org] executor.
              // Both flows write at the innermost scope so per-user
              // credentials (secrets shadowed at user scope) and per-user
              // authorization codes each produce a per-user connection
              // row. `source.oauth2.connectionId` is a single *name* —
              // `findInnermostConnectionRow` walks each caller's stack
              // to resolve the right physical row.
              const innermostScope = ctx.scopes[0]!.id as string;
              const tokenScope = input.tokenScope ?? innermostScope;
              const connectionId =
                input.connectionId ??
                defaultOAuthConnectionId(input.flow, input.sourceId);
              const oauthService = ctx.oauth;
              if (!oauthService) {
                return yield* new OpenApiOAuthError({
                  message: "ctx.oauth not wired",
                });
              }

              const strategy =
                input.flow === "clientCredentials"
                  ? ({
                      kind: "client-credentials" as const,
                      tokenEndpoint: input.tokenUrl,
                      clientIdSecretId: input.clientIdSecretId,
                      clientSecretSecretId: input.clientSecretSecretId,
                      scopes: scopesArray,
                    })
                  : ({
                      kind: "authorization-code" as const,
                      authorizationEndpoint: input.authorizationUrl,
                      tokenEndpoint: input.tokenUrl,
                      clientIdSecretId: input.clientIdSecretId,
                      clientSecretSecretId: input.clientSecretSecretId ?? null,
                      scopes: scopesArray,
                    });

              const result = yield* oauthService
                .start({
                  endpoint: input.tokenUrl,
                  // client-credentials doesn't redirect — pass the
                  // plugin's own placeholder URL so the service can
                  // still persist + surface it. For authorizationCode
                  // we use the caller-supplied value.
                  redirectUrl:
                    input.flow === "authorizationCode"
                      ? input.redirectUrl
                      : input.tokenUrl,
                  connectionId,
                  tokenScope,
                  strategy,
                  pluginId: "openapi",
                })
                .pipe(
                  Effect.mapError((err) =>
                    err._tag === "OAuthStartError"
                      ? new OpenApiOAuthError({ message: err.message })
                      : new OpenApiOAuthError({
                          message:
                            "message" in err
                              ? (err as { message: string }).message
                              : String(err),
                        }),
                  ),
                );

              if (input.flow === "clientCredentials") {
                // `client-credentials` mints the Connection inline — no
                // session row, no browser step. Return the same
                // `OAuth2Auth` shape the UI expects so it can stamp the
                // source atomically.
                const auth = new OAuth2Auth({
                  kind: "oauth2",
                  connectionId,
                  securitySchemeName: input.securitySchemeName,
                  flow: "clientCredentials",
                  tokenUrl: input.tokenUrl,
                  authorizationUrl: null,
                  clientIdSecretId: input.clientIdSecretId,
                  clientSecretSecretId: input.clientSecretSecretId ?? null,
                  scopes: scopesArray,
                });
                return {
                  flow: "clientCredentials" as const,
                  auth,
                  scopes: scopesArray,
                };
              }

              if (result.authorizationUrl === null) {
                return yield* new OpenApiOAuthError({
                  message:
                    "OAuth service did not emit an authorization URL for the authorizationCode flow",
                });
              }
              return {
                flow: "authorizationCode" as const,
                sessionId: result.sessionId,
                authorizationUrl: result.authorizationUrl,
                scopes: scopesArray,
              };
            }),

          completeOAuth: (input) =>
            Effect.gen(function* () {
              const oauthService = ctx.oauth;
              if (!oauthService) {
                return yield* new OpenApiOAuthError({
                  message: "ctx.oauth not wired",
                });
              }
              const completed = yield* oauthService
                .complete({
                  state: input.state,
                  code: input.code,
                  error: input.error,
                })
                .pipe(
                  Effect.mapError((err) =>
                    new OpenApiOAuthError({
                      message:
                        err._tag === "OAuthSessionNotFoundError"
                          ? "OAuth session not found or has expired"
                          : "message" in err
                          ? (err as { message: string }).message
                          : String(err),
                    }),
                  ),
                );
              return {
                connectionId: completed.connectionId,
                expiresAt: completed.expiresAt,
                scope: completed.scope,
              } satisfies OpenApiCompleteOAuthResponse;
            }),
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

          // If the source has OAuth2 auth, resolve a guaranteed-fresh
          // access token from the backing Connection and inject the
          // Authorization header (wins over a manually-set one). All the
          // refresh complexity lives in the SDK — the plugin just asks.
          if (Option.isSome(config.oauth2)) {
            const auth = config.oauth2.value;
            const accessToken = yield* ctx.connections
              .accessToken(auth.connectionId)
              .pipe(
                Effect.mapError(
                  (err) =>
                    new Error(
                      `OAuth connection resolution failed: ${
                        "message" in err
                          ? (err as { message: string }).message
                          : String(err)
                      }`,
                    ),
                ),
              );
            resolvedHeaders["Authorization"] = `Bearer ${accessToken}`;
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

      // Connection refresh for oauth2-minted sources is owned by the
      // canonical `"oauth2"` ConnectionProvider registered by core.
    };
  },
);
