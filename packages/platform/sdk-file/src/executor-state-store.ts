import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";

import {
  type Execution,
  type ExecutionInteraction,
  type ExecutionStep,
  ExecutionInteractionSchema,
  ExecutionSchema,
  ExecutionStepSchema,
  SecretMaterialSchema,
  type SecretMaterial,
} from "@executor/platform-sdk/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ResolvedLocalWorkspaceContext } from "./config";
import { deriveLocalInstallation } from "./installation";
import {
  LocalFileSystemError,
  unknownLocalErrorDetails,
} from "./errors";

const LOCAL_EXECUTOR_STATE_VERSION = 1 as const;
const LOCAL_EXECUTOR_STATE_BASENAME = "executor-state.json";

const LocalExecutorStateSnapshotSchema = Schema.Struct({
  version: Schema.Literal(LOCAL_EXECUTOR_STATE_VERSION),
  secretMaterials: Schema.Array(SecretMaterialSchema),
  executions: Schema.Array(ExecutionSchema),
  executionInteractions: Schema.Array(ExecutionInteractionSchema),
  executionSteps: Schema.Array(ExecutionStepSchema),
});

export type LocalExecutorStateSnapshot = typeof LocalExecutorStateSnapshotSchema.Type;

export type LocalExecutorStatePersistence = {
  executorState: LocalExecutorStateStore;
  close: () => Promise<void>;
};

const decodeLocalExecutorStateSnapshot = Schema.decodeUnknown(
  LocalExecutorStateSnapshotSchema,
);

const defaultLocalExecutorStateSnapshot = (): LocalExecutorStateSnapshot => ({
  version: LOCAL_EXECUTOR_STATE_VERSION,
  secretMaterials: [],
  executions: [],
  executionInteractions: [],
  executionSteps: [],
});

const cloneValue = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

const asRecord = (
  value: unknown,
): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const migrateLegacyExecutorStateValue = (
  value: unknown,
): {
  value: unknown;
  migrated: boolean;
} => {
  if (Array.isArray(value)) {
    let migrated = false;
    const next = value.map((item) => {
      const result = migrateLegacyExecutorStateValue(item);
      migrated = migrated || result.migrated;
      return result.value;
    });
    return { value: next, migrated };
  }

  const record = asRecord(value);
  if (record === null) {
    return { value, migrated: false };
  }

  let migrated = false;
  const next: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(record)) {
    let nextKey = key;
    if (key === "workspaceId") {
      nextKey = "scopeId";
      migrated = true;
    } else if (key === "actorAccountId") {
      nextKey = "actorScopeId";
      migrated = true;
    } else if (key === "createdByAccountId") {
      nextKey = "createdByScopeId";
      migrated = true;
    } else if (key === "workspaceOauthClients") {
      nextKey = "scopeOauthClients";
      migrated = true;
    }

    const migratedEntry = migrateLegacyExecutorStateValue(entry);
    migrated = migrated || migratedEntry.migrated;
    next[nextKey] = migratedEntry.value;
  }

  return { value: next, migrated };
};

const mapFileSystemError = (path: string, action: string) => (cause: unknown) =>
  new LocalFileSystemError({
    message: `Failed to ${action} ${path}: ${unknownLocalErrorDetails(cause)}`,
    action,
    path,
    details: unknownLocalErrorDetails(cause),
  });

const sortByUpdatedAtAndIdDesc = <T extends { updatedAt: number; id: string }>(
  values: readonly T[],
): T[] =>
  [...values].sort((left, right) =>
    right.updatedAt - left.updatedAt || right.id.localeCompare(left.id),
  );

const localExecutorStatePath = (
  context: ResolvedLocalWorkspaceContext,
): string =>
  join(
    context.homeStateDirectory,
    "workspaces",
    deriveLocalInstallation(context).scopeId,
    LOCAL_EXECUTOR_STATE_BASENAME,
  );

const bindFileSystem = <A, E>(
  fileSystem: FileSystem.FileSystem,
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));

const bindNodeFileSystem = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(NodeFileSystem.layer));

const readStateFromDisk = (
  context: ResolvedLocalWorkspaceContext,
): Effect.Effect<LocalExecutorStateSnapshot, LocalFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = localExecutorStatePath(context);
    const exists = yield* fs.exists(path).pipe(
      Effect.mapError(mapFileSystemError(path, "check executor state path")),
    );
    if (!exists) {
      return defaultLocalExecutorStateSnapshot();
    }

    const content = yield* fs.readFileString(path, "utf8").pipe(
      Effect.mapError(mapFileSystemError(path, "read executor state")),
    );
    const parsed = yield* Effect.try({
      try: () => JSON.parse(content) as unknown,
      catch: mapFileSystemError(path, "parse executor state"),
    });
    const migrated = migrateLegacyExecutorStateValue(parsed);
    const decoded = yield* decodeLocalExecutorStateSnapshot(migrated.value).pipe(
      Effect.mapError(mapFileSystemError(path, "decode executor state")),
    );
    if (migrated.migrated) {
      yield* writeStateToDisk(context, decoded);
    }
    return decoded;
  });

