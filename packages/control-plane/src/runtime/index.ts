import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { type ControlPlaneApiRuntimeContext } from "#api";
import {
  SqlControlPlanePersistenceLive,
  SqlControlPlanePersistenceService,
  SqlControlPlaneRowsLive,
  SqlControlPlaneRowsService,
  SqlPersistenceBootstrapError,
  type CreateSqlRuntimeOptions,
  type SqlControlPlanePersistence,
} from "#persistence";
import type { LocalInstallation } from "#schema";

import { type ResolveExecutionEnvironment } from "./execution-state";
import {
  createLiveExecutionManager,
  LiveExecutionManagerLive,
  LiveExecutionManagerService,
} from "./live-execution";
import { getOrProvisionLocalInstallation } from "./local-installation";
import {
  loadLocalExecutorConfig,
  resolveLocalWorkspaceContext,
} from "./local-config";
import { RuntimeLocalWorkspaceService } from "./local-runtime-context";
import { synchronizeLocalWorkspaceState } from "./local-workspace-sync";
import { ControlPlaneStore, ControlPlaneStoreLive } from "./store";
import {
  createRuntimeSourceAuthService,
  RuntimeSourceAuthServiceLive,
  RuntimeSourceAuthServiceTag,
} from "./source-auth-service";
import type { ResolveSecretMaterial } from "./secret-material-providers";
import { createDefaultSecretMaterialResolver } from "./secret-material-providers";
import {
  createWorkspaceExecutionEnvironmentResolver,
  RuntimeExecutionResolverLive,
  RuntimeExecutionResolverService,
} from "./workspace-execution-environment";

export * from "./execution-state";
export * from "./executor-tools";
export * from "./live-execution";
export * from "./local-config";
export * from "./local-installation";
export * from "./local-source-artifacts";
export * from "./local-tools";
export * from "./schema-type-signature";
export * from "./source-auth-service";
export * from "./secret-material-providers";
export * from "./source-credential-interactions";
export * from "./source-adapters/mcp";
export * from "./store";
export * from "./workspace-execution-environment";
export * from "./source-inspection";
export * from "./source-discovery";
export * from "./execution-service";

export type RuntimeControlPlaneOptions = {
  executionResolver?: ResolveExecutionEnvironment;
  resolveSecretMaterial?: ResolveSecretMaterial;
  getLocalServerBaseUrl?: () => string | undefined;
  workspaceRoot?: string;
};

const detailsFromCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const toLocalRuntimeBootstrapError = (
  cause: unknown,
): SqlPersistenceBootstrapError => {
  const details = detailsFromCause(cause);
  return new SqlPersistenceBootstrapError({
    message: `Failed initializing local runtime: ${details}`,
    details,
  });
};

const closeScope = (scope: Scope.CloseableScope) =>
  Scope.close(scope, Exit.void).pipe(Effect.orDie);

export type RuntimeControlPlaneLayer = Layer.Layer<
  ControlPlaneApiRuntimeContext,
  never,
  never
>;

const runtimeContextTags = [
  ControlPlaneStore,
  LiveExecutionManagerService,
  RuntimeLocalWorkspaceService,
  RuntimeSourceAuthServiceTag,
  RuntimeExecutionResolverService,
] as const;

const createRuntimeLayerFromContext = (
  context: Context.Context<
    | ControlPlaneStore
    | LiveExecutionManagerService
    | RuntimeLocalWorkspaceService
    | RuntimeSourceAuthServiceTag
    | RuntimeExecutionResolverService
  >,
): RuntimeControlPlaneLayer => {
  const runtimeContext = context.pipe(
    Context.pick(...runtimeContextTags),
  ) as Context.Context<
    | ControlPlaneStore
    | LiveExecutionManagerService
    | RuntimeLocalWorkspaceService
    | RuntimeSourceAuthServiceTag
    | RuntimeExecutionResolverService
  >;

  return Layer.succeedContext(runtimeContext) as RuntimeControlPlaneLayer;
};

export const createRuntimeControlPlaneLayer = (
  options: RuntimeControlPlaneOptions = {},
) => {
  const liveExecutionManagerLayer = LiveExecutionManagerLive;
  const sourceAuthLayer = RuntimeSourceAuthServiceLive({
    getLocalServerBaseUrl: options.getLocalServerBaseUrl,
  }).pipe(Layer.provide(liveExecutionManagerLayer));
  const executionResolverLayer = RuntimeExecutionResolverLive({
    executionResolver: options.executionResolver,
    resolveSecretMaterial: options.resolveSecretMaterial,
  }).pipe(Layer.provide(sourceAuthLayer));

  return Layer.mergeAll(
    ControlPlaneStoreLive,
    liveExecutionManagerLayer,
    sourceAuthLayer,
    executionResolverLayer,
  );
};

