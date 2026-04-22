import { randomUUID } from "node:crypto";

import { Effect, Option } from "effect";

import {
  SourceDetectionResult,
  definePlugin,
  type PluginCtx,
  type StorageFailure,
  type ToolAnnotations,
} from "@executor/sdk";

import {
  googleDiscoverySchema,
  makeGoogleDiscoveryStore,
  type GoogleDiscoveryStore,
  type GoogleDiscoveryStoredSource,
} from "./binding-store";
import { extractGoogleDiscoveryManifest } from "./document";
import { annotationsForOperation, invokeGoogleDiscoveryTool } from "./invoke";
import {
  GoogleDiscoveryOAuthError,
  GoogleDiscoveryParseError,
  GoogleDiscoverySourceError,
} from "./errors";
// Google-specific OAuth constants — copied here so the plugin is
// self-contained (no more per-plugin `oauth.ts` helper file). Token
// endpoint + authorize endpoint live on the connection's providerState
// after sign-in, so refresh routes through the core handler unchanged.
const GOOGLE_AUTHORIZATION_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const GOOGLE_EXTRA_AUTHORIZATION_PARAMS = {
  access_type: "offline",
  include_granted_scopes: "true",
  prompt: "consent",
} as const;
import type {
  GoogleDiscoveryAuth,
  GoogleDiscoveryManifest,
  GoogleDiscoveryManifestMethod,
  GoogleDiscoveryMethodBinding,
  GoogleDiscoveryStoredSourceData,
} from "./types";
import { GoogleDiscoveryStoredSourceData as GoogleDiscoveryStoredSourceDataSchema } from "./types";

// ---------------------------------------------------------------------------
// Public input / output shapes
// ---------------------------------------------------------------------------

export interface GoogleDiscoveryProbeOperation {
  readonly toolPath: string;
  readonly method: string;
  readonly pathTemplate: string;
  readonly description: string | null;
}

export interface GoogleDiscoveryProbeResult {
  readonly name: string;
  readonly title: string | null;
  readonly service: string;
  readonly version: string;
  readonly toolCount: number;
  readonly scopes: readonly string[];
  readonly operations: readonly GoogleDiscoveryProbeOperation[];
}

export interface GoogleDiscoveryAddSourceInput {
  readonly name: string;
  readonly scope: string;
  readonly discoveryUrl: string;
  readonly namespace?: string;
  readonly auth: GoogleDiscoveryAuth;
}

export interface GoogleDiscoveryUpdateSourceInput {
  readonly name?: string;
  /** Rewrite the source's auth — typically after a successful
   *  re-authenticate, to point at a freshly minted Connection. */
  readonly auth?: GoogleDiscoveryAuth;
}

export interface GoogleDiscoveryOAuthStartInput {
  readonly name: string;
  readonly discoveryUrl: string;
  readonly clientIdSecretId: string;
  readonly clientSecretSecretId?: string | null;
  readonly redirectUrl: string;
  readonly scopes?: readonly string[];
  /** Executor scope that will own the resulting Connection + its backing
   *  secrets. Defaults to `ctx.scopes[0].id` (innermost / per-user). */
  readonly tokenScope?: string;
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

/**
 * Completed OAuth auth handed back to the caller (either an HTTP client or
 * a static-tool handler). Carries the full API-level OAuth config so the
 * caller can stamp it onto the source's `GoogleDiscoveryAuth` — that makes
 * sign-in reproducible from the source detail page without depending on
 * the prior Connection still existing.
 */
export interface GoogleDiscoveryOAuthAuthResult {
  readonly kind: "oauth2";
  readonly connectionId: string;
}

/**
 * Errors any Google Discovery extension method may surface.
 */
export type GoogleDiscoveryExtensionFailure =
  | GoogleDiscoveryParseError
  | GoogleDiscoverySourceError
  | GoogleDiscoveryOAuthError
  | StorageFailure;

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
    GoogleDiscoveryParseError | GoogleDiscoverySourceError | StorageFailure
  >;
  readonly removeSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;
  readonly startOAuth: (
    input: GoogleDiscoveryOAuthStartInput,
  ) => Effect.Effect<
    GoogleDiscoveryOAuthStartResponse,
    | GoogleDiscoveryParseError
    | GoogleDiscoverySourceError
    | GoogleDiscoveryOAuthError
    | StorageFailure
  >;
  readonly completeOAuth: (
    input: GoogleDiscoveryOAuthCompleteInput,
  ) => Effect.Effect<
    GoogleDiscoveryOAuthAuthResult,
    GoogleDiscoveryOAuthError | StorageFailure
  >;
  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<GoogleDiscoveryStoredSource | null, StorageFailure>;
  readonly updateSource: (
    namespace: string,
    scope: string,
    input: GoogleDiscoveryUpdateSourceInput,
  ) => Effect.Effect<void, StorageFailure>;
}

