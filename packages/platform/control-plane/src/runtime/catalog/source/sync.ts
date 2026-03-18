import type {
  AccountId,
  Source,
  SourceStatus,
} from "#schema";
import type { McpToolManifest } from "@executor/source-mcp";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  RuntimeLocalWorkspaceService,
  type RuntimeLocalWorkspaceState,
} from "../../local/runtime-context";
import {
  SourceArtifactStore,
  type SourceArtifactStoreShape,
  WorkspaceStateStore,
  type WorkspaceStateStoreShape,
} from "../../local/storage";
import {
  type LocalWorkspaceState,
} from "../../local/workspace-state";
import {
  RuntimeSourceAuthMaterialService,
} from "../../auth/source-auth-material";
import {
  getSourceAdapterForSource,
} from "../../sources/source-adapters";
import {
  catalogSyncResultFromMcpManifest,
} from "@executor/source-mcp";
import { SecretMaterialResolverService } from "../../local/secret-material-providers";
import { snapshotFromSourceCatalogSyncResult } from "@executor/source-core";
import {
  refreshSourceTypeDeclarationInBackground,
} from "./type-declarations";
import { runtimeEffectError } from "../../effect-errors";

const shouldIndexSource = (source: Source): boolean =>
  source.enabled
  && source.status === "connected"
  && getSourceAdapterForSource(source).catalogKind !== "internal";

type RuntimeSourceCatalogSyncDeps = {
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  resolveSecretMaterial: Effect.Effect.Success<typeof SecretMaterialResolverService>;
  sourceAuthMaterialService: Effect.Effect.Success<typeof RuntimeSourceAuthMaterialService>;
};

type SourceCatalogSyncServices =
  | RuntimeLocalWorkspaceService
  | WorkspaceStateStore
  | SourceArtifactStore
  | RuntimeSourceAuthMaterialService
  | SecretMaterialResolverService;

export type RuntimeSourceCatalogSyncShape = {
  sync: (input: {
    source: Source;
    actorAccountId?: AccountId | null;
  }) => Effect.Effect<void, Error, never>;
  persistMcpCatalogSnapshotFromManifest: (input: {
    source: Source;
    manifest: McpToolManifest;
  }) => Effect.Effect<void, Error, never>;
};

export class RuntimeSourceCatalogSyncService extends Context.Tag(
  "#runtime/RuntimeSourceCatalogSyncService",
)<RuntimeSourceCatalogSyncService, RuntimeSourceCatalogSyncShape>() {}

const ensureRuntimeCatalogSyncWorkspace = (
  deps: RuntimeSourceCatalogSyncDeps,
  workspaceId: Source["workspaceId"],
) => {
  if (deps.runtimeLocalWorkspace.installation.workspaceId !== workspaceId) {
    return Effect.fail(
      runtimeEffectError("catalog/source/sync", 
        `Runtime local workspace mismatch: expected ${workspaceId}, got ${deps.runtimeLocalWorkspace.installation.workspaceId}`,
      ),
    );
  }

  return Effect.succeed(deps.runtimeLocalWorkspace.context);
};