export type ControlPlaneRuntime = {
  persistence: SqlControlPlanePersistence;
  localInstallation: LocalInstallation;
  runtimeLayer: RuntimeControlPlaneLayer;
  close: () => Promise<void>;
};

export type CreateControlPlaneRuntimeOptions = CreateSqlRuntimeOptions &
  RuntimeControlPlaneOptions;

export const createControlPlaneRuntime = (
  options: CreateControlPlaneRuntimeOptions,
): Effect.Effect<ControlPlaneRuntime, SqlPersistenceBootstrapError> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const persistenceAndRowsLayer = SqlControlPlaneRowsLive.pipe(
      Layer.provideMerge(SqlControlPlanePersistenceLive(options)),
    );
    const baseContext = yield* Layer.buildWithScope(
      persistenceAndRowsLayer,
      scope,
    ).pipe(
      Effect.catchAll((error) =>
        closeScope(scope).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    );

    const persistence = Context.get(
      baseContext,
      SqlControlPlanePersistenceService,
    );
    const rows = Context.get(baseContext, SqlControlPlaneRowsService);

    const localWorkspaceContext = yield* resolveLocalWorkspaceContext({
      workspaceRoot: options.workspaceRoot,
    }).pipe(
      Effect.mapError(toLocalRuntimeBootstrapError),
      Effect.catchAll((error) =>
        closeScope(scope).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    );

    const localInstallation = yield* getOrProvisionLocalInstallation({
      context: localWorkspaceContext,
    }).pipe(
      Effect.mapError(toLocalRuntimeBootstrapError),
      Effect.catchAll((error) =>
        closeScope(scope).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    );

    const loadedLocalConfig = yield* loadLocalExecutorConfig(
      localWorkspaceContext,
    ).pipe(
      Effect.mapError(toLocalRuntimeBootstrapError),
      Effect.catchAll((error) =>
        closeScope(scope).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    );

    const effectiveLocalConfig = yield* synchronizeLocalWorkspaceState({
      context: localWorkspaceContext,
      loadedConfig: loadedLocalConfig,
    }).pipe(
      Effect.mapError(toLocalRuntimeBootstrapError),
      Effect.catchAll((error) =>
        closeScope(scope).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    );

    const resolveSecretMaterial =
      options.resolveSecretMaterial ??
      createDefaultSecretMaterialResolver({
        rows,
        localConfig: effectiveLocalConfig,
        workspaceRoot: localWorkspaceContext.workspaceRoot,
      });

    const liveExecutionManager = createLiveExecutionManager();
    const sourceAuthService = createRuntimeSourceAuthService({
      rows,
      liveExecutionManager,
      getLocalServerBaseUrl: options.getLocalServerBaseUrl,
      localConfig: effectiveLocalConfig,
      workspaceRoot: localWorkspaceContext.workspaceRoot,
      localWorkspaceState: {
        context: localWorkspaceContext,
        installation: {
          workspaceId: localInstallation.workspaceId,
          accountId: localInstallation.accountId,
        },
        loadedConfig: {
          ...loadedLocalConfig,
          config: effectiveLocalConfig,
        },
      },
    });
    const executionResolver =
      options.executionResolver ??
      createWorkspaceExecutionEnvironmentResolver({
        rows,
        sourceAuthService,
        resolveSecretMaterial,
      });

    const runtimeContext = Context.empty().pipe(
      Context.add(ControlPlaneStore, rows),
      Context.add(LiveExecutionManagerService, liveExecutionManager),
      Context.add(RuntimeLocalWorkspaceService, {
        context: localWorkspaceContext,
        installation: {
          workspaceId: localInstallation.workspaceId,
          accountId: localInstallation.accountId,
        },
        loadedConfig: {
          ...loadedLocalConfig,
          config: effectiveLocalConfig,
        },
      }),
      Context.add(RuntimeSourceAuthServiceTag, sourceAuthService),
      Context.add(RuntimeExecutionResolverService, executionResolver),
    );
    const concreteRuntimeLayer = createRuntimeLayerFromContext(runtimeContext);

    return {
      persistence,
      localInstallation,
      runtimeLayer: concreteRuntimeLayer,
      close: () =>
        Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {}),
    };
  });
