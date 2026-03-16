import {
  createToolCatalogFromTools,
  makeToolInvokerFromTools,
} from "@executor/codemode-core";
import type {
  AccountId,
  Source,
} from "#schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  ExecutionEnvironment,
  ResolveExecutionEnvironment,
} from "./execution-state";
import {
  createCodeExecutorForRuntime,
  resolveConfiguredExecutionRuntime,
} from "./execution-runtime";
import { createWorkspaceToolInvoker } from "./workspace-tool-invoker";
import {
  RuntimeSourceAuthServiceTag,
} from "../sources/source-auth-service";
import {
  RuntimeSourceCatalogStoreService,
} from "../catalog/source-catalog-runtime";
import { RuntimeSourceAuthMaterialService } from "../auth/source-auth-material";
import {
  getRuntimeLocalWorkspaceOption,
} from "../local/local-runtime-context";
import {
  LocalToolRuntimeLoaderService,
  type LocalToolRuntimeLoaderShape,
  type LocalToolRuntime,
} from "../local/local-tools";
import {
  SourceArtifactStore,
  type SourceArtifactStoreShape,
  WorkspaceConfigStore,
  type WorkspaceConfigStoreShape,
  WorkspaceStateStore,
  type WorkspaceStateStoreShape,
} from "../local/local-storage";
export {
  createCodeExecutorForRuntime,
  resolveConfiguredExecutionRuntime,
} from "./execution-runtime";

const createEmptyLocalToolRuntime = (): LocalToolRuntime => ({
  tools: {},
  catalog: createToolCatalogFromTools({ tools: {} }),
  toolInvoker: makeToolInvokerFromTools({ tools: {} }),
  toolPaths: new Set<string>(),
});

export const createWorkspaceExecutionEnvironmentResolver = (input: {
  sourceAuthMaterialService: Effect.Effect.Success<typeof RuntimeSourceAuthMaterialService>;
  sourceAuthService: Effect.Effect.Success<typeof RuntimeSourceAuthServiceTag>;
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
  localToolRuntimeLoader: LocalToolRuntimeLoaderShape;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
}): ResolveExecutionEnvironment =>
  ({ workspaceId, accountId, onElicitation }) =>
    Effect.gen(function* () {
      const runtimeLocalWorkspace = yield* getRuntimeLocalWorkspaceOption();
      const loadedConfig =
        runtimeLocalWorkspace === null
          ? null
          : yield* input.workspaceConfigStore.load(runtimeLocalWorkspace.context);
      const localToolRuntime =
        runtimeLocalWorkspace === null
          ? createEmptyLocalToolRuntime()
          : yield* input.localToolRuntimeLoader.load(runtimeLocalWorkspace.context);
      const { catalog, toolInvoker } = createWorkspaceToolInvoker({
        workspaceId,
        accountId,
        sourceCatalogStore: input.sourceCatalogStore,
        workspaceConfigStore: input.workspaceConfigStore,
        workspaceStateStore: input.workspaceStateStore,
        sourceArtifactStore: input.sourceArtifactStore,
        sourceAuthMaterialService: input.sourceAuthMaterialService,
        sourceAuthService: input.sourceAuthService,
        runtimeLocalWorkspace,
        localToolRuntime,
        onElicitation,
      });

      const executor = createCodeExecutorForRuntime(
        resolveConfiguredExecutionRuntime(loadedConfig?.config),
      );

      return {
        executor,
        toolInvoker,
        catalog,
      } satisfies ExecutionEnvironment;
    });

export class RuntimeExecutionResolverService extends Context.Tag(
  "#runtime/RuntimeExecutionResolverService",
)<
  RuntimeExecutionResolverService,
  ReturnType<typeof createWorkspaceExecutionEnvironmentResolver>
>() {}

export const RuntimeExecutionResolverLive = (
  input: {
    executionResolver?: ResolveExecutionEnvironment;
  } = {},
) =>
  input.executionResolver
    ? Layer.succeed(RuntimeExecutionResolverService, input.executionResolver)
      : Layer.effect(
        RuntimeExecutionResolverService,
        Effect.gen(function* () {
          const sourceAuthMaterialService = yield* RuntimeSourceAuthMaterialService;
          const sourceAuthService = yield* RuntimeSourceAuthServiceTag;
          const sourceCatalogStore = yield* RuntimeSourceCatalogStoreService;
          const localToolRuntimeLoader = yield* LocalToolRuntimeLoaderService;
          const workspaceConfigStore = yield* WorkspaceConfigStore;
          const workspaceStateStore = yield* WorkspaceStateStore;
          const sourceArtifactStore = yield* SourceArtifactStore;

          return createWorkspaceExecutionEnvironmentResolver({
            sourceAuthService,
            sourceAuthMaterialService,
            sourceCatalogStore,
            localToolRuntimeLoader,
            workspaceConfigStore,
            workspaceStateStore,
            sourceArtifactStore,
          });
        }),
      );
