import { Effect, type Layer } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";

import { type BlobStore, pluginBlobStore } from "./blob";
import type { ConnectionProvider } from "./connections";
import type { CredentialBindingsFacade } from "./credential-bindings";
import type { DefinitionsInput, SourceInput } from "./core-schema";
import {
  EXECUTOR_SOURCE,
  EXECUTOR_SOURCE_ID,
  byScopedId,
  deleteSourceById,
  makeCoreDb,
  pluginStorageFailure,
  writeDefinitions,
  writeSourceInput,
} from "./executor-helpers";
import { StorageError, makeFumaClient, type FumaDb, type StorageFailure } from "./fuma-runtime";
import type { OAuthService } from "./oauth";
import type { AnyPlugin, PluginCtx, StaticSourceDecl, StaticToolDecl, StorageDeps } from "./plugin";
import type { Scope } from "./scope";
import type { SecretProvider } from "./secrets";
import type { RemoveSourceInput } from "./types";

export interface ExecutorStaticTool {
  readonly source: StaticSourceDecl;
  readonly tool: StaticToolDecl;
  readonly pluginId: string;
  readonly ctx: PluginCtx<unknown>;
}

export interface ExecutorStaticSource {
  readonly source: StaticSourceDecl;
  readonly pluginId: string;
}

export interface ExecutorPluginRuntime {
  readonly plugin: AnyPlugin;
  readonly storage: unknown;
  readonly ctx: PluginCtx<unknown>;
}