// ---------------------------------------------------------------------------
// URL normalization + slug helpers (unchanged)
// ---------------------------------------------------------------------------

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
  if (parsed.pathname !== "/$discovery/rest") return trimmed;
  const version = parsed.searchParams.get("version")?.trim();
  if (!version) return trimmed;
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith(".googleapis.com")) return trimmed;
  const rawService = host.slice(0, -".googleapis.com".length);
  const service =
    rawService === "calendar-json"
      ? "calendar"
      : rawService.endsWith("-json")
        ? rawService.slice(0, -5)
        : rawService;
  if (!service) return trimmed;
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
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const deriveNamespace = (input: { name: string; service: string; version: string }): string =>
  normalizeSlug(
    input.name || `google_${input.service}_${input.version.replace(/[^a-zA-Z0-9]+/g, "_")}`,
  ) || `google_${input.service}`;

// Connection refresh state is owned by the canonical `"oauth2"`
// ConnectionProvider registered by core. `ctx.oauth.start` stamps the
// Google-specific token endpoint + scopes onto the connection's
// providerState at mint time — no plugin-owned schema needed.

// ---------------------------------------------------------------------------
// Register a parsed manifest against the executor core + plugin storage.
// Runs inside a transaction.
// ---------------------------------------------------------------------------

