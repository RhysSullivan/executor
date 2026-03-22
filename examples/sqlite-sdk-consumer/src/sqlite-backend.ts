import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

import { Database } from "bun:sqlite";
import {
  createExecutor,
  createExecutorBackend,
  type CreateExecutorOptions,
  type Executor,
  type ExecutorBackend,
  type ExecutorBackendServices,
  type ExecutorStateBackend,
  type ExecutorInstallationBackend,
  type ExecutorLocalToolBackend,
  type ExecutorSecretMaterialBackend,
  type ExecutorSourceArtifactBackend,
  type ExecutorSourceTypeDeclarationsBackend,
  type ExecutorWorkspaceConfigBackend,
  type ExecutorWorkspaceStateBackend,
} from "@executor/platform-sdk";
import type { ExecutorRuntimeOptions } from "@executor/platform-sdk/runtime";
import {
  type AuthArtifact,
  AccountIdSchema,
  AuthArtifactSchema,
  type AuthLease,
  AuthLeaseSchema,
  type Execution,
  type ExecutionInteraction,
  ExecutionInteractionSchema,
  type ExecutionStep,
  ExecutionSchema,
  ExecutionStepSchema,
  type LocalInstallation,
  LocalExecutorConfigSchema,
  LocalInstallationSchema,
  type ProviderAuthGrant,
  ProviderAuthGrantSchema,
  SecretMaterialIdSchema,
  SecretMaterialSchema,
  type SourceAuthSession,
  SourceAuthSessionSchema,
  SourceCatalogIdSchema,
  SourceCatalogRevisionIdSchema,
  WorkspaceIdSchema,
  type WorkspaceOauthClient,
  WorkspaceOauthClientSchema,
  type WorkspaceSourceOauthClient,
  WorkspaceSourceOauthClientSchema,
  type SecretMaterial,
  type SecretRef,
} from "@executor/platform-sdk/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { contentHash, snapshotFromSourceCatalogSyncResult } from "@executor/source-core";

export type CreateSqliteExecutorBackendOptions = {
  databasePath?: string;
  workspaceName?: string;
  workspaceRoot?: string | null;
  workspaceId?: string;
  accountId?: string;
};

type DocumentNamespace =
  | "installation"
  | "workspace_config"
  | "workspace_state"
  | "source_artifact"
  | "executor_state";

type ExecutorStateCollections = {
  authArtifacts: readonly AuthArtifact[];
  authLeases: readonly AuthLease[];
  sourceOauthClients: readonly WorkspaceSourceOauthClient[];
  workspaceOauthClients: readonly WorkspaceOauthClient[];
  providerAuthGrants: readonly ProviderAuthGrant[];
  sourceAuthSessions: readonly SourceAuthSession[];
  secretMaterials: readonly SecretMaterial[];
  executions: readonly Execution[];
  executionInteractions: readonly ExecutionInteraction[];
  executionSteps: readonly ExecutionStep[];
};

const decodeInstallation = Schema.decodeUnknownSync(LocalInstallationSchema);
const decodeConfig = Schema.decodeUnknownSync(LocalExecutorConfigSchema);
const decodeAuthArtifacts = Schema.decodeUnknownSync(Schema.Array(AuthArtifactSchema));
const decodeAuthLeases = Schema.decodeUnknownSync(Schema.Array(AuthLeaseSchema));
const decodeSourceOauthClients = Schema.decodeUnknownSync(
  Schema.Array(WorkspaceSourceOauthClientSchema),
);
const decodeWorkspaceOauthClients = Schema.decodeUnknownSync(
  Schema.Array(WorkspaceOauthClientSchema),
);
const decodeProviderAuthGrants = Schema.decodeUnknownSync(
  Schema.Array(ProviderAuthGrantSchema),
);
const decodeSourceAuthSessions = Schema.decodeUnknownSync(
  Schema.Array(SourceAuthSessionSchema),
);
const decodeSecretMaterials = Schema.decodeUnknownSync(
  Schema.Array(SecretMaterialSchema),
);
const decodeExecutions = Schema.decodeUnknownSync(Schema.Array(ExecutionSchema));
const decodeExecutionInteractions = Schema.decodeUnknownSync(
  Schema.Array(ExecutionInteractionSchema),
);
const decodeExecutionSteps = Schema.decodeUnknownSync(
  Schema.Array(ExecutionStepSchema),
);

