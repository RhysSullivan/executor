import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";

import {
  AuthArtifactSchema,
  AuthLeaseSchema,
  type AuthArtifact,
  type AuthLease,
  type Execution,
  type ExecutionInteraction,
  type ExecutionStep,
  ExecutionInteractionSchema,
  ExecutionSchema,
  ExecutionStepSchema,
  type ProviderAuthGrant,
  ProviderAuthGrantSchema,
  SecretMaterialSchema,
  type SecretMaterial,
  type SourceAuthSession,
  SourceAuthSessionSchema,
  type WorkspaceOauthClient,
  WorkspaceOauthClientSchema,
  type WorkspaceSourceOauthClient,
  WorkspaceSourceOauthClientSchema,
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
  authArtifacts: Schema.Array(AuthArtifactSchema),
  authLeases: Schema.Array(AuthLeaseSchema),
  sourceOauthClients: Schema.Array(WorkspaceSourceOauthClientSchema),
  workspaceOauthClients: Schema.Array(WorkspaceOauthClientSchema),
  providerAuthGrants: Schema.Array(ProviderAuthGrantSchema),
  sourceAuthSessions: Schema.Array(SourceAuthSessionSchema),
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
  authArtifacts: [],
  authLeases: [],
  sourceOauthClients: [],
  workspaceOauthClients: [],
  providerAuthGrants: [],
  sourceAuthSessions: [],
  secretMaterials: [],
  executions: [],
  executionInteractions: [],
  executionSteps: [],
});

const cloneValue = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

const mapFileSystemError = (path: string, action: string) => (cause: unknown) =>
  new LocalFileSystemError({
    message: `Failed to ${action} ${path}: ${unknownLocalErrorDetails(cause)}`,
    action,
    path,
    details: unknownLocalErrorDetails(cause),
  });

const actorEquals = (
  left: string | null | undefined,
  right: string | null | undefined,
): boolean => (left ?? null) === (right ?? null);

const sortByUpdatedAtAndIdAsc = <T extends { updatedAt: number; id: string }>(
  values: readonly T[],
): T[] =>
  [...values].sort((left, right) =>
    left.updatedAt - right.updatedAt || left.id.localeCompare(right.id),
  );

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
    deriveLocalInstallation(context).workspaceId,
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
    return yield* decodeLocalExecutorStateSnapshot(parsed).pipe(
      Effect.mapError(mapFileSystemError(path, "decode executor state")),
    );
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

const mergeAuthLeases = (
  current: readonly AuthLease[],
  imported: readonly AuthLease[],
): AuthLease[] => {
  const merged = new Map<string, AuthLease>();

  for (const lease of imported) {
    merged.set(lease.authArtifactId, cloneValue(lease));
  }

  for (const lease of current) {
    merged.set(lease.authArtifactId, cloneValue(lease));
  }

  return [...merged.values()];
};

const mergeAuthArtifacts = (
  current: readonly AuthArtifact[],
  imported: readonly AuthArtifact[],
): AuthArtifact[] => {
  const merged = new Map<string, AuthArtifact>();

  for (const artifact of imported) {
    merged.set(
      [
        artifact.workspaceId,
        artifact.sourceId,
        artifact.actorAccountId ?? "",
        artifact.slot,
      ].join("::"),
      cloneValue(artifact),
    );
  }

  for (const artifact of current) {
    merged.set(
      [
        artifact.workspaceId,
        artifact.sourceId,
        artifact.actorAccountId ?? "",
        artifact.slot,
      ].join("::"),
      cloneValue(artifact),
    );
  }

  return [...merged.values()];
};

const mergeSourceOauthClients = (
  current: readonly WorkspaceSourceOauthClient[],
  imported: readonly WorkspaceSourceOauthClient[],
): WorkspaceSourceOauthClient[] => {
  const merged = new Map<string, WorkspaceSourceOauthClient>();

  for (const oauthClient of imported) {
    merged.set(
      [oauthClient.workspaceId, oauthClient.sourceId, oauthClient.providerKey].join(
        "::",
      ),
      cloneValue(oauthClient),
    );
  }

  for (const oauthClient of current) {
    merged.set(
      [oauthClient.workspaceId, oauthClient.sourceId, oauthClient.providerKey].join(
        "::",
      ),
      cloneValue(oauthClient),
    );
  }

  return [...merged.values()];
};

