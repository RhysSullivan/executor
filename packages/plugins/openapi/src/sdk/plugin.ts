import { randomUUID } from "node:crypto";

import { Effect, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import type { Layer } from "effect";

import {
  OAuth2Error,
  buildAuthorizationUrl,
  createPkceCodeVerifier,
  exchangeAuthorizationCode,
  exchangeClientCredentials,
  refreshAccessToken,
  type OAuth2TokenResponse,
} from "@executor/plugin-oauth2";

import {
  ConnectionId,
  ConnectionRefreshError,
  CreateConnectionInput,
  ScopeId,
  SecretId,
  SourceDetectionResult,
  TokenMaterial,
  definePlugin,
  type ConnectionProvider,
  type ConnectionRefreshInput,
  type ConnectionRefreshResult,
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
  ConfiguredHeaderBinding,
  OAuth2Auth,
  OAuth2SourceConfig,
  OpenApiOAuthSession,
  OpenApiSourceBindingInput,
  type OpenApiSourceBindingRef,
  type OpenApiSourceBindingValue,
  OperationBinding,
  type ConfiguredHeaderValue as ConfiguredHeaderValueValue,
  type HeaderValue as HeaderValueValue,
} from "./types";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

export type HeaderValue = HeaderValueValue;
export type ConfiguredHeaderValue = ConfiguredHeaderValueValue;
export type OpenApiHeaderInput = HeaderValue | ConfiguredHeaderValue;
export type OpenApiOAuthInput = OAuth2Auth | OAuth2SourceConfig;

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
  readonly headers?: Record<string, OpenApiHeaderInput>;
  readonly oauth2?: OpenApiOAuthInput;
}

export interface OpenApiUpdateSourceInput {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly headers?: Record<string, OpenApiHeaderInput>;
  /** Refresh the source's stored OAuth2 metadata after a successful
   *  re-authenticate. */
  readonly oauth2?: OpenApiOAuthInput;
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
  readonly listSourceBindings: (
    sourceId: string,
    sourceScope: string,
  ) => Effect.Effect<readonly OpenApiSourceBindingRef[], StorageFailure>;
  readonly setSourceBinding: (
    input: OpenApiSourceBindingInput,
  ) => Effect.Effect<OpenApiSourceBindingRef, StorageFailure>;
  readonly removeSourceBinding: (
    sourceId: string,
    sourceScope: string,
    slot: string,
    scope: string,
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

const headerSlotFromName = (name: string): string =>
  `header:${name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default"}`;

const oauthClientIdSlot = (securitySchemeName: string): string =>
  `oauth2:${securitySchemeName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default"}:client-id`;

const oauthClientSecretSlot = (securitySchemeName: string): string =>
  `oauth2:${securitySchemeName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default"}:client-secret`;

const oauthConnectionSlot = (securitySchemeName: string): string =>
  `oauth2:${securitySchemeName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default"}:connection`;

const canonicalizeHeaders = (
  headers: Record<string, OpenApiHeaderInput> | undefined,
): {
  readonly headers: Record<string, ConfiguredHeaderValue>;
  readonly bindings: ReadonlyArray<{
    readonly slot: string;
    readonly value: OpenApiSourceBindingValue;
  }>;
} => {
  const nextHeaders: Record<string, ConfiguredHeaderValue> = {};
  const bindings: Array<{ slot: string; value: OpenApiSourceBindingValue }> = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") {
      nextHeaders[name] = value;
      continue;
    }
    if ("kind" in value) {
      nextHeaders[name] = value;
      continue;
    }
    const slot = headerSlotFromName(name);
    nextHeaders[name] = new ConfiguredHeaderBinding({
      kind: "binding",
      slot,
      prefix: value.prefix,
    });
    bindings.push({
      slot,
      value: {
        kind: "secret",
        secretId: SecretId.make(value.secretId),
      },
    });
  }
  return { headers: nextHeaders, bindings };
};

