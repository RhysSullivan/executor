import type {
  AccountId,
  AuthArtifact,
  Source,
  SourceId,
  WorkspaceId,
} from "#schema";
import { SourceIdSchema } from "#schema";
import * as Effect from "effect/Effect";

import { sourceAuthFromAuthArtifact } from "../../auth/auth-artifacts";
import { authArtifactSecretMaterialRefs } from "../../auth/auth-artifacts";
import type { LoadedLocalExecutorConfig } from "../../workspace-config";
import {
  LocalConfiguredSourceNotFoundError,
  RuntimeLocalWorkspaceMismatchError,
  RuntimeLocalWorkspaceUnavailableError,
} from "../../workspace-errors";
import type { LocalWorkspaceState } from "../../workspace-state";
import { getSourceAdapter } from "../source-adapters";
import {
  resolveRuntimeLocalWorkspaceFromDeps,
  type RuntimeSourceStoreDeps,
} from "./deps";
import {
  selectPreferredAuthArtifact,
} from "./auth";
import {
  sourceAuthFromConfigInput,
  trimOrNull,
} from "./config";

export const buildLocalSourceRecord = (input: {
  workspaceId: WorkspaceId;
  loadedConfig: LoadedLocalExecutorConfig;
  workspaceState: LocalWorkspaceState;
  sourceId: SourceId;
  actorAccountId?: AccountId | null;
  authArtifacts: ReadonlyArray<AuthArtifact>;
}): Effect.Effect<
  {
    source: Source;
    sourceId: SourceId;
  },
  LocalConfiguredSourceNotFoundError | Error,
  never
> =>
  Effect.gen(function* () {
    const sourceConfig = input.loadedConfig.config?.sources?.[input.sourceId];
    if (!sourceConfig) {
      return yield* new LocalConfiguredSourceNotFoundError({
          message: `Configured source not found for id ${input.sourceId}`,
          sourceId: input.sourceId,
        });
    }

    const existingState = input.workspaceState.sources[input.sourceId];
    const adapter = getSourceAdapter(sourceConfig.kind);
    const baseSource = (yield* adapter.validateSource({
      id: SourceIdSchema.make(input.sourceId),
      workspaceId: input.workspaceId,
      name: trimOrNull(sourceConfig.name) ?? input.sourceId,
      kind: sourceConfig.kind,
      endpoint: sourceConfig.connection.endpoint.trim(),
      status:
        existingState?.status ??
        (sourceConfig.enabled ?? true ? "connected" : "draft"),
      enabled: sourceConfig.enabled ?? true,
      namespace: trimOrNull(sourceConfig.namespace) ?? input.sourceId,
      bindingVersion: adapter.bindingConfigVersion,
      binding: sourceConfig.binding,
      importAuthPolicy: adapter.defaultImportAuthPolicy,
      importAuth: { kind: "none" },
      auth: sourceAuthFromConfigInput({
        auth: sourceConfig.connection.auth,
        config: input.loadedConfig.config,
        existing: null,
      }),
      sourceHash: existingState?.sourceHash ?? null,
      lastError: existingState?.lastError ?? null,
      createdAt: existingState?.createdAt ?? Date.now(),
      updatedAt: existingState?.updatedAt ?? Date.now(),
    })) as Source;

    const runtimeAuthArtifact = selectPreferredAuthArtifact({
      authArtifacts: input.authArtifacts.filter(
        (artifactItem) => artifactItem.sourceId === baseSource.id,
      ),
      actorAccountId: input.actorAccountId,
      slot: "runtime",
    });
    const importAuthArtifact = selectPreferredAuthArtifact({
      authArtifacts: input.authArtifacts.filter(
        (artifactItem) => artifactItem.sourceId === baseSource.id,
      ),
      actorAccountId: input.actorAccountId,
      slot: "import",
    });

    const source: Source = {
      ...baseSource,
      auth:
        runtimeAuthArtifact === null
          ? baseSource.auth
          : sourceAuthFromAuthArtifact(runtimeAuthArtifact),
      importAuth:
        baseSource.importAuthPolicy === "separate"
          ? importAuthArtifact === null
            ? baseSource.importAuth
            : sourceAuthFromAuthArtifact(importAuthArtifact)
          : { kind: "none" },
    };

    return {
      source,
      sourceId: input.sourceId,
    };
  });

export const loadSourcesInWorkspaceWithDeps = (
  deps: RuntimeSourceStoreDeps,
  workspaceId: WorkspaceId,
  options: {
    actorAccountId?: AccountId | null;
  } = {},
): Effect.Effect<
  readonly Source[],
  | RuntimeLocalWorkspaceUnavailableError
  | RuntimeLocalWorkspaceMismatchError
  | LocalConfiguredSourceNotFoundError
  | Error,
  never
> =>
  Effect.gen(function* () {
    const localWorkspace = yield* resolveRuntimeLocalWorkspaceFromDeps(
      deps,
      workspaceId,
    );
    const authArtifacts = yield* deps.executorState.authArtifacts.listByWorkspaceId(
      workspaceId,
    );
    const sources = yield* Effect.forEach(
      Object.keys(localWorkspace.loadedConfig.config?.sources ?? {}),
      (sourceId) =>
        Effect.map(
          buildLocalSourceRecord({
            workspaceId,
            loadedConfig: localWorkspace.loadedConfig,
            workspaceState: localWorkspace.workspaceState,
            sourceId: SourceIdSchema.make(sourceId),
            actorAccountId: options.actorAccountId,
            authArtifacts,
          }),
          ({ source }) => source,
        ),
    );
    yield* Effect.annotateCurrentSpan("executor.source.count", sources.length);
    return sources;
  }).pipe(
    Effect.withSpan("source.store.load_workspace", {
      attributes: {
        "executor.workspace.id": workspaceId,
      },
    }),
  );