const registerManifest = (
  ctx: PluginCtx<GoogleDiscoveryStore>,
  namespace: string,
  scope: string,
  manifest: GoogleDiscoveryManifest,
  sourceData: GoogleDiscoveryStoredSourceData,
) =>
  Effect.gen(function* () {
    yield* ctx.storage.removeBindingsBySource(namespace, scope);
    yield* ctx.core.sources.unregister(namespace).pipe(Effect.ignore);

    yield* ctx.core.sources.register({
      id: namespace,
      scope,
      kind: "googleDiscovery",
      name: sourceData.name,
      url: sourceData.rootUrl,
      canRemove: true,
      canRefresh: true,
      canEdit: true,
      tools: manifest.methods.map((method: GoogleDiscoveryManifestMethod) => ({
        name: method.toolPath,
        description: Option.getOrElse(method.description, () => `${method.binding.method.toUpperCase()} ${method.binding.pathTemplate}`),
        inputSchema: Option.getOrUndefined(method.inputSchema),
        outputSchema: Option.getOrUndefined(method.outputSchema),
      })),
    });

    if (Object.keys(manifest.schemaDefinitions).length > 0) {
      yield* ctx.core.definitions.register({
        sourceId: namespace,
        scope,
        definitions: manifest.schemaDefinitions,
      });
    }

    yield* Effect.forEach(
      manifest.methods,
      (method) =>
        ctx.storage.putBinding(
          `${namespace}.${method.toolPath}`,
          namespace,
          scope,
          method.binding,
        ),
      { discard: true },
    );

    yield* ctx.storage.putSource({
      namespace,
      scope,
      name: sourceData.name,
      config: sourceData,
    });

    return manifest.methods.length;
  });

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const googleDiscoveryPlugin = definePlugin(() => ({
  id: "googleDiscovery" as const,
  schema: googleDiscoverySchema,
  storage: (deps) => makeGoogleDiscoveryStore(deps),

  extension: (ctx) => ({
    probeDiscovery: (discoveryUrl) =>
      Effect.gen(function* () {
        const text = yield* fetchDiscoveryDocument(discoveryUrl);
        const manifest = yield* extractGoogleDiscoveryManifest(text);
        const scopes = Object.keys(
          manifest.oauthScopes._tag === "Some" ? manifest.oauthScopes.value : {},
        ).sort();
        const operations = manifest.methods.map((method) => ({
          toolPath: method.toolPath,
          method: method.binding.method,
          pathTemplate: method.binding.pathTemplate,
          description: method.description._tag === "Some" ? method.description.value : null,
        }));
        return {
          name:
            manifest.title._tag === "Some"
              ? manifest.title.value
              : `${manifest.service} ${manifest.version}`,
          title: manifest.title._tag === "Some" ? manifest.title.value : null,
          service: manifest.service,
          version: manifest.version,
          toolCount: manifest.methods.length,
          scopes,
          operations,
        };
      }),

    addSource: (input) =>
      ctx.transaction(
        Effect.gen(function* () {
          const text = yield* fetchDiscoveryDocument(input.discoveryUrl);
          const manifest = yield* extractGoogleDiscoveryManifest(text);
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
            namespace,
            input.scope,
            manifest,
            sourceData,
          );
          return { toolCount, namespace };
        }),
      ),

    removeSource: (namespace, scope) =>
      ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.storage.removeBindingsBySource(namespace, scope);
          yield* ctx.storage.removeSource(namespace, scope);
          yield* ctx.core.sources.unregister(namespace).pipe(Effect.ignore);
        }),
      ),

    // Thin forwarders over `ctx.oauth.*`. Core owns the session table,
    // the PKCE machinery, and the refresh handler. The plugin only
    // carries Google-specific knobs — scope discovery from the
    // discovery document and the `access_type=offline`/`prompt=consent`
    // extras — into the core OAuth strategy config.
    startOAuth: (input) =>
      Effect.gen(function* () {
        const oauthService = ctx.oauth;
        if (!oauthService) {
          return yield* new GoogleDiscoveryOAuthError({
            message: "ctx.oauth not wired",
          });
        }
        const text = yield* fetchDiscoveryDocument(input.discoveryUrl);
        const manifest = yield* extractGoogleDiscoveryManifest(text);
        const scopes =
          input.scopes && input.scopes.length > 0
            ? [...input.scopes]
            : Object.keys(
                manifest.oauthScopes._tag === "Some" ? manifest.oauthScopes.value : {},
              ).sort();
        if (scopes.length === 0) {
          return yield* new GoogleDiscoveryOAuthError({
            message: "This Google Discovery document does not declare any OAuth scopes",
          });
        }
        const tokenScope = input.tokenScope ?? (ctx.scopes[0]!.id as string);
        const connectionId = `google-discovery-oauth2-${randomUUID()}`;
        const result = yield* oauthService
          .start({
            endpoint: normalizeDiscoveryUrl(input.discoveryUrl),
            redirectUrl: input.redirectUrl,
            connectionId,
            tokenScope,
            strategy: {
              kind: "authorization-code" as const,
              authorizationEndpoint: GOOGLE_AUTHORIZATION_URL,
              tokenEndpoint: GOOGLE_TOKEN_URL,
              clientIdSecretId: input.clientIdSecretId,
              clientSecretSecretId: input.clientSecretSecretId ?? null,
              scopes,
              extraAuthorizationParams: GOOGLE_EXTRA_AUTHORIZATION_PARAMS,
            },
            pluginId: "google-discovery",
          })
          .pipe(
            Effect.mapError(
              (err) =>
                new GoogleDiscoveryOAuthError({
                  message:
                    "message" in err
                      ? (err as { message: string }).message
                      : String(err),
                }),
            ),
          );
        if (result.authorizationUrl === null) {
          return yield* new GoogleDiscoveryOAuthError({
            message:
              "OAuth service did not emit an authorization URL — authorizationCode flow requires one",
          });
        }
        return {
          sessionId: result.sessionId,
          authorizationUrl: result.authorizationUrl,
          scopes,
        };
      }),

    completeOAuth: (input) =>
      Effect.gen(function* () {
        const oauthService = ctx.oauth;
        if (!oauthService) {
          return yield* new GoogleDiscoveryOAuthError({
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
            Effect.mapError(
              (err) =>
                new GoogleDiscoveryOAuthError({
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
          kind: "oauth2" as const,
          connectionId: completed.connectionId,
        };
      }),

    getSource: (namespace, scope) => ctx.storage.getSource(namespace, scope),

    updateSource: (namespace, scope, input) =>
      ctx.storage.updateSourceMeta(namespace, scope, {
        name: input.name?.trim() || undefined,
        auth: input.auth,
      }),
  } satisfies GoogleDiscoveryPluginExtension),

  invokeTool: ({ ctx, toolRow, args }) =>
    invokeGoogleDiscoveryTool({
      ctx: ctx as PluginCtx<GoogleDiscoveryStore>,
      toolId: toolRow.id,
      toolScope: toolRow.scope_id as string,
      args,
    }),

  resolveAnnotations: ({ ctx, sourceId, toolRows }) =>
    Effect.gen(function* () {
      const typedCtx = ctx as PluginCtx<GoogleDiscoveryStore>;
      const scopes = new Set<string>();
      for (const row of toolRows) scopes.add(row.scope_id as string);
      const byScope = new Map<string, ReadonlyMap<string, GoogleDiscoveryMethodBinding>>();
      for (const scope of scopes) {
        const bindings = yield* typedCtx.storage.getBindingsForSource(sourceId, scope);
        byScope.set(scope, bindings);
      }
      const out: Record<string, ToolAnnotations> = {};
      for (const row of toolRows) {
        const binding = byScope.get(row.scope_id as string)?.get(row.id);
        if (binding) {
          out[row.id] = annotationsForOperation(binding.method, binding.pathTemplate);
        }
      }
      return out;
    }),

  removeSource: ({ ctx, sourceId, scope }) =>
    Effect.gen(function* () {
      const typedCtx = ctx as PluginCtx<GoogleDiscoveryStore>;
      yield* typedCtx.storage.removeBindingsBySource(sourceId, scope);
      yield* typedCtx.storage.removeSource(sourceId, scope);
    }),

  detect: ({ url }) =>
    Effect.gen(function* () {
      const trimmed = url.trim();
      if (!trimmed) return null;
      const parsed = yield* Effect.try(() => new URL(trimmed)).pipe(Effect.option);
      if (parsed._tag === "None") return null;

      const isGoogleUrl = trimmed.includes("googleapis.com");
      const isDiscoveryPath =
        trimmed.includes("/discovery/") || trimmed.includes("$discovery");
      if (!isGoogleUrl && !isDiscoveryPath) return null;

      const discoveryText = yield* fetchDiscoveryDocument(trimmed).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );
      if (!discoveryText) return null;

      const manifest = yield* extractGoogleDiscoveryManifest(discoveryText).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );
      if (!manifest) return null;

      const name = Option.getOrElse(
        manifest.title,
        () => `${manifest.service} ${manifest.version}`,
      );

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

  refreshSource: ({ ctx, sourceId, scope }) =>
    Effect.gen(function* () {
      const typedCtx = ctx as PluginCtx<GoogleDiscoveryStore>;
      const existing = yield* typedCtx.storage.getSource(sourceId, scope);
      if (!existing) return;
      const text = yield* fetchDiscoveryDocument(existing.config.discoveryUrl);
      const manifest = yield* extractGoogleDiscoveryManifest(text);
      const next = new GoogleDiscoveryStoredSourceDataSchema({
        ...existing.config,
        service: manifest.service,
        version: manifest.version,
        rootUrl: manifest.rootUrl,
        servicePath: manifest.servicePath,
      });
      yield* registerManifest(typedCtx, sourceId, scope, manifest, next);
    }).pipe(Effect.mapError((err) => (err instanceof Error ? err : new Error(String(err))))),

  // Connection refresh is owned by the canonical `"oauth2"`
  // ConnectionProvider registered by core — no plugin-specific handler
  // needed. The Google-specific `GOOGLE_TOKEN_URL` lives on the
  // connection's providerState (stamped at `ctx.oauth.start` time with
  // the `authorization-code` strategy's tokenEndpoint), so refresh
  // reaches Google through the unified code path.
}));