const canonicalizeOAuth2 = (
  oauth2: OpenApiOAuthInput | undefined,
): {
  readonly oauth2?: OAuth2SourceConfig;
  readonly bindings: ReadonlyArray<{
    readonly slot: string;
    readonly value: OpenApiSourceBindingValue;
  }>;
} => {
  if (!oauth2) return { bindings: [] };
  if ("connectionSlot" in oauth2) {
    return { oauth2, bindings: [] };
  }
  const bindings: Array<{ slot: string; value: OpenApiSourceBindingValue }> = [
    {
      slot: oauthClientIdSlot(oauth2.securitySchemeName),
      value: {
        kind: "secret",
        secretId: SecretId.make(oauth2.clientIdSecretId),
      },
    },
  ];
  if (oauth2.clientSecretSecretId) {
    bindings.push({
      slot: oauthClientSecretSlot(oauth2.securitySchemeName),
      value: {
        kind: "secret",
        secretId: SecretId.make(oauth2.clientSecretSecretId),
      },
    });
  }
  if (oauth2.connectionId) {
    bindings.push({
      slot: oauthConnectionSlot(oauth2.securitySchemeName),
      value: {
        kind: "connection",
        connectionId: ConnectionId.make(oauth2.connectionId),
      },
    });
  }
  return {
    oauth2: new OAuth2SourceConfig({
      kind: "oauth2",
      securitySchemeName: oauth2.securitySchemeName,
      flow: oauth2.flow,
      tokenUrl: oauth2.tokenUrl,
      authorizationUrl: oauth2.authorizationUrl,
      clientIdSlot: oauthClientIdSlot(oauth2.securitySchemeName),
      clientSecretSlot: oauth2.clientSecretSecretId
        ? oauthClientSecretSlot(oauth2.securitySchemeName)
        : null,
      connectionSlot: oauthConnectionSlot(oauth2.securitySchemeName),
      scopes: [...oauth2.scopes],
    }),
    bindings,
  };
};

interface EffectiveSourceConfig {
  readonly config: SourceConfig;
  readonly headersSource: StoredSource;
  readonly oauth2Source: StoredSource;
}

const resolveEffectiveSourceConfig = (
  ctx: PluginCtx<OpenapiStore>,
  base: StoredSource,
): Effect.Effect<EffectiveSourceConfig, StorageFailure> =>
  Effect.gen(function* () {
    const rank = new Map(ctx.scopes.map((scope, index) => [scope.id as string, index] as const));
    const baseRank = rank.get(base.scope) ?? Infinity;
    let fallback: StoredSource | null = null;
    for (let index = baseRank + 1; index < ctx.scopes.length; index++) {
      const scope = ctx.scopes[index];
      if (!scope) continue;
      fallback = yield* ctx.storage.getSource(base.namespace, scope.id as string);
      if (fallback) break;
    }

    if (!fallback) {
      return {
        config: base.config,
        headersSource: base,
        oauth2Source: base,
      };
    }

    const hasBaseHeaders = Object.keys(base.config.headers ?? {}).length > 0;
    return {
      config: {
        ...base.config,
        sourceUrl: base.config.sourceUrl ?? fallback.config.sourceUrl,
        baseUrl: base.config.baseUrl || fallback.config.baseUrl,
        namespace: base.config.namespace ?? fallback.config.namespace,
        headers: hasBaseHeaders ? base.config.headers : fallback.config.headers,
        oauth2: base.config.oauth2 ?? fallback.config.oauth2,
      },
      headersSource: hasBaseHeaders ? base : fallback,
      oauth2Source: base.config.oauth2 ? base : fallback,
    };
  });