export const registerExecutorPlugins = (deps: {
  readonly plugins: readonly AnyPlugin[];
  readonly scopes: readonly Scope[];
  readonly rootDb: FumaDb<any>;
  readonly blobs: BlobStore;
  readonly scopeIds: readonly string[];
  readonly core: ReturnType<typeof makeCoreDb>;
  readonly staticTools: Map<string, ExecutorStaticTool>;
  readonly staticSources: Map<string, ExecutorStaticSource>;
  readonly runtimes: Map<string, ExecutorPluginRuntime>;
  readonly secretProviders: Map<string, SecretProvider>;
  readonly connectionProviders: Map<string, ConnectionProvider>;
  readonly extensions: Record<string, object>;
  readonly transaction: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E | StorageFailure>;
  readonly assertScopeInStack: (
    label: string,
    scopeId: string,
  ) => Effect.Effect<void, StorageError>;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly secrets: PluginCtx<unknown>["secrets"];
  readonly connections: PluginCtx<unknown>["connections"];
  readonly credentialBindings: CredentialBindingsFacade;
  readonly oauth: OAuthService;
}): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    const {
      plugins,
      scopes,
      rootDb,
      blobs,
      scopeIds,
      core,
      staticTools,
      staticSources,
      runtimes,
      secretProviders,
      connectionProviders,
      extensions,
      transaction,
      assertScopeInStack,
      httpClientLayer,
      secrets,
      connections,
      credentialBindings,
      oauth,
    } = deps;

    const secretsGet = secrets.get;
    const secretsGetAtScope = secrets.getAtScope;
    const secretsListForCtx = secrets.list;
    const secretsSet = secrets.set;
    const secretsRemove = secrets.remove;
    const connectionsGet = connections.get;
    const connectionsGetAtScope = connections.getAtScope;
    const connectionsListForCtx = connections.list;
    const connectionsCreate = connections.create;
    const connectionsUpdateTokens = connections.updateTokens;
    const connectionsSetIdentityLabel = connections.setIdentityLabel;
    const connectionsAccessToken = connections.accessToken;
    const connectionsAccessTokenAtScope = connections.accessTokenAtScope;
    const connectionsRemove = connections.remove;

    // ------------------------------------------------------------------
    // Plugin wiring — build ctx, run extension, populate static pools,
    // register secret providers. No adapter reads here.
    // ------------------------------------------------------------------
    for (const plugin of plugins) {
      if (runtimes.has(plugin.id)) {
        return yield* new StorageError({
          message: `Duplicate plugin id: ${plugin.id}`,
          cause: undefined,
        });
      }

      const pluginFuma = makeFumaClient(
        rootDb,
        plugin.schema ? { tables: new Set(Object.keys(plugin.schema)) } : { tables: new Set() },
      );
      const storageDeps: StorageDeps = {
        scopes,
        fuma: pluginFuma,
        // Blob keys are namespaced by `<scope>/<plugin>` so two tenants
        // sharing a backing BlobStore can't collide or leak on the
        // same `(plugin, key)` pair. The store's `get`/`has` walk the
        // scope stack (innermost first); `put`/`delete` require the
        // plugin to name a target scope explicitly.
        blobs: pluginBlobStore(blobs, scopeIds, plugin.id),
      };
      const storage = plugin.storage(storageDeps);

      const ctx: PluginCtx<unknown> = {
        scopes,
        storage,
        httpClientLayer: httpClientLayer ?? FetchHttpClient.layer,
        core: {
          sources: {
            register: (input: SourceInput) =>
              Effect.gen(function* () {
                // Guard: reject a dynamic source whose id collides with
                // a static source id, or any of whose would-be tool ids
                // collide with a static tool id. Tool ids are
                // `${source_id}.${tool.name}` — static and dynamic
                // share the same string space. Fails as `StorageError`
                // so the HTTP edge surfaces it as `InternalError(traceId)`.
                if (staticSources.has(input.id)) {
                  return yield* new StorageError({
                    message: `Source id "${input.id}" collides with a static source`,
                    cause: undefined,
                  });
                }
                for (const tool of input.tools) {
                  const fqid = `${input.id}.${tool.name}`;
                  if (staticTools.has(fqid)) {
                    return yield* new StorageError({
                      message: `Tool id "${fqid}" collides with a static tool`,
                      cause: undefined,
                    });
                  }
                }
                yield* transaction(writeSourceInput(core, plugin.id, input));
              }),
            unregister: (input: RemoveSourceInput) =>
              // `unregister` is scoped to a caller-named source row. The
              // plugin already knows which source owner it is updating,
              // so the core path must not infer an innermost target.
              transaction(
                Effect.gen(function* () {
                  yield* assertScopeInStack("source unregister targetScope", input.targetScope);
                  const row = yield* core.findFirst("source", {
                    where: byScopedId(input.targetScope, input.id),
                  });
                  if (!row) return;
                  yield* deleteSourceById(core, input.id, input.targetScope);
                }),
              ),
            update: (input) =>
              core
                .updateMany("source", {
                  where: byScopedId(input.scope, input.id),
                  set: {
                    ...(input.name !== undefined ? { name: input.name } : {}),
                    ...(input.url !== undefined ? { url: input.url ?? null } : {}),
                    updated_at: new Date(),
                  },
                })
                .pipe(Effect.asVoid),
          },
          definitions: {
            register: (input: DefinitionsInput) =>
              transaction(writeDefinitions(core, plugin.id, input)),
          },
        },
        secrets: {
          get: (id) => secretsGet(id),
          getAtScope: (id, scope) => secretsGetAtScope(id, scope),
          list: () => secretsListForCtx(),
          set: (input) => secretsSet(input),
          remove: (input) => secretsRemove(input),
        },
        connections: {
          get: (id) => connectionsGet(id),
          getAtScope: (id, scope) => connectionsGetAtScope(id, scope),
          list: () => connectionsListForCtx(),
          create: (input) => connectionsCreate(input),
          updateTokens: (input) => connectionsUpdateTokens(input),
          setIdentityLabel: (id, label) => connectionsSetIdentityLabel(id, label),
          accessToken: (id) => connectionsAccessToken(id),
          accessTokenAtScope: (id, scope) => connectionsAccessTokenAtScope(id, scope),
          remove: (input) => connectionsRemove(input),
        },
        credentialBindings,
        oauth: oauth,
        transaction: <A, E>(effect: Effect.Effect<A, E>) => transaction(effect),
      };

      // Build extension FIRST so it's available as `self` when resolving
      // staticSources. Field ordering in the plugin spec matters — TS
      // infers TExtension from `extension`'s return type, then NoInfer
      // locks `self` to that inferred type on `staticSources`.
      const extension: object = plugin.extension ? plugin.extension(ctx) : {};
      if (plugin.extension) {
        extensions[plugin.id] = extension;
      }

      // Resolve static declarations to the in-memory pools. NO DB WRITES.
      // Plugin-owned executor tools are intentionally mounted under the
      // single `executor` namespace so source inventory is about configured
      // integrations, not plugin management surfaces:
      //   openapi.addSource -> executor.openapi.addSource
      const decls = plugin.staticSources ? plugin.staticSources(extension) : [];
      for (const source of decls) {
        const mountUnderExecutor = source.kind === "executor" && source.id === plugin.id;
        const mountedSource = mountUnderExecutor ? EXECUTOR_SOURCE : source;

        if (mountUnderExecutor) {
          if (!staticSources.has(EXECUTOR_SOURCE_ID)) {
            staticSources.set(EXECUTOR_SOURCE_ID, {
              source: EXECUTOR_SOURCE,
              pluginId: EXECUTOR_SOURCE_ID,
            });
          }
        } else {
          if (staticSources.has(source.id)) {
            return yield* new StorageError({
              message: `Duplicate static source id: ${source.id} (plugin ${plugin.id})`,
              cause: undefined,
            });
          }
          staticSources.set(source.id, { source, pluginId: plugin.id });
        }

        for (const tool of source.tools) {
          const mountedTool = mountUnderExecutor
            ? {
                ...tool,
                name: `${plugin.id}.${tool.name}`,
              }
            : tool;
          const fqid = `${mountedSource.id}.${mountedTool.name}`;
          if (staticTools.has(fqid)) {
            return yield* new StorageError({
              message: `Duplicate static tool id: ${fqid} (plugin ${plugin.id})`,
              cause: undefined,
            });
          }
          staticTools.set(fqid, {
            source: mountedSource,
            tool: mountedTool,
            pluginId: plugin.id,
            ctx,
          });
        }
      }

      runtimes.set(plugin.id, { plugin, storage, ctx });

      if (plugin.secretProviders) {
        const raw =
          typeof plugin.secretProviders === "function"
            ? plugin.secretProviders(ctx)
            : plugin.secretProviders;
        const providers = Effect.isEffect(raw)
          ? yield* raw.pipe(
              Effect.mapError((cause) => pluginStorageFailure(plugin.id, "secretProviders", cause)),
            )
          : raw;
        for (const provider of providers) {
          if (secretProviders.has(provider.key)) {
            return yield* new StorageError({
              message: `Duplicate secret provider key: ${provider.key} (from plugin ${plugin.id})`,
              cause: undefined,
            });
          }
          secretProviders.set(provider.key, provider);
        }
      }

      if (plugin.connectionProviders) {
        const raw =
          typeof plugin.connectionProviders === "function"
            ? plugin.connectionProviders(ctx)
            : plugin.connectionProviders;
        const providers = Effect.isEffect(raw)
          ? yield* raw.pipe(
              Effect.mapError((cause) =>
                pluginStorageFailure(plugin.id, "connectionProviders", cause),
              ),
            )
          : raw;
        for (const provider of providers) {
          if (connectionProviders.has(provider.key)) {
            return yield* new StorageError({
              message: `Duplicate connection provider key: ${provider.key} (from plugin ${plugin.id})`,
              cause: undefined,
            });
          }
          connectionProviders.set(provider.key, provider);
        }
      }
    }
  });