export const syncWorkspaceSourceTypeDeclarationsWithDeps = (
  deps: RuntimeSourceStoreDeps,
  workspaceId: WorkspaceId,
  options: {
    actorAccountId?: AccountId | null;
  } = {},
): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const localWorkspace = yield* resolveRuntimeLocalWorkspaceFromDeps(
      deps,
      workspaceId,
    );
    const sources = yield* loadSourcesInWorkspaceWithDeps(
      deps,
      workspaceId,
      options,
    );
    const entries = yield* Effect.forEach(sources, (source) =>
      Effect.map(
        deps.sourceArtifactStore.read({
          sourceId: source.id,
        }),
        (artifact) =>
          artifact === null
            ? null
            : {
                source,
                snapshot: artifact.snapshot,
              },
      ),
    );

    yield* deps.sourceTypeDeclarationsRefresher.refreshWorkspaceInBackground({
      entries: entries.filter(
        (entry): entry is NonNullable<typeof entry> => entry !== null,
      ),
    });
  }).pipe(
    Effect.withSpan("source.types.refresh_workspace.schedule", {
      attributes: {
        "executor.workspace.id": workspaceId,
      },
    }),
  );

export const shouldRefreshWorkspaceDeclarationsAfterPersist = (source: Source): boolean =>
  source.enabled === false ||
  source.status === "auth_required" ||
  source.status === "error" ||
  source.status === "draft";

export const listLinkedSecretSourcesInWorkspaceWithDeps = (
  deps: RuntimeSourceStoreDeps,
  workspaceId: WorkspaceId,
  options: {
    actorAccountId?: AccountId | null;
  } = {},
): Effect.Effect<
  Map<string, Array<{ sourceId: string; sourceName: string }>>,
  | RuntimeLocalWorkspaceUnavailableError
  | RuntimeLocalWorkspaceMismatchError
  | LocalConfiguredSourceNotFoundError
  | Error,
  never
> =>
  Effect.gen(function* () {
    const [sources, authArtifacts, materialIds] = yield* Effect.all([
      loadSourcesInWorkspaceWithDeps(deps, workspaceId, {
        actorAccountId: options.actorAccountId,
      }),
      deps.executorState.authArtifacts.listByWorkspaceId(workspaceId),
      deps.executorState.secretMaterials.listAll().pipe(
        Effect.map(
          (materials) => new Set(materials.map((material) => String(material.id))),
        ),
      ),
    ]);

    const sourceNames = new Map(
      sources.map((source) => [source.id, source.name] as const),
    );
    const linkedSources = new Map<
      string,
      Array<{ sourceId: string; sourceName: string }>
    >();

    for (const artifact of authArtifacts) {
      for (const ref of authArtifactSecretMaterialRefs(artifact)) {
        if (!materialIds.has(ref.handle)) {
          continue;
        }

        const existing = linkedSources.get(ref.handle) ?? [];
        if (!existing.some((link) => link.sourceId === artifact.sourceId)) {
          existing.push({
            sourceId: artifact.sourceId,
            sourceName: sourceNames.get(artifact.sourceId) ?? artifact.sourceId,
          });
          linkedSources.set(ref.handle, existing);
        }
      }
    }

    return linkedSources;
  });

export const loadSourceByIdWithDeps = (
  deps: RuntimeSourceStoreDeps,
  input: {
    workspaceId: WorkspaceId;
    sourceId: Source["id"];
    actorAccountId?: AccountId | null;
  },
): Effect.Effect<
  Source,
  | RuntimeLocalWorkspaceUnavailableError
  | RuntimeLocalWorkspaceMismatchError
  | LocalConfiguredSourceNotFoundError
  | Error,
  never
> =>
  Effect.gen(function* () {
    const localWorkspace = yield* resolveRuntimeLocalWorkspaceFromDeps(
      deps,
      input.workspaceId,
    );
    const authArtifacts = yield* deps.executorState.authArtifacts.listByWorkspaceId(
      input.workspaceId,
    );
    if (!localWorkspace.loadedConfig.config?.sources?.[input.sourceId]) {
      return yield* new LocalConfiguredSourceNotFoundError({
          message: `Source not found: workspaceId=${input.workspaceId} sourceId=${input.sourceId}`,
          sourceId: input.sourceId,
        });
    }

    const localSource = yield* buildLocalSourceRecord({
      workspaceId: input.workspaceId,
      loadedConfig: localWorkspace.loadedConfig,
      workspaceState: localWorkspace.workspaceState,
      sourceId: input.sourceId,
      actorAccountId: input.actorAccountId,
      authArtifacts,
    });

    return localSource.source;
  }).pipe(
    Effect.withSpan("source.store.load_by_id", {
      attributes: {
        "executor.workspace.id": input.workspaceId,
        "executor.source.id": input.sourceId,
      },
    }),
  );