const resolveConfiguredHeaders = (
  ctx: PluginCtx<OpenapiStore>,
  params: {
    readonly sourceId: string;
    readonly sourceScope: string;
    readonly headers: Record<string, ConfiguredHeaderValue>;
    readonly legacyHeaders?: Record<string, HeaderValue>;
  },
): Effect.Effect<Record<string, string>, OpenApiOAuthError | StorageFailure> =>
  Effect.gen(function* () {
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(params.headers)) {
      if (typeof value === "string") {
        resolved[name] = value;
        continue;
      }
      const binding = yield* ctx.storage.resolveSourceBinding(
        params.sourceId,
        params.sourceScope,
        value.slot,
      );
      if (binding?.value.kind === "secret") {
        const secret = yield* ctx.secrets.get(binding.value.secretId as string);
        if (secret === null) {
          return yield* new OpenApiOAuthError({
            message: `Missing secret "${binding.value.secretId}" for header "${name}"`,
          });
        }
        resolved[name] = value.prefix ? `${value.prefix}${secret}` : secret;
        continue;
      }
      if (binding?.value.kind === "text") {
        resolved[name] = value.prefix ? `${value.prefix}${binding.value.text}` : binding.value.text;
        continue;
      }
      const legacy = params.legacyHeaders?.[name];
      if (legacy) {
        const fallback = yield* resolveHeaders({ [name]: legacy }, ctx.secrets).pipe(
          Effect.map((headers) => headers[name]!),
          Effect.mapError((err) =>
            err instanceof OpenApiOAuthError
              ? err
              : new OpenApiOAuthError({ message: err.message }),
          ),
        );
        resolved[name] = fallback;
        continue;
      }
      return yield* new OpenApiOAuthError({
        message: `Missing binding for header "${name}"`,
      });
    }
    return resolved;
  });

const resolveOAuthConnectionId = (
  ctx: PluginCtx<OpenapiStore>,
  params: {
    readonly sourceId: string;
    readonly sourceScope: string;
    readonly oauth2: OAuth2SourceConfig;
    readonly legacyOAuth2?: OAuth2Auth;
  },
): Effect.Effect<string | null, StorageFailure> =>
  Effect.gen(function* () {
      const binding = yield* ctx.storage.resolveSourceBinding(
      params.sourceId,
      params.sourceScope,
      params.oauth2.connectionSlot,
    );
    if (binding?.value.kind === "connection") {
      return binding.value.connectionId as string;
    }
    return params.legacyOAuth2?.connectionId ?? null;
  });

// ---------------------------------------------------------------------------
// Connection `provider_state` shape for openapi-oauth2.
//
// Every field needed to re-hit the token endpoint on refresh lives here,
// so the SDK's `ctx.connections.accessToken(id)` can drive both grant
// types without the plugin keeping its own refresh state. The flow
// literal chooses between `refresh_token` (authorizationCode) and
// re-`exchange client_credentials` at refresh time. NONE of this is
// sensitive — client credentials themselves still live in secrets and
// are resolved via `ctx.secrets.get` inside the refresh handler.
// ---------------------------------------------------------------------------

const OPENAPI_OAUTH2_PROVIDER_KEY = "openapi:oauth2" as const;

const OAuth2ProviderState = Schema.Struct({
  flow: Schema.Literal("authorizationCode", "clientCredentials"),
  tokenUrl: Schema.String,
  clientIdSecretId: Schema.String,
  clientSecretSecretId: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
});
type OAuth2ProviderState = typeof OAuth2ProviderState.Type;

const encodeProviderState = Schema.encodeSync(OAuth2ProviderState);
const decodeProviderState = Schema.decodeUnknownSync(OAuth2ProviderState);