const syncSourceCatalogWithDeps = (
  deps: RuntimeSourceCatalogSyncDeps,
  input: {
    source: Source;
    actorAccountId?: AccountId | null;
  },
): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const workspaceContext = yield* ensureRuntimeCatalogSyncWorkspace(
      deps,
      input.source.workspaceId,
    );

    if (!shouldIndexSource(input.source)) {
      const state = yield* deps.workspaceStateStore.load(workspaceContext);
      const existingSourceState = state.sources[input.source.id];
      const nextState: LocalWorkspaceState = {
        ...state,
        sources: {
          ...state.sources,
          [input.source.id]: {
            status: (input.source.enabled ? input.source.status : "draft") as SourceStatus,
            lastError: null,
            sourceHash: input.source.sourceHash,
            createdAt: existingSourceState?.createdAt ?? input.source.createdAt,
            updatedAt: Date.now(),
          },
        },
      };
      yield* deps.workspaceStateStore.write({
        context: workspaceContext,
        state: nextState,
      });
      yield* Effect.sync(() => {
        refreshSourceTypeDeclarationInBackground({
          context: workspaceContext,
          source: input.source,
          snapshot: null,
        });
      });
      return;
    }

    const adapter = getSourceAdapterForSource(input.source);
    const syncResult = yield* adapter.syncCatalog({
      source: input.source,
      resolveSecretMaterial: deps.resolveSecretMaterial,
      resolveAuthMaterialForSlot: (slot) =>
        deps.sourceAuthMaterialService.resolve({
          source: input.source,
          slot,
          actorAccountId: input.actorAccountId,
        }),
    });
    const snapshot = snapshotFromSourceCatalogSyncResult(syncResult);
    yield* deps.sourceArtifactStore.write({
      context: workspaceContext,
      sourceId: input.source.id,
      artifact: deps.sourceArtifactStore.build({
        source: input.source,
        syncResult,
      }),
    });

    const state = yield* deps.workspaceStateStore.load(workspaceContext);
    const existingSourceState = state.sources[input.source.id];
    const nextState: LocalWorkspaceState = {
      ...state,
      sources: {
        ...state.sources,
        [input.source.id]: {
          status: "connected",
          lastError: null,
          sourceHash: syncResult.sourceHash,
          createdAt: existingSourceState?.createdAt ?? input.source.createdAt,
          updatedAt: Date.now(),
        },
      },
    };
    yield* deps.workspaceStateStore.write({
      context: workspaceContext,
      state: nextState,
    });

    yield* Effect.sync(() => {
      refreshSourceTypeDeclarationInBackground({
        context: workspaceContext,
        source: input.source,
        snapshot,
      });
    });
  }).pipe(
    Effect.withSpan("source.catalog.sync", {
      attributes: {
        "executor.source.id": input.source.id,
        "executor.source.kind": input.source.kind,
        "executor.source.namespace": input.source.namespace,
        "executor.source.endpoint": input.source.endpoint,
      },
    }),
  );

const persistMcpCatalogSnapshotFromManifestWithDeps = (
  deps: RuntimeSourceCatalogSyncDeps,
  input: {
    source: Source;
    manifest: McpToolManifest;
  },
): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const workspaceContext = yield* ensureRuntimeCatalogSyncWorkspace(
      deps,
      input.source.workspaceId,
    );
    const syncResult = catalogSyncResultFromMcpManifest({
      source: input.source,
      endpoint: input.source.endpoint,
      manifest: input.manifest,
    });
    const snapshot = snapshotFromSourceCatalogSyncResult(syncResult);

    yield* deps.sourceArtifactStore.write({
      context: workspaceContext,
      sourceId: input.source.id,
      artifact: deps.sourceArtifactStore.build({
        source: input.source,
        syncResult,
      }),
    });

    yield* Effect.sync(() => {
      refreshSourceTypeDeclarationInBackground({
        context: workspaceContext,
        source: input.source,
        snapshot,
      });
    });
  });

export const syncSourceCatalog = (input: {
  source: Source;
  actorAccountId?: AccountId | null;
}): Effect.Effect<void, Error, SourceCatalogSyncServices> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const workspaceStateStore = yield* WorkspaceStateStore;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const sourceAuthMaterialService = yield* RuntimeSourceAuthMaterialService;

    return yield* syncSourceCatalogWithDeps(
      {
        runtimeLocalWorkspace,
        workspaceStateStore,
        sourceArtifactStore,
        resolveSecretMaterial,
        sourceAuthMaterialService,
      },
      {
        source: input.source,
        actorAccountId: input.actorAccountId,
      },
    );
  });

export const persistMcpCatalogSnapshotFromManifest = (input: {
  source: Source;
  manifest: McpToolManifest;
}): Effect.Effect<void, Error, SourceCatalogSyncServices> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const workspaceStateStore = yield* WorkspaceStateStore;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const sourceAuthMaterialService = yield* RuntimeSourceAuthMaterialService;

    return yield* persistMcpCatalogSnapshotFromManifestWithDeps(
      {
        runtimeLocalWorkspace,
        workspaceStateStore,
        sourceArtifactStore,
        resolveSecretMaterial,
        sourceAuthMaterialService,
      },
      input,
    );
  });

export const RuntimeSourceCatalogSyncLive = Layer.effect(
  RuntimeSourceCatalogSyncService,
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const workspaceStateStore = yield* WorkspaceStateStore;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const sourceAuthMaterialService = yield* RuntimeSourceAuthMaterialService;

    const deps: RuntimeSourceCatalogSyncDeps = {
      runtimeLocalWorkspace,
      workspaceStateStore,
      sourceArtifactStore,
      resolveSecretMaterial,
      sourceAuthMaterialService,
    };

    return RuntimeSourceCatalogSyncService.of({
      sync: (input) => syncSourceCatalogWithDeps(deps, input),
      persistMcpCatalogSnapshotFromManifest: (input) =>
        persistMcpCatalogSnapshotFromManifestWithDeps(deps, input),
    });
  }),
);
