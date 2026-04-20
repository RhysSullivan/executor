import { randomUUID } from "node:crypto";

import { Effect, Option } from "effect";

import { storeOAuthTokens } from "@executor/plugin-oauth2";

import {
  definePlugin,
  SetSecretInput,
  SourceDetectionResult,
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
import {
  buildGoogleAuthorizationUrl,
  createPkceCodeVerifier,
  exchangeAuthorizationCode,
} from "./oauth";
import type {
  GoogleDiscoveryAuth,
  GoogleDiscoveryManifest,
  GoogleDiscoveryManifestMethod,
  GoogleDiscoveryStoredSourceData,
} from "./types";
import { GoogleDiscoveryStoredSourceData as GoogleDiscoveryStoredSourceDataSchema } from "./types";

// ---------------------------------------------------------------------------
// Public input / output shapes (unchanged from the old plugin)
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

export interface GoogleDiscoveryOAuthStartInput {
  readonly name: string;
  readonly discoveryUrl: string;
  readonly clientIdSecretId: string;
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
  readonly clientIdSecretId: string;
  readonly clientSecretSecretId: string | null;
  readonly accessTokenSecretId: string;
  readonly refreshTokenSecretId: string | null;
  readonly tokenType: string;
  readonly expiresAt: number | null;
  readonly scope: string | null;
  readonly scopes: readonly string[];
}

/**
 * Errors any Google Discovery extension method may surface. The first
 * three are plugin-domain tagged errors that flow directly to clients
 * (4xx, each carrying its own `HttpApiSchema` status once wrapped at the
 * API edge). `StorageFailure` covers raw backend failures (`StorageError`)
 * plus `UniqueViolationError`; the HTTP edge (`@executor/api`'s
 * `withCapture`) translates `StorageError` to the opaque
 * `InternalError({ traceId })` at Layer composition. `UniqueViolationError`
 * passes through — plugins can `Effect.catchTag` it if they want a
 * friendlier user-facing error.
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
  ) => Effect.Effect<GoogleDiscoveryStoredSource | null, StorageFailure>;
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
    // 1. Clear any previous manifest for this namespace.
    yield* ctx.storage.removeBindingsBySource(namespace);
    yield* ctx.core.sources.unregister(namespace).pipe(Effect.ignore);

    // 2. Register the source + tool rows in core.
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

    // 3. Register shared $defs, if any.
    if (Object.keys(manifest.schemaDefinitions).length > 0) {
      yield* ctx.core.definitions.register({
        sourceId: namespace,
        scope,
        definitions: manifest.schemaDefinitions,
      });
    }

    // 4. Write per-tool bindings to plugin storage (keyed by the same
    //    ${source_id}.${name} tool id the executor synthesizes).
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

    // 5. Write the source config blob.
    yield* ctx.storage.putSource({
      namespace,
      scope,
      name: sourceData.name,
      config: sourceData,
    });

    return manifest.methods.length;
  });

// ---------------------------------------------------------------------------
// Mint a fresh secret via ctx.secrets.set and return {id} for storeOAuthTokens.
// ---------------------------------------------------------------------------

const createSecretForOAuth = (
  ctx: PluginCtx<GoogleDiscoveryStore>,
  input: {
    readonly idPrefix: string;
    readonly name: string;
    readonly value: string;
    readonly purpose: string;
  },
) =>
  ctx.secrets
    .set(
      new SetSecretInput({
        id: `${input.idPrefix}_${randomUUID().slice(0, 8)}` as SetSecretInput["id"],
        // OAuth tokens are per-user: pin to the innermost scope so Alice
        // and Bob don't overwrite each other's tokens.
        scope: ctx.scopes[0]!.id,
        name: input.name,
        value: input.value,
      }),
    )
    .pipe(Effect.map((ref) => ({ id: ref.id as string })));

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

    removeSource: (namespace) =>
      ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.storage.removeBindingsBySource(namespace);
          yield* ctx.storage.removeSource(namespace);
          yield* ctx.core.sources.unregister(namespace).pipe(Effect.ignore);
        }),
      ),

    startOAuth: (input) =>
      Effect.gen(function* () {
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
        const clientIdValue = yield* ctx.secrets.get(input.clientIdSecretId);
        if (clientIdValue === null) {
          return yield* new GoogleDiscoveryOAuthError({
            message: `OAuth client ID secret not found: ${input.clientIdSecretId}`,
          });
        }
        const sessionId = randomUUID();
        const codeVerifier = createPkceCodeVerifier();
        yield* ctx.storage.putOAuthSession(sessionId, ctx.scopes[0]!.id as string, {
          discoveryUrl: normalizeDiscoveryUrl(input.discoveryUrl),
          name: input.name,
          clientIdSecretId: input.clientIdSecretId,
          clientSecretSecretId: input.clientSecretSecretId ?? null,
          redirectUrl: input.redirectUrl,
          scopes,
          codeVerifier,
        });
        return {
          sessionId,
          authorizationUrl: buildGoogleAuthorizationUrl({
            clientId: clientIdValue,
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
        const session = yield* ctx.storage.getOAuthSession(input.state);
        if (!session) {
          return yield* new GoogleDiscoveryOAuthError({
            message: "OAuth session not found or has expired",
          });
        }
        yield* ctx.storage.deleteOAuthSession(input.state);

        if (input.error) {
          return yield* new GoogleDiscoveryOAuthError({ message: input.error });
        }
        if (!input.code) {
          return yield* new GoogleDiscoveryOAuthError({
            message: "OAuth callback did not include an authorization code",
          });
        }

        const clientIdValue = yield* ctx.secrets.get(session.clientIdSecretId);
        if (clientIdValue === null) {
          return yield* new GoogleDiscoveryOAuthError({
            message: `OAuth client ID secret not found: ${session.clientIdSecretId}`,
          });
        }

        const clientSecretValue =
          session.clientSecretSecretId === null
            ? null
            : yield* ctx.secrets.get(session.clientSecretSecretId).pipe(
                Effect.flatMap((v) =>
                  v === null
                    ? Effect.fail(
                        new GoogleDiscoveryOAuthError({
                          message: `OAuth client secret not found: ${session.clientSecretSecretId}`,
                        }),
                      )
                    : Effect.succeed(v),
                ),
              );

        const tokenResponse = yield* exchangeAuthorizationCode({
          clientId: clientIdValue,
          clientSecret: clientSecretValue,
          redirectUrl: session.redirectUrl,
          codeVerifier: session.codeVerifier,
          code: input.code,
        });

        const stored = yield* storeOAuthTokens({
          tokens: tokenResponse,
          slug: `${normalizeSlug(session.name)}_google`,
          displayName: session.name,
          accessTokenPurpose: "google_oauth_access_token",
          refreshTokenPurpose: "google_oauth_refresh_token",
          createSecret: (args) => createSecretForOAuth(ctx, args),
        }).pipe(
          Effect.mapError((error) => new GoogleDiscoveryOAuthError({ message: error.message })),
        );

        return {
          kind: "oauth2" as const,
          clientIdSecretId: session.clientIdSecretId,
          clientSecretSecretId: session.clientSecretSecretId,
          accessTokenSecretId: stored.accessTokenSecretId,
          refreshTokenSecretId: stored.refreshTokenSecretId,
          tokenType: stored.tokenType,
          expiresAt: stored.expiresAt,
          scope: stored.scope,
          scopes: [...session.scopes],
        };
      }),

    getSource: (namespace) => ctx.storage.getSource(namespace),
  } satisfies GoogleDiscoveryPluginExtension),

  invokeTool: ({ ctx, toolRow, args }) =>
    invokeGoogleDiscoveryTool({
      ctx: ctx as PluginCtx<GoogleDiscoveryStore>,
      toolId: toolRow.id,
      args,
    }),

  resolveAnnotations: ({ ctx, sourceId, toolRows }) =>
    Effect.gen(function* () {
      const bindings = yield* (ctx as PluginCtx<GoogleDiscoveryStore>).storage.getBindingsForSource(
        sourceId,
      );
      const out: Record<string, ToolAnnotations> = {};
      for (const row of toolRows) {
        const binding = bindings.get(row.id);
        if (binding) {
          out[row.id] = annotationsForOperation(binding.method, binding.pathTemplate);
        }
      }
      return out;
    }),

  removeSource: ({ ctx, sourceId }) =>
    Effect.gen(function* () {
      yield* (ctx as PluginCtx<GoogleDiscoveryStore>).storage.removeBindingsBySource(sourceId);
      yield* (ctx as PluginCtx<GoogleDiscoveryStore>).storage.removeSource(sourceId);
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

  refreshSource: ({ ctx, sourceId }) =>
    Effect.gen(function* () {
      const typedCtx = ctx as PluginCtx<GoogleDiscoveryStore>;
      const existing = yield* typedCtx.storage.getSource(sourceId);
      if (!existing) return;
      const refreshScope = existing.scope ?? (typedCtx.scopes.at(-1)!.id as string);
      const text = yield* fetchDiscoveryDocument(existing.config.discoveryUrl);
      const manifest = yield* extractGoogleDiscoveryManifest(text);
      const next = new GoogleDiscoveryStoredSourceDataSchema({
        ...existing.config,
        service: manifest.service,
        version: manifest.version,
        rootUrl: manifest.rootUrl,
        servicePath: manifest.servicePath,
      });
      yield* registerManifest(typedCtx, sourceId, refreshScope, manifest, next);
    }).pipe(Effect.mapError((err) => (err instanceof Error ? err : new Error(String(err))))),
}));