type SourceArtifact = ReturnType<ExecutorSourceArtifactBackend["build"]>;
type SourceArtifactBuildInput = Parameters<ExecutorSourceArtifactBackend["build"]>[0];

const SQLITE_SECRET_PROVIDER_ID = "sqlite";

type WorkspaceState = Parameters<ExecutorWorkspaceStateBackend["write"]>[0];
const defaultProjectConfig = decodeConfig({});

const defaultWorkspaceState = (): WorkspaceState => ({
  version: 1 as const,
  sources: {},
  policies: {},
});

const makeIdHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);

const makeSourceArtifact = (input: SourceArtifactBuildInput): SourceArtifact => {
  const snapshot = snapshotFromSourceCatalogSyncResult(input.syncResult);
  const sourceSignature = JSON.stringify({
    kind: input.source.kind,
    endpoint: input.source.endpoint,
    namespace: input.source.namespace,
    name: input.source.name,
    enabled: input.source.enabled,
    binding: input.source.binding,
    auth: input.source.auth,
    importAuth: input.source.importAuth,
    importAuthPolicy: input.source.importAuthPolicy,
  });
  const catalogId = SourceCatalogIdSchema.make(
    `src_catalog_${makeIdHash(sourceSignature)}`,
  );
  const revisionId = SourceCatalogRevisionIdSchema.make(
    `src_catalog_rev_${makeIdHash(sourceSignature)}`,
  );
  const importMetadataJson = JSON.stringify(snapshot.import);
  const snapshotHash = contentHash(JSON.stringify(snapshot));
  const importMetadataHash = contentHash(importMetadataJson);

  return {
    version: 4 as const,
    sourceId: input.source.id,
    catalogId,
    generatedAt: Date.now(),
    revision: {
      id: revisionId,
      catalogId,
      revisionNumber: 1,
      sourceConfigJson: sourceSignature,
      importMetadataJson,
      importMetadataHash,
      snapshotHash,
      createdAt: input.source.createdAt,
      updatedAt: input.source.updatedAt,
    },
    snapshot,
  };
};

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