const mergeWorkspaceOauthClients = (
  current: readonly WorkspaceOauthClient[],
  imported: readonly WorkspaceOauthClient[],
): WorkspaceOauthClient[] => {
  const merged = new Map<string, WorkspaceOauthClient>();

  for (const oauthClient of imported) {
    merged.set(
      [oauthClient.workspaceId, oauthClient.providerKey, oauthClient.id].join("::"),
      cloneValue(oauthClient),
    );
  }

  for (const oauthClient of current) {
    merged.set(
      [oauthClient.workspaceId, oauthClient.providerKey, oauthClient.id].join("::"),
      cloneValue(oauthClient),
    );
  }

  return [...merged.values()];
};

const mergeProviderAuthGrants = (
  current: readonly ProviderAuthGrant[],
  imported: readonly ProviderAuthGrant[],
): ProviderAuthGrant[] => mergeById(current, imported);

export const mergeImportedLocalExecutorStateSnapshot = (input: {
  current: LocalExecutorStateSnapshot;
  imported: Partial<Omit<LocalExecutorStateSnapshot, "version">>;
}): LocalExecutorStateSnapshot => ({
  version: LOCAL_EXECUTOR_STATE_VERSION,
  authArtifacts: mergeAuthArtifacts(
    input.current.authArtifacts,
    input.imported.authArtifacts ?? [],
  ),
  authLeases: mergeAuthLeases(
    input.current.authLeases,
    input.imported.authLeases ?? [],
  ),
  sourceOauthClients: mergeSourceOauthClients(
    input.current.sourceOauthClients,
    input.imported.sourceOauthClients ?? [],
  ),
  workspaceOauthClients: mergeWorkspaceOauthClients(
    input.current.workspaceOauthClients,
    input.imported.workspaceOauthClients ?? [],
  ),
  providerAuthGrants: mergeProviderAuthGrants(
    input.current.providerAuthGrants,
    input.imported.providerAuthGrants ?? [],
  ),
  sourceAuthSessions: mergeById(
    input.current.sourceAuthSessions,
    input.imported.sourceAuthSessions ?? [],
  ),
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
    authArtifacts: {
      listByWorkspaceId: (workspaceId: AuthArtifact["workspaceId"]) =>
        stateManager.read((state) =>
          sortByUpdatedAtAndIdAsc(
            state.authArtifacts.filter((artifact) => artifact.workspaceId === workspaceId),
          ),
        ),

      listByWorkspaceAndSourceId: (input: {
        workspaceId: AuthArtifact["workspaceId"];
        sourceId: AuthArtifact["sourceId"];
      }) =>
        stateManager.read((state) =>
          sortByUpdatedAtAndIdAsc(
            state.authArtifacts.filter(
              (artifact) =>
                artifact.workspaceId === input.workspaceId
                && artifact.sourceId === input.sourceId,
            ),
          ),
        ),

      getByWorkspaceSourceAndActor: (input: {
        workspaceId: AuthArtifact["workspaceId"];
        sourceId: AuthArtifact["sourceId"];
        actorAccountId: AuthArtifact["actorAccountId"];
        slot: AuthArtifact["slot"];
      }) =>
        stateManager.read((state) => {
          const artifact = state.authArtifacts.find(
            (candidate) =>
              candidate.workspaceId === input.workspaceId
              && candidate.sourceId === input.sourceId
              && candidate.slot === input.slot
              && actorEquals(candidate.actorAccountId, input.actorAccountId),
          );

          return artifact ? Option.some(cloneValue(artifact)) : Option.none<AuthArtifact>();
        }),

      upsert: (artifact: AuthArtifact) =>
        stateManager.mutate((state) => {
          const nextArtifacts = state.authArtifacts.filter(
            (candidate) =>
              !(
                candidate.workspaceId === artifact.workspaceId
                && candidate.sourceId === artifact.sourceId
                && candidate.slot === artifact.slot
                && actorEquals(candidate.actorAccountId, artifact.actorAccountId)
              ),
          );
          nextArtifacts.push(cloneValue(artifact));

          return {
            state: {
              ...state,
              authArtifacts: nextArtifacts,
            },
            value: undefined,
          } satisfies StateMutationResult<void>;
        }),

      removeByWorkspaceSourceAndActor: (input: {
        workspaceId: AuthArtifact["workspaceId"];
        sourceId: AuthArtifact["sourceId"];
        actorAccountId: AuthArtifact["actorAccountId"];
        slot?: AuthArtifact["slot"];
      }) =>
        stateManager.mutate((state) => {
          const nextArtifacts = state.authArtifacts.filter(
            (candidate) =>
              candidate.workspaceId !== input.workspaceId
              || candidate.sourceId !== input.sourceId
              || !actorEquals(candidate.actorAccountId, input.actorAccountId)
              || (input.slot !== undefined && candidate.slot !== input.slot),
          );

          return {
            state: {
              ...state,
              authArtifacts: nextArtifacts,
            },
            value: nextArtifacts.length !== state.authArtifacts.length,
          } satisfies StateMutationResult<boolean>;
        }),

      removeByWorkspaceAndSourceId: (input: {
        workspaceId: AuthArtifact["workspaceId"];
        sourceId: AuthArtifact["sourceId"];
      }) =>
        stateManager.mutate((state) => {
          const nextArtifacts = state.authArtifacts.filter(
            (candidate) =>
              candidate.workspaceId !== input.workspaceId
              || candidate.sourceId !== input.sourceId,
          );

          return {
            state: {
              ...state,
              authArtifacts: nextArtifacts,
            },
            value: state.authArtifacts.length - nextArtifacts.length,
          } satisfies StateMutationResult<number>;
        }),
    },

    authLeases: {
      listAll: () =>
        stateManager.read((state) => sortByUpdatedAtAndIdAsc(state.authLeases)),

      getByAuthArtifactId: (authArtifactId: AuthLease["authArtifactId"]) =>
        stateManager.read((state) => {
          const lease = state.authLeases.find(
            (candidate) => candidate.authArtifactId === authArtifactId,
          );
          return lease ? Option.some(cloneValue(lease)) : Option.none<AuthLease>();
        }),

      upsert: (lease: AuthLease) =>
        stateManager.mutate((state) => {
          const nextLeases = state.authLeases.filter(
            (candidate) => candidate.authArtifactId !== lease.authArtifactId,
          );
          nextLeases.push(cloneValue(lease));

          return {
            state: {
              ...state,
              authLeases: nextLeases,
            },
            value: undefined,
          } satisfies StateMutationResult<void>;
        }),

      removeByAuthArtifactId: (authArtifactId: AuthLease["authArtifactId"]) =>
        stateManager.mutate((state) => {
          const nextLeases = state.authLeases.filter(
            (candidate) => candidate.authArtifactId !== authArtifactId,
          );

          return {
            state: {
              ...state,
              authLeases: nextLeases,
            },
            value: nextLeases.length !== state.authLeases.length,
          } satisfies StateMutationResult<boolean>;
        }),
    },

    sourceOauthClients: {
      getByWorkspaceSourceAndProvider: (input: {
        workspaceId: WorkspaceSourceOauthClient["workspaceId"];
        sourceId: WorkspaceSourceOauthClient["sourceId"];
        providerKey: string;
      }) =>
        stateManager.read((state) => {
          const oauthClient = state.sourceOauthClients.find(
            (candidate) =>
              candidate.workspaceId === input.workspaceId
              && candidate.sourceId === input.sourceId
              && candidate.providerKey === input.providerKey,
          );

          return oauthClient
            ? Option.some(cloneValue(oauthClient))
            : Option.none<WorkspaceSourceOauthClient>();
        }),

      upsert: (oauthClient: WorkspaceSourceOauthClient) =>
        stateManager.mutate((state) => {
          const nextOauthClients = state.sourceOauthClients.filter(
            (candidate) =>
              !(
                candidate.workspaceId === oauthClient.workspaceId
                && candidate.sourceId === oauthClient.sourceId
                && candidate.providerKey === oauthClient.providerKey
              ),
          );
          nextOauthClients.push(cloneValue(oauthClient));

          return {
            state: {
              ...state,
              sourceOauthClients: nextOauthClients,
            },
            value: undefined,
          } satisfies StateMutationResult<void>;
        }),

      removeByWorkspaceAndSourceId: (input: {
        workspaceId: WorkspaceSourceOauthClient["workspaceId"];
        sourceId: WorkspaceSourceOauthClient["sourceId"];
      }) =>
        stateManager.mutate((state) => {
          const nextOauthClients = state.sourceOauthClients.filter(
            (candidate) =>
              candidate.workspaceId !== input.workspaceId
              || candidate.sourceId !== input.sourceId,
          );

          return {
            state: {
              ...state,
              sourceOauthClients: nextOauthClients,
            },
            value: state.sourceOauthClients.length - nextOauthClients.length,
          } satisfies StateMutationResult<number>;
        }),
    },

    workspaceOauthClients: {
      listByWorkspaceAndProvider: (input: {
        workspaceId: WorkspaceOauthClient["workspaceId"];
        providerKey: string;
      }) =>
        stateManager.read((state) =>
          sortByUpdatedAtAndIdAsc(
            state.workspaceOauthClients.filter(
              (candidate) =>
                candidate.workspaceId === input.workspaceId
                && candidate.providerKey === input.providerKey,
            ),
          ),
        ),

      getById: (id: WorkspaceOauthClient["id"]) =>
        stateManager.read((state) => {
          const oauthClient = state.workspaceOauthClients.find(
            (candidate) => candidate.id === id,
          );

          return oauthClient
            ? Option.some(cloneValue(oauthClient))
            : Option.none<WorkspaceOauthClient>();
        }),

      upsert: (oauthClient: WorkspaceOauthClient) =>
        stateManager.mutate((state) => {
          const nextOauthClients = state.workspaceOauthClients.filter(
            (candidate) => candidate.id !== oauthClient.id,
          );
          nextOauthClients.push(cloneValue(oauthClient));

          return {
            state: {
              ...state,
              workspaceOauthClients: nextOauthClients,
            },
            value: undefined,
          } satisfies StateMutationResult<void>;
        }),

      removeById: (id: WorkspaceOauthClient["id"]) =>
        stateManager.mutate((state) => {
          const nextOauthClients = state.workspaceOauthClients.filter(
            (candidate) => candidate.id !== id,
          );

          return {
            state: {
              ...state,
              workspaceOauthClients: nextOauthClients,
            },
            value: nextOauthClients.length !== state.workspaceOauthClients.length,
          } satisfies StateMutationResult<boolean>;
        }),
    },

    providerAuthGrants: {
      listByWorkspaceId: (workspaceId: ProviderAuthGrant["workspaceId"]) =>
        stateManager.read((state) =>
          sortByUpdatedAtAndIdAsc(
            state.providerAuthGrants.filter(
              (grant) => grant.workspaceId === workspaceId,
            ),
          ),
        ),

      listByWorkspaceActorAndProvider: (input: {
        workspaceId: ProviderAuthGrant["workspaceId"];
        actorAccountId: ProviderAuthGrant["actorAccountId"];
        providerKey: string;
      }) =>
        stateManager.read((state) =>
          sortByUpdatedAtAndIdAsc(
            state.providerAuthGrants.filter(
              (grant) =>
                grant.workspaceId === input.workspaceId
                && grant.providerKey === input.providerKey
                && actorEquals(grant.actorAccountId, input.actorAccountId),
            ),
          ),
        ),

      getById: (id: ProviderAuthGrant["id"]) =>
        stateManager.read((state) => {
          const grant = state.providerAuthGrants.find(
            (candidate) => candidate.id === id,
          );

          return grant
            ? Option.some(cloneValue(grant))
            : Option.none<ProviderAuthGrant>();
        }),

      upsert: (grant: ProviderAuthGrant) =>
        stateManager.mutate((state) => {
          const nextGrants = state.providerAuthGrants.filter(
            (candidate) => candidate.id !== grant.id,
          );
          nextGrants.push(cloneValue(grant));

          return {
            state: {
              ...state,
              providerAuthGrants: nextGrants,
            },
            value: undefined,
          } satisfies StateMutationResult<void>;
        }),

      removeById: (id: ProviderAuthGrant["id"]) =>
        stateManager.mutate((state) => {
          const nextGrants = state.providerAuthGrants.filter(
            (candidate) => candidate.id !== id,
          );

          return {
            state: {
              ...state,
              providerAuthGrants: nextGrants,
            },
            value: nextGrants.length !== state.providerAuthGrants.length,
          } satisfies StateMutationResult<boolean>;
        }),
    },

    sourceAuthSessions: {
      listAll: () =>
        stateManager.read((state) => sortByUpdatedAtAndIdAsc(state.sourceAuthSessions)),

      listByWorkspaceId: (workspaceId: SourceAuthSession["workspaceId"]) =>
        stateManager.read((state) =>
          sortByUpdatedAtAndIdAsc(
            state.sourceAuthSessions.filter(
              (session) => session.workspaceId === workspaceId,
            ),
          ),
        ),

      getById: (id: SourceAuthSession["id"]) =>
        stateManager.read((state) => {
          const session = state.sourceAuthSessions.find(
            (candidate) => candidate.id === id,
          );
          return session
            ? Option.some(cloneValue(session))
            : Option.none<SourceAuthSession>();
        }),

      getByState: (stateValue: SourceAuthSession["state"]) =>
        stateManager.read((state) => {
          const session = state.sourceAuthSessions.find(
            (candidate) => candidate.state === stateValue,
          );
          return session
            ? Option.some(cloneValue(session))
            : Option.none<SourceAuthSession>();
        }),

      getPendingByWorkspaceSourceAndActor: (input: {
        workspaceId: SourceAuthSession["workspaceId"];
        sourceId: SourceAuthSession["sourceId"];
        actorAccountId: SourceAuthSession["actorAccountId"];
        credentialSlot?: SourceAuthSession["credentialSlot"];
      }) =>
        stateManager.read((state) => {
          const session = sortByUpdatedAtAndIdAsc(
            state.sourceAuthSessions.filter(
              (candidate) =>
                candidate.workspaceId === input.workspaceId
                && candidate.sourceId === input.sourceId
                && candidate.status === "pending"
                && actorEquals(candidate.actorAccountId, input.actorAccountId)
                && (input.credentialSlot === undefined
                  || candidate.credentialSlot === input.credentialSlot),
            ),
          )[0] ?? null;

          return session
            ? Option.some(cloneValue(session))
            : Option.none<SourceAuthSession>();
        }),

      insert: (session: SourceAuthSession) =>
        stateManager.mutate((state) => ({
          state: {
            ...state,
            sourceAuthSessions: [...state.sourceAuthSessions, cloneValue(session)],
          },
          value: undefined,
        } satisfies StateMutationResult<void>)),

      update: (
        id: SourceAuthSession["id"],
        patch: Partial<Omit<SourceAuthSession, "id" | "workspaceId" | "sourceId" | "createdAt">>,
      ) =>
        stateManager.mutate((state) => {
          let updated: SourceAuthSession | null = null;
          const nextSessions = state.sourceAuthSessions.map((session) => {
            if (session.id !== id) {
              return session;
            }

            updated = {
              ...session,
              ...cloneValue(patch),
            } satisfies SourceAuthSession;
            return updated;
          });

          return {
            state: {
              ...state,
              sourceAuthSessions: nextSessions,
            },
            value: updated ? Option.some(cloneValue(updated)) : Option.none<SourceAuthSession>(),
          } satisfies StateMutationResult<Option.Option<SourceAuthSession>>;
        }),

      upsert: (session: SourceAuthSession) =>
        stateManager.mutate((state) => {
          const nextSessions = state.sourceAuthSessions.filter(
            (candidate) => candidate.id !== session.id,
          );
          nextSessions.push(cloneValue(session));

          return {
            state: {
              ...state,
              sourceAuthSessions: nextSessions,
            },
            value: undefined,
          } satisfies StateMutationResult<void>;
        }),

      removeByWorkspaceAndSourceId: (
        workspaceId: SourceAuthSession["workspaceId"],
        sourceId: SourceAuthSession["sourceId"],
      ) =>
        stateManager.mutate((state) => {
          const nextSessions = state.sourceAuthSessions.filter(
            (candidate) =>
              candidate.workspaceId !== workspaceId || candidate.sourceId !== sourceId,
          );

          return {
            state: {
              ...state,
              sourceAuthSessions: nextSessions,
            },
            value: nextSessions.length !== state.sourceAuthSessions.length,
          } satisfies StateMutationResult<boolean>;
        }),
    },

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
      getById: (executionId: Execution["id"]) =>
        stateManager.read((state) => {
          const execution = state.executions.find(
            (candidate) => candidate.id === executionId,
          );
          return execution
            ? Option.some(cloneValue(execution))
            : Option.none<Execution>();
        }),

      getByWorkspaceAndId: (
        workspaceId: Execution["workspaceId"],
        executionId: Execution["id"],
      ) =>
        stateManager.read((state) => {
          const execution = state.executions.find(
            (candidate) =>
              candidate.workspaceId === workspaceId && candidate.id === executionId,
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
          Omit<Execution, "id" | "workspaceId" | "createdByAccountId" | "createdAt">
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