const writeStateToDisk = (
  context: ResolvedLocalWorkspaceContext,
  state: LocalExecutorStateSnapshot,
): Effect.Effect<void, LocalFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = localExecutorStatePath(context);
    const tempPath = `${path}.${randomUUID()}.tmp`;

    yield* fs.makeDirectory(dirname(path), { recursive: true }).pipe(
      Effect.mapError(mapFileSystemError(dirname(path), "create executor state directory")),
    );
    yield* fs.writeFileString(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    }).pipe(
      Effect.mapError(mapFileSystemError(tempPath, "write executor state")),
    );
    yield* fs.rename(tempPath, path).pipe(
      Effect.mapError(mapFileSystemError(path, "replace executor state")),
    );
  });

export const loadLocalExecutorStateSnapshot = (
  context: ResolvedLocalWorkspaceContext,
): Effect.Effect<LocalExecutorStateSnapshot, LocalFileSystemError> =>
  bindNodeFileSystem(readStateFromDisk(context));

export const writeLocalExecutorStateSnapshot = (input: {
  context: ResolvedLocalWorkspaceContext;
  state: LocalExecutorStateSnapshot;
}): Effect.Effect<void, LocalFileSystemError> =>
  bindNodeFileSystem(writeStateToDisk(input.context, input.state));

const mergeById = <T extends { id: string }>(
  current: readonly T[],
  imported: readonly T[],
): T[] => {
  const merged = new Map<string, T>();

  for (const item of imported) {
    merged.set(item.id, cloneValue(item));
  }

  for (const item of current) {
    merged.set(item.id, cloneValue(item));
  }

  return [...merged.values()];
};

export const mergeImportedLocalExecutorStateSnapshot = (input: {
  current: LocalExecutorStateSnapshot;
  imported: Partial<Omit<LocalExecutorStateSnapshot, "version">>;
}): LocalExecutorStateSnapshot => ({
  version: LOCAL_EXECUTOR_STATE_VERSION,
  secretMaterials: mergeById(
    input.current.secretMaterials,
    input.imported.secretMaterials ?? [],
  ),
  executions: mergeById(input.current.executions, input.imported.executions ?? []),
  executionInteractions: mergeById(
    input.current.executionInteractions,
    input.imported.executionInteractions ?? [],
  ),
  executionSteps: mergeById(
    input.current.executionSteps,
    input.imported.executionSteps ?? [],
  ),
});

type StateMutationResult<A> = {
  state: LocalExecutorStateSnapshot;
  value: A;
};

const createStateManager = (
  context: ResolvedLocalWorkspaceContext,
  fileSystem: FileSystem.FileSystem,
) => {
  let cache: LocalExecutorStateSnapshot | null = null;
  let mutationQueue: Promise<void> = Promise.resolve();
  const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
    Effect.runPromise(bindFileSystem(fileSystem, effect));

  const ensureLoaded = async (): Promise<LocalExecutorStateSnapshot> => {
    if (cache !== null) {
      return cache;
    }

    cache = await run(readStateFromDisk(context));
    return cache;
  };

  const read = <A>(
    operation: (state: LocalExecutorStateSnapshot) => A | Promise<A>,
  ): Effect.Effect<A, LocalFileSystemError> =>
    Effect.tryPromise({
      try: async () => {
        await mutationQueue;
        return operation(cloneValue(await ensureLoaded()));
      },
      catch: mapFileSystemError(
        localExecutorStatePath(context),
        "read executor state",
      ),
    });

  const mutate = <A>(
    operation: (
      state: LocalExecutorStateSnapshot,
    ) => StateMutationResult<A> | Promise<StateMutationResult<A>>,
  ): Effect.Effect<A, LocalFileSystemError> =>
    Effect.tryPromise({
      try: async () => {
        let value!: A;
        let failure: unknown = null;

        mutationQueue = mutationQueue.then(async () => {
          try {
            const current = cloneValue(await ensureLoaded());
            const result = await operation(current);
            cache = result.state;
            value = result.value;
            await run(writeStateToDisk(context, cache));
          } catch (cause) {
            failure = cause;
          }
        });

        await mutationQueue;

        if (failure !== null) {
          throw failure;
        }

        return value;
      },
      catch: mapFileSystemError(
        localExecutorStatePath(context),
        "write executor state",
      ),
    });

  return {
    read,
    mutate,
  };
};