class SqliteDocumentStore {
  readonly db: Database;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.db = new Database(databasePath, {
      create: true,
      strict: true,
    });

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executor_documents (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        PRIMARY KEY (namespace, key)
      );
    `);
  }

  close() {
    this.db.close();
  }

  read<T>(
    namespace: DocumentNamespace,
    key: string,
    decode: (value: unknown) => T,
    fallback: () => T,
  ): T {
    const row = this.db
      .query(
        "SELECT value FROM executor_documents WHERE namespace = ?1 AND key = ?2",
      )
      .get(namespace, key) as { value: string } | null;

    if (!row) {
      return fallback();
    }

    return decode(JSON.parse(row.value) as unknown);
  }

  write(namespace: DocumentNamespace, key: string, value: unknown) {
    this.db
      .query(`
        INSERT INTO executor_documents (namespace, key, value, updated_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(namespace, key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .run(namespace, key, JSON.stringify(value), Date.now());
  }

  remove(namespace: DocumentNamespace, key: string) {
    this.db
      .query("DELETE FROM executor_documents WHERE namespace = ?1 AND key = ?2")
      .run(namespace, key);
  }
}

const effectTry = <T>(label: string, execute: () => T) =>
  Effect.try({
    try: execute,
    catch: (cause) => new Error(`${label}: ${toError(cause).message}`),
  });

const sameActor = (
  left: string | null | undefined,
  right: string | null | undefined,
): boolean => (left ?? null) === (right ?? null);

const createInstallationStore = (
  store: SqliteDocumentStore,
  options: CreateSqliteExecutorBackendOptions,
): ExecutorInstallationBackend => {
  const provision = (): LocalInstallation =>
    decodeInstallation({
      accountId: AccountIdSchema.make(options.accountId ?? "acct_sqlite_example"),
      workspaceId: WorkspaceIdSchema.make(options.workspaceId ?? "ws_sqlite_example"),
    });

  return {
    load: () =>
      effectTry("load installation", () =>
        store.read("installation", "active", decodeInstallation, provision),
      ),
    getOrProvision: () =>
      effectTry("get or provision installation", () => {
        const installation = store.read("installation", "active", decodeInstallation, provision);
        store.write("installation", "active", installation);
        return installation;
      }),
  };
};

const createWorkspaceConfigStore = (
  store: SqliteDocumentStore,
): ExecutorWorkspaceConfigBackend => ({
  load: () =>
    effectTry("load workspace config", () => {
      const projectConfig = store.read(
        "workspace_config",
        "project",
        decodeConfig,
        () => defaultProjectConfig,
      );

      return {
        config: projectConfig,
        homeConfig: null,
        projectConfig,
      };
    }),
  writeProject: (config) =>
    effectTry("write workspace config", () => {
      store.write("workspace_config", "project", config);
    }),
  resolveRelativePath: ({ path, workspaceRoot }) =>
    resolvePath(workspaceRoot, path),
});

const createWorkspaceStateStore = (
  store: SqliteDocumentStore,
): ExecutorWorkspaceStateBackend => ({
  load: () =>
    effectTry("load workspace state", () =>
      store.read("workspace_state", "active", (value) => value as ReturnType<typeof defaultWorkspaceState>, defaultWorkspaceState),
    ),
  write: (state) =>
    effectTry("write workspace state", () => {
      store.write("workspace_state", "active", state);
    }),
});

const createSourceArtifactStore = (
  store: SqliteDocumentStore,
): ExecutorSourceArtifactBackend => ({
  build: makeSourceArtifact,
  read: (sourceId) =>
    effectTry("read source artifact", () =>
      store.read(
        "source_artifact",
        sourceId,
        (value) => value as SourceArtifact,
        () => null,
      ),
    ),
  write: ({ sourceId, artifact }) =>
    effectTry("write source artifact", () => {
      store.write("source_artifact", sourceId, artifact);
    }),
  remove: (sourceId) =>
    effectTry("remove source artifact", () => {
      store.remove("source_artifact", sourceId);
    }),
});

const createExecutorStateStore = (
  store: SqliteDocumentStore,
): ExecutorStateBackend => {
  const readCollection = <K extends keyof ExecutorStateCollections>(
    key: K,
  ): ExecutorStateCollections[K] => {
    switch (key) {
      case "authArtifacts":
        return store.read("executor_state", key, decodeAuthArtifacts, () => []) as ExecutorStateCollections[K];
      case "authLeases":
        return store.read("executor_state", key, decodeAuthLeases, () => []) as ExecutorStateCollections[K];
      case "sourceOauthClients":
        return store.read("executor_state", key, decodeSourceOauthClients, () => []) as ExecutorStateCollections[K];
      case "workspaceOauthClients":
        return store.read("executor_state", key, decodeWorkspaceOauthClients, () => []) as ExecutorStateCollections[K];
      case "providerAuthGrants":
        return store.read("executor_state", key, decodeProviderAuthGrants, () => []) as ExecutorStateCollections[K];
      case "sourceAuthSessions":
        return store.read("executor_state", key, decodeSourceAuthSessions, () => []) as ExecutorStateCollections[K];
      case "secretMaterials":
        return store.read("executor_state", key, decodeSecretMaterials, () => []) as ExecutorStateCollections[K];
      case "executions":
        return store.read("executor_state", key, decodeExecutions, () => []) as ExecutorStateCollections[K];
      case "executionInteractions":
        return store.read("executor_state", key, decodeExecutionInteractions, () => []) as ExecutorStateCollections[K];
      case "executionSteps":
        return store.read("executor_state", key, decodeExecutionSteps, () => []) as ExecutorStateCollections[K];
    }
  };

  const writeCollection = <K extends keyof ExecutorStateCollections>(
    key: K,
    values: ExecutorStateCollections[K],
  ) => {
    store.write("executor_state", key, values);
  };

  const updateCollection = <K extends keyof ExecutorStateCollections, Result>(
    key: K,
    mutate: (values: Array<ExecutorStateCollections[K][number]>) => Result,
  ): Result => {
    const nextValues = [...readCollection(key)] as Array<ExecutorStateCollections[K][number]>;
    const result = mutate(nextValues);
    writeCollection(key, nextValues as ExecutorStateCollections[K]);
    return result;
  };

  return {
    authArtifacts: {
      listByWorkspaceId: (workspaceId) =>
        effectTry("list auth artifacts by workspace", () =>
          readCollection("authArtifacts").filter((item) => item.workspaceId === workspaceId),
        ),
      listByWorkspaceAndSourceId: ({ workspaceId, sourceId }) =>
        effectTry("list auth artifacts by source", () =>
          readCollection("authArtifacts").filter((item) =>
            item.workspaceId === workspaceId && item.sourceId === sourceId
          ),
        ),
      getByWorkspaceSourceAndActor: ({ workspaceId, sourceId, actorAccountId, slot }) =>
        effectTry("get auth artifact", () =>
          Option.fromNullable(
            readCollection("authArtifacts").find((item) =>
              item.workspaceId === workspaceId
              && item.sourceId === sourceId
              && sameActor(item.actorAccountId, actorAccountId)
              && item.slot === slot
            ),
          ),
        ),
      upsert: (artifact) =>
        effectTry("upsert auth artifact", () => {
          updateCollection("authArtifacts", (items) => {
            const index = items.findIndex((item) =>
              item.workspaceId === artifact.workspaceId
              && item.sourceId === artifact.sourceId
              && sameActor(item.actorAccountId, artifact.actorAccountId)
              && item.slot === artifact.slot
            );
            if (index >= 0) {
              items[index] = artifact;
            } else {
              items.push(artifact);
            }
          });
        }),
      removeByWorkspaceSourceAndActor: ({ workspaceId, sourceId, actorAccountId, slot }) =>
        effectTry("remove auth artifact", () =>
          updateCollection("authArtifacts", (items) => {
            const before = items.length;
            const remaining = items.filter((item) => !(
              item.workspaceId === workspaceId
              && item.sourceId === sourceId
              && sameActor(item.actorAccountId, actorAccountId)
              && (slot === undefined || item.slot === slot)
            ));
            items.splice(0, items.length, ...remaining);
            return before !== remaining.length;
          }),
        ),
      removeByWorkspaceAndSourceId: ({ workspaceId, sourceId }) =>
        effectTry("remove auth artifacts by source", () =>
          updateCollection("authArtifacts", (items) => {
            const remaining = items.filter((item) =>
              !(item.workspaceId === workspaceId && item.sourceId === sourceId)
            );
            const removed = items.length - remaining.length;
            items.splice(0, items.length, ...remaining);
            return removed;
          }),
        ),
    },
    authLeases: {
      listAll: () =>
        effectTry("list auth leases", () => readCollection("authLeases")),
      getByAuthArtifactId: (authArtifactId) =>
        effectTry("get auth lease", () =>
          Option.fromNullable(
            readCollection("authLeases").find((item) => item.authArtifactId === authArtifactId),
          ),
        ),
      upsert: (lease) =>
        effectTry("upsert auth lease", () => {
          updateCollection("authLeases", (items) => {
            const index = items.findIndex((item) => item.authArtifactId === lease.authArtifactId);
            if (index >= 0) {
              items[index] = lease;
            } else {
              items.push(lease);
            }
          });
        }),
      removeByAuthArtifactId: (authArtifactId) =>
        effectTry("remove auth lease", () =>
          updateCollection("authLeases", (items) => {
            const remaining = items.filter((item) => item.authArtifactId !== authArtifactId);
            const removed = remaining.length !== items.length;
            items.splice(0, items.length, ...remaining);
            return removed;
          }),
        ),
    },
    sourceOauthClients: {
      getByWorkspaceSourceAndProvider: ({ workspaceId, sourceId, providerKey }) =>
        effectTry("get source oauth client", () =>
          Option.fromNullable(
            readCollection("sourceOauthClients").find((item) =>
              item.workspaceId === workspaceId
              && item.sourceId === sourceId
              && item.providerKey === providerKey
            ),
          ),
        ),
      upsert: (oauthClient) =>
        effectTry("upsert source oauth client", () => {
          updateCollection("sourceOauthClients", (items) => {
            const index = items.findIndex((item) =>
              item.workspaceId === oauthClient.workspaceId
              && item.sourceId === oauthClient.sourceId
              && item.providerKey === oauthClient.providerKey
            );
            if (index >= 0) {
              items[index] = oauthClient;
            } else {
              items.push(oauthClient);
            }
          });
        }),
      removeByWorkspaceAndSourceId: ({ workspaceId, sourceId }) =>
        effectTry("remove source oauth clients", () =>
          updateCollection("sourceOauthClients", (items) => {
            const remaining = items.filter((item) =>
              !(item.workspaceId === workspaceId && item.sourceId === sourceId)
            );
            const removed = items.length - remaining.length;
            items.splice(0, items.length, ...remaining);
            return removed;
          }),
        ),
    },
    workspaceOauthClients: {
      listByWorkspaceAndProvider: ({ workspaceId, providerKey }) =>
        effectTry("list workspace oauth clients", () =>
          readCollection("workspaceOauthClients").filter((item) =>
            item.workspaceId === workspaceId && item.providerKey === providerKey
          ),
        ),
      getById: (id) =>
        effectTry("get workspace oauth client", () =>
          Option.fromNullable(
            readCollection("workspaceOauthClients").find((item) => item.id === id),
          ),
        ),
      upsert: (oauthClient) =>
        effectTry("upsert workspace oauth client", () => {
          updateCollection("workspaceOauthClients", (items) => {
            const index = items.findIndex((item) => item.id === oauthClient.id);
            if (index >= 0) {
              items[index] = oauthClient;
            } else {
              items.push(oauthClient);
            }
          });
        }),
      removeById: (id) =>
        effectTry("remove workspace oauth client", () =>
          updateCollection("workspaceOauthClients", (items) => {
            const remaining = items.filter((item) => item.id !== id);
            const removed = remaining.length !== items.length;
            items.splice(0, items.length, ...remaining);
            return removed;
          }),
        ),
    },
    providerAuthGrants: {
      listByWorkspaceId: (workspaceId) =>
        effectTry("list provider grants by workspace", () =>
          readCollection("providerAuthGrants").filter((item) => item.workspaceId === workspaceId),
        ),
      listByWorkspaceActorAndProvider: ({ workspaceId, actorAccountId, providerKey }) =>
        effectTry("list provider grants by actor", () =>
          readCollection("providerAuthGrants").filter((item) =>
            item.workspaceId === workspaceId
            && item.actorAccountId === actorAccountId
            && item.providerKey === providerKey
          ),
        ),
      getById: (id) =>
        effectTry("get provider grant", () =>
          Option.fromNullable(
            readCollection("providerAuthGrants").find((item) => item.id === id),
          ),
        ),
      upsert: (grant) =>
        effectTry("upsert provider grant", () => {
          updateCollection("providerAuthGrants", (items) => {
            const index = items.findIndex((item) => item.id === grant.id);
            if (index >= 0) {
              items[index] = grant;
            } else {
              items.push(grant);
            }
          });
        }),
      removeById: (id) =>
        effectTry("remove provider grant", () =>
          updateCollection("providerAuthGrants", (items) => {
            const remaining = items.filter((item) => item.id !== id);
            const removed = remaining.length !== items.length;
            items.splice(0, items.length, ...remaining);
            return removed;
          }),
        ),
    },
    sourceAuthSessions: {
      listAll: () =>
        effectTry("list source auth sessions", () => readCollection("sourceAuthSessions")),
      listByWorkspaceId: (workspaceId) =>
        effectTry("list source auth sessions by workspace", () =>
          readCollection("sourceAuthSessions").filter((item) => item.workspaceId === workspaceId),
        ),
      getById: (id) =>
        effectTry("get source auth session", () =>
          Option.fromNullable(
            readCollection("sourceAuthSessions").find((item) => item.id === id),
          ),
        ),
      getByState: (state) =>
        effectTry("get source auth session by state", () =>
          Option.fromNullable(
            readCollection("sourceAuthSessions").find((item) => item.state === state),
          ),
        ),
      getPendingByWorkspaceSourceAndActor: ({ workspaceId, sourceId, actorAccountId, credentialSlot }) =>
        effectTry("get pending source auth session", () =>
          Option.fromNullable(
            readCollection("sourceAuthSessions").find((item) =>
              item.workspaceId === workspaceId
              && item.sourceId === sourceId
              && item.actorAccountId === actorAccountId
              && item.status === "pending"
              && (credentialSlot === undefined || item.credentialSlot === credentialSlot)
            ),
          ),
        ),
      insert: (session) =>
        effectTry("insert source auth session", () => {
          updateCollection("sourceAuthSessions", (items) => {
            items.push(session);
          });
        }),
      update: (id, patch) =>
        effectTry("update source auth session", () =>
          updateCollection("sourceAuthSessions", (items) => {
            const index = items.findIndex((item) => item.id === id);
            if (index < 0) {
              return Option.none();
            }

            const next = {
              ...items[index],
              ...patch,
            };
            items[index] = next;
            return Option.some(next);
          }),
        ),
      upsert: (session) =>
        effectTry("upsert source auth session", () => {
          updateCollection("sourceAuthSessions", (items) => {
            const index = items.findIndex((item) => item.id === session.id);
            if (index >= 0) {
              items[index] = session;
            } else {
              items.push(session);
            }
          });
        }),
      removeByWorkspaceAndSourceId: (workspaceId, sourceId) =>
        effectTry("remove source auth sessions", () =>
          updateCollection("sourceAuthSessions", (items) => {
            const remaining = items.filter((item) =>
              !(item.workspaceId === workspaceId && item.sourceId === sourceId)
            );
            const removed = remaining.length !== items.length;
            items.splice(0, items.length, ...remaining);
            return removed;
          }),
        ),
    },
    secretMaterials: {
      getById: (id) =>
        effectTry("get secret material", () =>
          Option.fromNullable(
            readCollection("secretMaterials").find((item) => item.id === id),
          ),
        ),
      listAll: () =>
        effectTry("list secret materials", () =>
          readCollection("secretMaterials").map((item) => ({
            id: item.id,
            providerId: item.providerId,
            name: item.name,
            purpose: item.purpose,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          })),
        ),
      upsert: (material) =>
        effectTry("upsert secret material", () => {
          updateCollection("secretMaterials", (items) => {
            const index = items.findIndex((item) => item.id === material.id);
            if (index >= 0) {
              items[index] = material;
            } else {
              items.push(material);
            }
          });
        }),
      updateById: (id, update) =>
        effectTry("update secret material", () =>
          updateCollection("secretMaterials", (items) => {
            const index = items.findIndex((item) => item.id === id);
            if (index < 0) {
              return Option.none();
            }

            const next = {
              ...items[index],
              name: update.name === undefined ? items[index]!.name : update.name,
              value: update.value === undefined ? items[index]!.value : update.value,
              updatedAt: Date.now(),
            };
            items[index] = next;
            return Option.some({
              id: next.id,
              providerId: next.providerId,
              name: next.name,
              purpose: next.purpose,
              createdAt: next.createdAt,
              updatedAt: next.updatedAt,
            });
          }),
        ),
      removeById: (id) =>
        effectTry("remove secret material", () =>
          updateCollection("secretMaterials", (items) => {
            const remaining = items.filter((item) => item.id !== id);
            const removed = remaining.length !== items.length;
            items.splice(0, items.length, ...remaining);
            return removed;
          }),
        ),
    },
    executions: {
      getById: (executionId) =>
        effectTry("get execution by id", () =>
          Option.fromNullable(
            readCollection("executions").find((item) => item.id === executionId),
          ),
        ),
      getByWorkspaceAndId: (workspaceId, executionId) =>
        effectTry("get execution by workspace and id", () =>
          Option.fromNullable(
            readCollection("executions").find((item) =>
              item.workspaceId === workspaceId && item.id === executionId
            ),
          ),
        ),
      insert: (execution) =>
        effectTry("insert execution", () => {
          updateCollection("executions", (items) => {
            items.push(execution);
          });
        }),
      update: (executionId, patch) =>
        effectTry("update execution", () =>
          updateCollection("executions", (items) => {
            const index = items.findIndex((item) => item.id === executionId);
            if (index < 0) {
              return Option.none();
            }

            const next = {
              ...items[index],
              ...patch,
            };
            items[index] = next;
            return Option.some(next);
          }),
        ),
    },
    executionInteractions: {
      getById: (interactionId) =>
        effectTry("get execution interaction", () =>
          Option.fromNullable(
            readCollection("executionInteractions").find((item) => item.id === interactionId),
          ),
        ),
      listByExecutionId: (executionId) =>
        effectTry("list execution interactions", () =>
          readCollection("executionInteractions").filter((item) => item.executionId === executionId),
        ),
      getPendingByExecutionId: (executionId) =>
        effectTry("get pending execution interaction", () =>
          Option.fromNullable(
            readCollection("executionInteractions").find((item) =>
              item.executionId === executionId && item.status === "pending"
            ),
          ),
        ),
      insert: (interaction) =>
        effectTry("insert execution interaction", () => {
          updateCollection("executionInteractions", (items) => {
            items.push(interaction);
          });
        }),
      update: (interactionId, patch) =>
        effectTry("update execution interaction", () =>
          updateCollection("executionInteractions", (items) => {
            const index = items.findIndex((item) => item.id === interactionId);
            if (index < 0) {
              return Option.none();
            }

            const next = {
              ...items[index],
              ...patch,
            };
            items[index] = next;
            return Option.some(next);
          }),
        ),
    },
    executionSteps: {
      getByExecutionAndSequence: (executionId, sequence) =>
        effectTry("get execution step", () =>
          Option.fromNullable(
            readCollection("executionSteps").find((item) =>
              item.executionId === executionId && item.sequence === sequence
            ),
          ),
        ),
      listByExecutionId: (executionId) =>
        effectTry("list execution steps", () =>
          readCollection("executionSteps")
            .filter((item) => item.executionId === executionId)
            .sort((left, right) => left.sequence - right.sequence),
        ),
      insert: (step) =>
        effectTry("insert execution step", () => {
          updateCollection("executionSteps", (items) => {
            items.push(step);
          });
        }),
      deleteByExecutionId: (executionId) =>
        effectTry("delete execution steps", () => {
          updateCollection("executionSteps", (items) => {
            const remaining = items.filter((item) => item.executionId !== executionId);
            items.splice(0, items.length, ...remaining);
          });
        }),
      updateByExecutionAndSequence: (executionId, sequence, patch) =>
        effectTry("update execution step", () =>
          updateCollection("executionSteps", (items) => {
            const index = items.findIndex((item) =>
              item.executionId === executionId && item.sequence === sequence
            );
            if (index < 0) {
              return Option.none();
            }

            const next = {
              ...items[index],
              ...patch,
            };
            items[index] = next;
            return Option.some(next);
          }),
        ),
    },
  };
};

const createSecretMaterialBackend = (
  executorState: ExecutorStateBackend,
): ExecutorSecretMaterialBackend => {
  const getSecretMaterial = (id: string) =>
    Effect.flatMap(executorState.secretMaterials.getById(id as SecretMaterial["id"]), (result) =>
      Option.isSome(result)
        ? Effect.succeed(result.value)
        : Effect.fail(new Error(`Secret material ${id} not found`)),
    );

  return {
    resolve: ({ ref }) =>
      Effect.flatMap(getSecretMaterial(ref.handle), (material) => {
        if (material.value === null) {
          return Effect.fail(new Error(`Secret material ${material.id} has no stored value`));
        }

        return Effect.succeed(material.value);
      }),
    store: ({ purpose, value, name, providerId }) =>
      Effect.gen(function* () {
        const now = Date.now();
        const id = SecretMaterialIdSchema.make(`secret_${randomUUID()}`);
        const material: SecretMaterial = {
          id,
          providerId: providerId ?? SQLITE_SECRET_PROVIDER_ID,
          handle: id,
          name: name ?? null,
          purpose,
          value,
          createdAt: now,
          updatedAt: now,
        };
        yield* executorState.secretMaterials.upsert(material);
        return {
          providerId: material.providerId,
          handle: material.handle,
        } satisfies SecretRef;
      }),
    delete: (ref) =>
      executorState.secretMaterials.removeById(ref.handle as SecretMaterial["id"]),
    update: ({ ref, name, value }) =>
      Effect.flatMap(
        executorState.secretMaterials.updateById(ref.handle as SecretMaterial["id"], {
          name,
          value,
        }),
        (result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : Effect.fail(new Error(`Secret material ${ref.handle} not found`)),
      ),
  };
};

export const createSqliteExecutorBackend = (
  options: CreateSqliteExecutorBackendOptions = {},
): ExecutorBackend => {
  const databasePath = options.databasePath === undefined || options.databasePath === ":memory:"
    ? options.databasePath ?? ":memory:"
    : resolvePath(options.databasePath);

  return createExecutorBackend({
    loadServices: () =>
      Effect.sync(() => {
        const store = new SqliteDocumentStore(databasePath);
        const executorState = createExecutorStateStore(store);
        const secretMaterial = createSecretMaterialBackend(executorState);

        return {
          workspace: {
            workspaceName: options.workspaceName ?? "SQLite SDK Example",
            workspaceRoot: options.workspaceRoot ?? null,
            metadata: {
              kind: "sqlite",
              databasePath,
            },
          },
          storage: {
            installation: createInstallationStore(store, options),
            workspaceConfig: createWorkspaceConfigStore(store),
            workspaceState: createWorkspaceStateStore(store),
            sourceArtifacts: createSourceArtifactStore(store),
            executorState,
            secretMaterial,
            close: async () => {
              store.close();
            },
          },
          instanceConfig: {
            resolve: () =>
              Effect.succeed({
                platform: "sqlite-sdk-example",
                secretProviders: [
                  {
                    id: SQLITE_SECRET_PROVIDER_ID,
                    name: "SQLite",
                    canStore: true,
                  },
                ],
                defaultSecretStoreProvider: SQLITE_SECRET_PROVIDER_ID,
              }),
          },
        } satisfies ExecutorBackendServices;
      }),
  });
};

export const createSqliteExecutor = (
  options: CreateSqliteExecutorBackendOptions & ExecutorRuntimeOptions = {},
): Promise<Executor> =>
  createExecutor({
    ...options,
    backend: createSqliteExecutorBackend(options),
  } satisfies CreateExecutorOptions);