const toProviderStateRecord = (
  state: OAuth2ProviderState,
): Record<string, unknown> =>
  encodeProviderState(state) as unknown as Record<string, unknown>;

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
): OpenApiSourceConfig => {
  const legacyHeaders: Record<string, HeaderValueValue> = {};
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (typeof value === "string" || !("kind" in value)) {
      legacyHeaders[name] = value;
    }
  }
  return {
    kind: "openapi",
    spec: config.spec,
    baseUrl: config.baseUrl,
    namespace,
    headers: headersToConfigValues(
      Object.keys(legacyHeaders).length > 0 ? legacyHeaders : undefined,
    ),
  };
};

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
      readonly headers?: Record<string, OpenApiHeaderInput>;
      readonly oauth2?: OpenApiOAuthInput;
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
        const canonicalHeaders = canonicalizeHeaders(input.headers);
        const canonicalOAuth2 = canonicalizeOAuth2(input.oauth2);

        const definitions = compileToolDefinitions(result.operations);
        const sourceName =
          input.name ?? Option.getOrElse(result.title, () => namespace);

        const sourceConfig: SourceConfig = {
          spec: input.specText,
          sourceUrl: input.sourceUrl,
          baseUrl,
          namespace: input.namespace,
          headers: canonicalHeaders.headers,
          oauth2: canonicalOAuth2.oauth2,
        };

        const storedSource: StoredSource = {
          namespace,
          scope: input.scope,
          name: sourceName,
          config: sourceConfig,
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

            for (const binding of [
              ...canonicalHeaders.bindings,
              ...canonicalOAuth2.bindings,
            ]) {
              yield* ctx.storage.setSourceBinding(
                new OpenApiSourceBindingInput({
                  sourceId: namespace,
                  sourceScope: ScopeId.make(input.scope),
                  scope: ScopeId.make(input.scope),
                  slot: binding.slot,
                  value: binding.value,
                }),
              );
            }

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
        const effective = yield* resolveEffectiveSourceConfig(ctx, existing);
        const resolvedConfig = effective.config;
        const sourceUrl = resolvedConfig.sourceUrl;
        if (!sourceUrl) return;
        const specText = yield* resolveSpecText(sourceUrl).pipe(
          Effect.provide(httpClientLayer),
        );
        yield* rebuildSource(ctx, {
          specText,
          scope,
          sourceUrl,
          name: existing.name,
          baseUrl: resolvedConfig.baseUrl,
          namespace: existing.namespace,
          headers: existing.legacy?.headers ?? existing.config.headers,
          oauth2: existing.legacy?.oauth2 ?? existing.config.oauth2,
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

          getSource: (namespace, scope) =>
            Effect.gen(function* () {
              const source = yield* ctx.storage.getSource(namespace, scope);
              if (!source) return null;
              const effective = yield* resolveEffectiveSourceConfig(ctx, source);
              return {
                ...source,
                config: effective.config,
              };
            }),

          updateSource: (namespace, scope, input) =>
            Effect.gen(function* () {
              const existing = yield* ctx.storage.getSource(namespace, scope);
              if (!existing) return;
              const canonicalHeaders =
                input.headers !== undefined
                  ? canonicalizeHeaders(input.headers)
                  : existing.legacy?.headers
                    ? canonicalizeHeaders(existing.legacy.headers)
                    : null;
              const canonicalOAuth2 =
                input.oauth2 !== undefined
                  ? canonicalizeOAuth2(input.oauth2)
                  : existing.legacy?.oauth2
                    ? canonicalizeOAuth2(existing.legacy.oauth2)
                    : null;
              yield* ctx.storage.updateSourceMeta(namespace, scope, {
                name: input.name?.trim() || undefined,
                baseUrl: input.baseUrl,
                headers: canonicalHeaders?.headers,
                oauth2: canonicalOAuth2?.oauth2,
              });
              for (const set of [canonicalHeaders?.bindings, canonicalOAuth2?.bindings]) {
                for (const binding of set ?? []) {
                  yield* ctx.storage.setSourceBinding(
                    new OpenApiSourceBindingInput({
                      sourceId: namespace,
                      sourceScope: ScopeId.make(scope),
                      scope: ScopeId.make(scope),
                      slot: binding.slot,
                      value: binding.value,
                    }),
                  );
                }
              }
            }),

          listSourceBindings: (sourceId, sourceScope) =>
            ctx.storage.listSourceBindings(sourceId, sourceScope),

          setSourceBinding: (input) =>
            ctx.storage.setSourceBinding(input),

          removeSourceBinding: (sourceId, sourceScope, slot, scope) =>
            ctx.storage.removeSourceBinding(sourceId, sourceScope, slot, scope),

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

              const clientId = yield* ctx.secrets.get(input.clientIdSecretId).pipe(
                Effect.mapError((err) => new OpenApiOAuthError({ message: err.message })),
              );
              if (clientId === null) {
                return yield* new OpenApiOAuthError({
                  message: `Missing client ID secret: ${input.clientIdSecretId}`,
                });
              }

              if (input.flow === "clientCredentials") {
                // RFC 6749 §4.4: no user consent, no session, no PKCE. The
                // client_secret is mandatory — the spec defines the grant
                // as client authentication + a token request.
                const clientSecret = yield* ctx.secrets
                  .get(input.clientSecretSecretId)
                  .pipe(
                    Effect.mapError(
                      (err) => new OpenApiOAuthError({ message: err.message }),
                    ),
                  );
                if (clientSecret === null) {
                  return yield* new OpenApiOAuthError({
                    message: `Missing client secret: ${input.clientSecretSecretId}`,
                  });
                }

                const tokenResponse = yield* exchangeClientCredentials({
                  tokenUrl: input.tokenUrl,
                  clientId,
                  clientSecret,
                  scopes: scopesArray,
                }).pipe(
                  Effect.mapError(
                    (err) => new OpenApiOAuthError({ message: err.message }),
                  ),
                );

                // Stable id, per-user scope. The id is a *name* — the
                // same string across every user — and each user's stack
                // resolves it to their own physical row via
                // `findInnermostConnectionRow`. That's what lets the
                // shared org-scoped source carry a single
                // `oauth2.connectionId` string while still supporting
                // per-user credentials (via scope-stacked secret
                // shadowing) and per-user tokens. `connections.create`
                // is delete-then-insert on `(id, scope_id)`, so each
                // user's repeat sign-ins refresh a single row rather
                // than accumulate UUIDs.
                const connectionId =
                  input.connectionId ??
                  defaultOAuthConnectionId("clientCredentials", input.sourceId);
                const connectionScope = input.tokenScope ?? innermostScope;
                const expiresAt =
                  typeof tokenResponse.expires_in === "number"
                    ? Date.now() + tokenResponse.expires_in * 1000
                    : null;

                const providerState: OAuth2ProviderState = {
                  flow: "clientCredentials",
                  tokenUrl: input.tokenUrl,
                  clientIdSecretId: input.clientIdSecretId,
                  clientSecretSecretId: input.clientSecretSecretId,
                  scopes: scopesArray,
                };

                yield* ctx.connections
                  .create(
                    new CreateConnectionInput({
                      id: ConnectionId.make(connectionId),
                      scope: ScopeId.make(connectionScope),
                      provider: OPENAPI_OAUTH2_PROVIDER_KEY,
                      identityLabel: input.displayName,
                      accessToken: new TokenMaterial({
                        secretId: SecretId.make(`${connectionId}.access_token`),
                        name: `${input.displayName} Access Token`,
                        value: tokenResponse.access_token,
                      }),
                      // RFC 6749 §4.4.3: no refresh tokens for this grant.
                      refreshToken: null,
                      expiresAt,
                      oauthScope: tokenResponse.scope ?? null,
                      providerState: toProviderStateRecord(providerState),
                    }),
                  )
                  .pipe(
                    Effect.mapError(
                      (err) =>
                        new OpenApiOAuthError({
                          message:
                            "message" in err
                              ? (err as { message: string }).message
                              : String(err),
                        }),
                    ),
                  );

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

              // authorizationCode path. The source's logical connection
              // id is stable, so repeated "Sign in" clicks refresh one
              // row per target scope instead of creating UUID churn. By
              // default this grant writes per-user because it carries user
              // identity.
              const tokenScope = input.tokenScope ?? innermostScope;
              const sessionId = randomUUID();
              const codeVerifier = createPkceCodeVerifier();
              const connectionId =
                input.connectionId ??
                defaultOAuthConnectionId("authorizationCode", input.sourceId);

              yield* ctx.storage
                .putOAuthSession(
                  sessionId,
                  new OpenApiOAuthSession({
                    displayName: input.displayName,
                    securitySchemeName: input.securitySchemeName,
                    flow: input.flow,
                    tokenUrl: input.tokenUrl,
                    authorizationUrl: input.authorizationUrl,
                    redirectUrl: input.redirectUrl,
                    clientIdSecretId: input.clientIdSecretId,
                    clientSecretSecretId: input.clientSecretSecretId ?? null,
                    tokenScope,
                    connectionId,
                    accessTokenSecretId: `${connectionId}.access_token`,
                    refreshTokenSecretId: `${connectionId}.refresh_token`,
                    scopes: scopesArray,
                    codeVerifier,
                  }),
                )
                .pipe(
                  Effect.mapError((err) => new OpenApiOAuthError({ message: err.message })),
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
                flow: "authorizationCode" as const,
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

                const expiresAt =
                  typeof tokenResponse.expires_in === "number"
                    ? Date.now() + tokenResponse.expires_in * 1000
                    : null;

                const providerState: OAuth2ProviderState = {
                  flow: "authorizationCode",
                  tokenUrl: session.tokenUrl,
                  clientIdSecretId: session.clientIdSecretId,
                  clientSecretSecretId: session.clientSecretSecretId,
                  scopes: [...session.scopes],
                };

                yield* ctx.connections
                  .create(
                    new CreateConnectionInput({
                      id: ConnectionId.make(session.connectionId),
                      scope: ScopeId.make(session.tokenScope),
                      provider: OPENAPI_OAUTH2_PROVIDER_KEY,
                      identityLabel: session.displayName,
                      accessToken: new TokenMaterial({
                        secretId: SecretId.make(session.accessTokenSecretId),
                        name: `${session.displayName} Access Token`,
                        value: tokenResponse.access_token,
                      }),
                      refreshToken: tokenResponse.refresh_token
                        ? new TokenMaterial({
                            secretId: SecretId.make(session.refreshTokenSecretId),
                            name: `${session.displayName} Refresh Token`,
                            value: tokenResponse.refresh_token,
                          })
                        : null,
                      expiresAt,
                      oauthScope: tokenResponse.scope ?? null,
                      providerState: toProviderStateRecord(providerState),
                    }),
                  )
                  .pipe(
                    Effect.mapError(
                      (err) =>
                        new OpenApiOAuthError({
                          message:
                            "message" in err
                              ? (err as { message: string }).message
                              : String(err),
                        }),
                    ),
                  );

                return new OAuth2Auth({
                  kind: "oauth2",
                  connectionId: session.connectionId,
                  securitySchemeName: session.securitySchemeName,
                  flow: "authorizationCode",
                  tokenUrl: session.tokenUrl,
                  authorizationUrl: session.authorizationUrl,
                  clientIdSecretId: session.clientIdSecretId,
                  clientSecretSecretId: session.clientSecretSecretId,
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

          const effective = yield* resolveEffectiveSourceConfig(ctx, source);
          const config = effective.config;
          const resolvedHeaders = yield* resolveConfiguredHeaders(ctx, {
            sourceId: op.sourceId,
            sourceScope: effective.headersSource.scope,
            headers: config.headers ?? {},
            legacyHeaders: effective.headersSource.legacy?.headers,
          }).pipe(
            Effect.mapError((err) => new Error(err.message)),
          );

          // If the source has OAuth2 auth, resolve a guaranteed-fresh
          // access token from the backing Connection and inject the
          // Authorization header (wins over a manually-set one). All the
          // refresh complexity lives in the SDK — the plugin just asks.
          if (config.oauth2) {
            const connectionId = yield* resolveOAuthConnectionId(ctx, {
              sourceId: op.sourceId,
              sourceScope: effective.oauth2Source.scope,
              oauth2: config.oauth2,
              legacyOAuth2: effective.oauth2Source.legacy?.oauth2,
            });
            if (!connectionId) {
              return yield* Effect.fail(
                new Error(
                  `OAuth configuration for "${op.sourceId}" is missing a connection binding`,
                ),
              );
            }
            const accessToken = yield* ctx.connections
              .accessToken(connectionId)
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
            config.baseUrl ?? "",
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
          // One listOperationsBySource per scope is independent storage
          // work; run them in parallel so a shadowed source doesn't
          // serialise two ~200ms reads back-to-back in the caller's
          // `executor.tools.list.annotations` span.
          const entries = yield* Effect.forEach(
            [...scopes],
            (scope) =>
              Effect.gen(function* () {
                const ops = yield* ctx.storage.listOperationsBySource(sourceId, scope);
                const byId = new Map<string, OperationBinding>();
                for (const op of ops) byId.set(op.toolId, op.binding);
                return [scope, byId] as const;
              }),
            { concurrency: "unbounded" },
          );
          const byScope = new Map<string, Map<string, OperationBinding>>(entries);

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

      // The SDK's `ctx.connections.accessToken(id)` dispatches here when a
      // token is near expiry. Both flows share one provider key — the
      // concrete refresh strategy is selected from `providerState.flow`
      // because the caller already persisted all the knobs we need.
      connectionProviders: (ctx): readonly ConnectionProvider[] => [
        {
          key: OPENAPI_OAUTH2_PROVIDER_KEY,
          refresh: (input: ConnectionRefreshInput) =>
            Effect.gen(function* () {
              if (!input.providerState) {
                return yield* new ConnectionRefreshError({
                  connectionId: input.connectionId,
                  message:
                    "openapi:oauth2 connection is missing providerState",
                });
              }
              const state = yield* Effect.try({
                try: () => decodeProviderState(input.providerState),
                catch: (cause) =>
                  new ConnectionRefreshError({
                    connectionId: input.connectionId,
                    message: `openapi:oauth2 providerState is malformed: ${
                      cause instanceof Error ? cause.message : String(cause)
                    }`,
                    cause,
                  }),
              });

              const clientId = yield* ctx.secrets.get(state.clientIdSecretId).pipe(
                Effect.mapError(
                  (err) =>
                    new ConnectionRefreshError({
                      connectionId: input.connectionId,
                      message: `Failed to resolve client id secret: ${err.message}`,
                      cause: err,
                    }),
                ),
              );
              if (clientId === null) {
                return yield* new ConnectionRefreshError({
                  connectionId: input.connectionId,
                  message: `Missing client id secret: ${state.clientIdSecretId}`,
                });
              }

              const clientSecret = state.clientSecretSecretId
                ? yield* ctx.secrets.get(state.clientSecretSecretId).pipe(
                    Effect.mapError(
                      (err) =>
                        new ConnectionRefreshError({
                          connectionId: input.connectionId,
                          message: `Failed to resolve client secret: ${err.message}`,
                          cause: err,
                        }),
                    ),
                  )
                : null;

              // RFC 6749 §5.2 terminal error codes — the AS has told us
              // the stored grant is unusable, so no amount of retries
              // will recover. Surface these as `reauthRequired: true`
              // so the SDK translates to `ConnectionReauthRequiredError`
              // at the caller and the UI prompts sign-in.
              const REAUTH_REQUIRED_ERRORS = new Set([
                "invalid_grant",
                "invalid_client",
                "unauthorized_client",
              ]);

              const toRefreshError = (err: OAuth2Error) =>
                new ConnectionRefreshError({
                  connectionId: input.connectionId,
                  message: err.message,
                  reauthRequired: err.error
                    ? REAUTH_REQUIRED_ERRORS.has(err.error)
                    : false,
                  cause: err,
                });

              const tokenResponse = yield* (state.flow === "clientCredentials"
                ? exchangeClientCredentials({
                    tokenUrl: state.tokenUrl,
                    clientId,
                    clientSecret: clientSecret ?? "",
                    scopes: state.scopes,
                  })
                : (() => {
                    if (input.refreshToken === null) {
                      // No refresh token stored — we cannot call the
                      // token endpoint at all. This is the RFC 6749
                      // §4.1 "must re-consent" case, modelled as a
                      // reauth-required refresh failure so callers
                      // hit the same UI path as an `invalid_grant`.
                      return Effect.fail(
                        new OAuth2Error({
                          message:
                            "authorizationCode connection has no refresh token",
                          error: "invalid_grant",
                        }),
                      );
                    }
                    return refreshAccessToken({
                      tokenUrl: state.tokenUrl,
                      clientId,
                      clientSecret,
                      refreshToken: input.refreshToken,
                      scopes: state.scopes,
                    });
                  })()
              ).pipe(Effect.mapError(toRefreshError));

              const expiresAt =
                typeof tokenResponse.expires_in === "number"
                  ? Date.now() + tokenResponse.expires_in * 1000
                  : null;

              const result: ConnectionRefreshResult = {
                accessToken: tokenResponse.access_token,
                // Rotated refresh token (RFC 6749 §6) — undefined means
                // "keep the stored one"; null means "AS didn't issue one".
                refreshToken: tokenResponse.refresh_token ?? undefined,
                expiresAt,
                oauthScope: tokenResponse.scope ?? input.oauthScope,
              };
              return result;
            }),
        },
      ],
    };
  },
);