export const createLocalExecutorStateStore = (
  context: ResolvedLocalWorkspaceContext,
  fileSystem: FileSystem.FileSystem,
) => {
  const stateManager = createStateManager(context, fileSystem);

  return {
    secretMaterials: {
      getById: (id: SecretMaterial["id"]) =>
        stateManager.read((state) => {
          const material = state.secretMaterials.find(
            (candidate) => candidate.id === id,
          );
          return material
            ? Option.some(cloneValue(material))
            : Option.none<SecretMaterial>();
        }),

      listAll: () =>
        stateManager.read((state) => sortByUpdatedAtAndIdDesc(state.secretMaterials)),

      upsert: (material: SecretMaterial) =>
        stateManager.mutate((state) => {
          const nextMaterials = state.secretMaterials.filter(
            (candidate) => candidate.id !== material.id,
          );
          nextMaterials.push(cloneValue(material));

          return {
            state: {
              ...state,
              secretMaterials: nextMaterials,
            },
            value: undefined,
          } satisfies StateMutationResult<void>;
        }),

      updateById: (
        id: SecretMaterial["id"],
        update: { name?: string | null; value?: string },
      ) =>
        stateManager.mutate((state) => {
          let updated: SecretMaterial | null = null;
          const nextMaterials = state.secretMaterials.map((material) => {
            if (material.id !== id) {
              return material;
            }

            updated = {
              ...material,
              ...(update.name !== undefined ? { name: update.name } : {}),
              ...(update.value !== undefined ? { value: update.value } : {}),
              updatedAt: Date.now(),
            } satisfies SecretMaterial;
            return updated;
          });

          return {
            state: {
              ...state,
              secretMaterials: nextMaterials,
            },
            value: updated ? Option.some(cloneValue(updated)) : Option.none<SecretMaterial>(),
          } satisfies StateMutationResult<Option.Option<SecretMaterial>>;
        }),

      removeById: (id: SecretMaterial["id"]) =>
        stateManager.mutate((state) => {
          const nextMaterials = state.secretMaterials.filter(
            (candidate) => candidate.id !== id,
          );

          return {
            state: {
              ...state,
              secretMaterials: nextMaterials,
            },
            value: nextMaterials.length !== state.secretMaterials.length,
          } satisfies StateMutationResult<boolean>;
        }),
    },
    executions: {
      listByScope: (scopeId: Execution["scopeId"]) =>
        stateManager.read((state) =>
          cloneValue(
            state.executions
              .filter((candidate) => candidate.scopeId === scopeId)
              .sort((left, right) => right.createdAt - left.createdAt),
          )
        ),

      getById: (executionId: Execution["id"]) =>
        stateManager.read((state) => {
          const execution = state.executions.find(
            (candidate) => candidate.id === executionId,
          );
          return execution
            ? Option.some(cloneValue(execution))
            : Option.none<Execution>();
        }),

      getByScopeAndId: (
        scopeId: Execution["scopeId"],
        executionId: Execution["id"],
      ) =>
        stateManager.read((state) => {
          const execution = state.executions.find(
            (candidate) =>
              candidate.scopeId === scopeId && candidate.id === executionId,
          );
          return execution
            ? Option.some(cloneValue(execution))
            : Option.none<Execution>();
        }),

      insert: (execution: Execution) =>
        stateManager.mutate((state) => ({
          state: {
            ...state,
            executions: [...state.executions, cloneValue(execution)],
          },
          value: undefined,
        } satisfies StateMutationResult<void>)),

      update: (
        executionId: Execution["id"],
        patch: Partial<
          Omit<Execution, "id" | "scopeId" | "createdByAccountId" | "createdAt">
        >,
      ) =>
        stateManager.mutate((state) => {
          let updated: Execution | null = null;
          const nextExecutions = state.executions.map((execution) => {
            if (execution.id !== executionId) {
              return execution;
            }

            updated = {
              ...execution,
              ...cloneValue(patch),
            } satisfies Execution;
            return updated;
          });

          return {
            state: {
              ...state,
              executions: nextExecutions,
            },
            value: updated ? Option.some(cloneValue(updated)) : Option.none<Execution>(),
          } satisfies StateMutationResult<Option.Option<Execution>>;
        }),
    },

    executionInteractions: {
      getById: (interactionId: ExecutionInteraction["id"]) =>
        stateManager.read((state) => {
          const interaction = state.executionInteractions.find(
            (candidate) => candidate.id === interactionId,
          );
          return interaction
            ? Option.some(cloneValue(interaction))
            : Option.none<ExecutionInteraction>();
        }),

      listByExecutionId: (executionId: ExecutionInteraction["executionId"]) =>
        stateManager.read((state) =>
          sortByUpdatedAtAndIdDesc(
            state.executionInteractions.filter(
              (interaction) => interaction.executionId === executionId,
            ),
          ),
        ),

      getPendingByExecutionId: (executionId: ExecutionInteraction["executionId"]) =>
        stateManager.read((state) => {
          const interaction = sortByUpdatedAtAndIdDesc(
            state.executionInteractions.filter(
              (candidate) =>
                candidate.executionId === executionId && candidate.status === "pending",
            ),
          )[0] ?? null;

          return interaction
            ? Option.some(cloneValue(interaction))
            : Option.none<ExecutionInteraction>();
        }),

      insert: (interaction: ExecutionInteraction) =>
        stateManager.mutate((state) => ({
          state: {
            ...state,
            executionInteractions: [
              ...state.executionInteractions,
              cloneValue(interaction),
            ],
          },
          value: undefined,
        } satisfies StateMutationResult<void>)),

      update: (
        interactionId: ExecutionInteraction["id"],
        patch: Partial<
          Omit<
            ExecutionInteraction,
            "id" | "executionId" | "createdAt"
          >
        >,
      ) =>
        stateManager.mutate((state) => {
          let updated: ExecutionInteraction | null = null;
          const nextInteractions = state.executionInteractions.map((interaction) => {
            if (interaction.id !== interactionId) {
              return interaction;
            }

            updated = {
              ...interaction,
              ...cloneValue(patch),
            } as ExecutionInteraction;
            return updated;
          });

          return {
            state: {
              ...state,
              executionInteractions: nextInteractions,
            },
            value: updated
              ? Option.some(cloneValue(updated))
              : Option.none<ExecutionInteraction>(),
          } satisfies StateMutationResult<Option.Option<ExecutionInteraction>>;
        }),
    },

    executionSteps: {
      getByExecutionAndSequence: (
        executionId: ExecutionStep["executionId"],
        sequence: ExecutionStep["sequence"],
      ) =>
        stateManager.read((state) => {
          const step = state.executionSteps.find(
            (candidate) =>
              candidate.executionId === executionId && candidate.sequence === sequence,
          );
          return step
            ? Option.some(cloneValue(step))
            : Option.none<ExecutionStep>();
        }),

      listByExecutionId: (executionId: ExecutionStep["executionId"]) =>
        stateManager.read((state) =>
          [...state.executionSteps]
            .filter((step) => step.executionId === executionId)
            .sort(
              (left, right) =>
                left.sequence - right.sequence
                || right.updatedAt - left.updatedAt,
            ),
        ),

      insert: (step: ExecutionStep) =>
        stateManager.mutate((state) => ({
          state: {
            ...state,
            executionSteps: [...state.executionSteps, cloneValue(step)],
          },
          value: undefined,
        } satisfies StateMutationResult<void>)),

      deleteByExecutionId: (executionId: ExecutionStep["executionId"]) =>
        stateManager.mutate((state) => ({
          state: {
            ...state,
            executionSteps: state.executionSteps.filter(
              (step) => step.executionId !== executionId,
            ),
          },
          value: undefined,
        } satisfies StateMutationResult<void>)),

      updateByExecutionAndSequence: (
        executionId: ExecutionStep["executionId"],
        sequence: ExecutionStep["sequence"],
        patch: Partial<
          Omit<
            ExecutionStep,
            "id" | "executionId" | "sequence" | "createdAt"
          >
        >,
      ) =>
        stateManager.mutate((state) => {
          let updated: ExecutionStep | null = null;
          const nextSteps = state.executionSteps.map((step) => {
            if (step.executionId !== executionId || step.sequence !== sequence) {
              return step;
            }

            updated = {
              ...step,
              ...cloneValue(patch),
            } as ExecutionStep;
            return updated;
          });

          return {
            state: {
              ...state,
              executionSteps: nextSteps,
            },
            value: updated
              ? Option.some(cloneValue(updated))
              : Option.none<ExecutionStep>(),
          } satisfies StateMutationResult<Option.Option<ExecutionStep>>;
        }),
    },
  };
};

export type LocalExecutorStateStore = ReturnType<typeof createLocalExecutorStateStore>;

export const createLocalExecutorStatePersistence = (
  context: ResolvedLocalWorkspaceContext,
  fileSystem: FileSystem.FileSystem,
): LocalExecutorStatePersistence => ({
  executorState: createLocalExecutorStateStore(context, fileSystem),
  close: async () => {},
});

export { localExecutorStatePath };
