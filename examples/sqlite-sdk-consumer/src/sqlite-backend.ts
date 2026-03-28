import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

import { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import {
  createExecutorBackend,
  type ExecutorBackend,
  type ExecutorBackendRepositories,
  type ExecutorWorkspaceConfigRepository,
  type ExecutorWorkspaceStateRepository,
  type ExecutorWorkspaceSourceArtifactRepository,
} from "@executor/platform-sdk";
import type {
  Execution,
  ExecutionInteraction,
  ExecutionStep,
  LocalExecutorConfig,
  LocalInstallation,
  SecretMaterial,
  SecretRef,
} from "@executor/platform-sdk/schema";
import {
  ScopeIdSchema,
  SecretMaterialIdSchema,
  SourceCatalogIdSchema,
  SourceCatalogRevisionIdSchema,
} from "@executor/platform-sdk/schema";
import {
  contentHash,
  snapshotFromSourceCatalogSyncResult,
} from "@executor/source-core";

export type CreateSqliteExecutorBackendOptions = {
  databasePath?: string;
  scopeName?: string;
  scopeRoot?: string | null;
  scopeId?: string;
  actorScopeId?: string;
};

type ScopeConfig = Awaited<ReturnType<ExecutorWorkspaceConfigRepository["load"]>>;
type ScopeState = Awaited<ReturnType<ExecutorWorkspaceStateRepository["load"]>>;
type SourceArtifact =
  ReturnType<ExecutorWorkspaceSourceArtifactRepository["build"]>;
type SourceArtifactBuildInput = Parameters<
  ExecutorWorkspaceSourceArtifactRepository["build"]
>[0];

type SecretMaterialSummary = {
  id: string;
  providerId: string;
  name: string | null;
  purpose: string;
  createdAt: number;
  updatedAt: number;
};

const SQLITE_SECRET_PROVIDER_ID = "sqlite";

const installations = sqliteTable("installations", {
  key: text("key").primaryKey(),
  scopeId: text("scope_id").notNull(),
  actorScopeId: text("actor_scope_id").notNull(),
  resolutionScopeIdsJson: text("resolution_scope_ids_json").notNull(),
});

const scopeConfigs = sqliteTable("scope_configs", {
  key: text("key").primaryKey(),
  projectConfigJson: text("project_config_json").notNull(),
});

const scopeStates = sqliteTable("scope_states", {
  key: text("key").primaryKey(),
  stateJson: text("state_json").notNull(),
});

const sourceArtifacts = sqliteTable("source_artifacts", {
  sourceId: text("source_id").primaryKey(),
  artifactJson: text("artifact_json").notNull(),
});

const secretMaterials = sqliteTable("secret_materials", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  name: text("name"),
  purpose: text("purpose").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  json: text("json").notNull(),
});

const executions = sqliteTable("executions", {
  id: text("id").primaryKey(),
  scopeId: text("scope_id").notNull(),
  json: text("json").notNull(),
});

const executionInteractions = sqliteTable("execution_interactions", {
  id: text("id").primaryKey(),
  executionId: text("execution_id").notNull(),
  status: text("status").notNull(),
  json: text("json").notNull(),
});

const executionSteps = sqliteTable("execution_steps", {
  id: text("id").primaryKey(),
  executionId: text("execution_id").notNull(),
  sequence: integer("sequence").notNull(),
  json: text("json").notNull(),
});

const makeHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);

const parseJson = <T>(value: string): T => JSON.parse(value) as T;

const createSourceArtifact = (input: SourceArtifactBuildInput): SourceArtifact => {
  const snapshot = snapshotFromSourceCatalogSyncResult(input.syncResult);
  const sourceConfigJson = JSON.stringify({
    kind: input.source.kind,
    namespace: input.source.namespace,
    name: input.source.name,
    enabled: input.source.enabled,
  });
  const importMetadataJson = JSON.stringify(snapshot.import);
  const catalogId = SourceCatalogIdSchema.make(`src_catalog_${makeHash(sourceConfigJson)}`);
  const revisionId = SourceCatalogRevisionIdSchema.make(
    `src_catalog_rev_${makeHash(sourceConfigJson)}`,
  );

  return {
    version: 4,
    sourceId: input.source.id,
    catalogId,
    generatedAt: Date.now(),
    revision: {
      id: revisionId,
      catalogId,
      revisionNumber: 1,
      sourceConfigJson,
      importMetadataJson,
      importMetadataHash: contentHash(importMetadataJson),
      snapshotHash: contentHash(JSON.stringify(snapshot)),
      createdAt: input.source.createdAt,
      updatedAt: input.source.updatedAt,
    },
    snapshot,
  };
};

const defaultScopeState = (): ScopeState => ({
  version: 1,
  sources: {},
  policies: {},
});

const createInstallation = (
  options: CreateSqliteExecutorBackendOptions,
): LocalInstallation => {
  const scopeId = ScopeIdSchema.make(options.scopeId ?? "scope_sqlite_example");
  const actorScopeId = ScopeIdSchema.make(
    options.actorScopeId ?? "account_sqlite_example",
  );

  return {
    scopeId,
    actorScopeId,
    resolutionScopeIds: [scopeId, actorScopeId],
  };
};

const openSqliteStore = (databasePath: string) => {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const sqlite = new Database(databasePath, { create: true, strict: true });
  const db = drizzle(sqlite);

  sqlite.exec(`
      CREATE TABLE IF NOT EXISTS installations (
        key TEXT PRIMARY KEY NOT NULL,
        scope_id TEXT NOT NULL,
        actor_scope_id TEXT NOT NULL,
        resolution_scope_ids_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scope_configs (
        key TEXT PRIMARY KEY NOT NULL,
        project_config_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scope_states (
        key TEXT PRIMARY KEY NOT NULL,
        state_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_artifacts (
        source_id TEXT PRIMARY KEY NOT NULL,
        artifact_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS secret_materials (
        id TEXT PRIMARY KEY NOT NULL,
        provider_id TEXT NOT NULL,
        name TEXT,
        purpose TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY NOT NULL,
        scope_id TEXT NOT NULL,
        json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS execution_interactions (
        id TEXT PRIMARY KEY NOT NULL,
        execution_id TEXT NOT NULL,
        status TEXT NOT NULL,
        json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS execution_steps (
        id TEXT PRIMARY KEY NOT NULL,
        execution_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        json TEXT NOT NULL
      );
    `);
  return {
    sqlite,
    db,
    close: () => {
      sqlite.close();
    },
  };
};

type SqliteStore = ReturnType<typeof openSqliteStore>;

const createStorageDomains = (store: SqliteStore) => ({
  secrets: {
    getById: (id: SecretMaterial["id"]) => {
      const row = store.db.select().from(secretMaterials).where(eq(secretMaterials.id, id)).get();
      return row ? parseJson<SecretMaterial>(row.json) : null;
    },
    listAll: (): readonly SecretMaterialSummary[] =>
      store.db.select().from(secretMaterials).all().map((row) => ({
        id: row.id,
        providerId: row.providerId,
        name: row.name,
        purpose: row.purpose,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    upsert: (material: SecretMaterial) =>
      store.db.insert(secretMaterials).values({
        id: material.id,
        providerId: material.providerId,
        name: material.name,
        purpose: material.purpose,
        createdAt: material.createdAt,
        updatedAt: material.updatedAt,
        json: JSON.stringify(material),
      }).onConflictDoUpdate({
        target: secretMaterials.id,
        set: {
          providerId: material.providerId,
          name: material.name,
          purpose: material.purpose,
          createdAt: material.createdAt,
          updatedAt: material.updatedAt,
          json: JSON.stringify(material),
        },
      }).run(),
    updateById: (
      id: SecretMaterial["id"],
      update: { name?: string | null; value?: string },
    ) => {
      const row = store.db.select().from(secretMaterials).where(eq(secretMaterials.id, id)).get();
      if (!row) return null;
      const current = parseJson<SecretMaterial>(row.json);
      const next = {
        ...current,
        name: update.name === undefined ? current.name : update.name,
        value: update.value === undefined ? current.value : update.value,
        updatedAt: Date.now(),
      };
      store.db.update(secretMaterials).set({
        providerId: next.providerId,
        name: next.name,
        purpose: next.purpose,
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
        json: JSON.stringify(next),
      }).where(eq(secretMaterials.id, id)).run();
      return {
        id: next.id,
        providerId: next.providerId,
        name: next.name,
        purpose: next.purpose,
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
      } satisfies SecretMaterialSummary;
    },
    removeById: (id: SecretMaterial["id"]) => {
      const row = store.db.select({ id: secretMaterials.id }).from(secretMaterials).where(
        eq(secretMaterials.id, id),
      ).get();
      if (!row) return false;
      store.db.delete(secretMaterials).where(eq(secretMaterials.id, id)).run();
      return true;
    },
  },
  executions: {
    runs: {
    listByScope: (scopeId: Execution["scopeId"]) =>
      store.db.select().from(executions).where(
        eq(executions.scopeId, scopeId),
      ).all()
        .map((row) => parseJson<Execution>(row.json))
        .sort((left, right) => right.createdAt - left.createdAt),
    getById: (executionId: Execution["id"]) => {
      const row = store.db.select().from(executions).where(eq(executions.id, executionId)).get();
      return row ? parseJson<Execution>(row.json) : null;
    },
    getByScopeAndId: (
      scopeId: Execution["scopeId"],
      executionId: Execution["id"],
    ) => {
      const row = store.db.select().from(executions).where(
        and(eq(executions.scopeId, scopeId), eq(executions.id, executionId)),
      ).get();
      return row ? parseJson<Execution>(row.json) : null;
    },
    insert: (execution: Execution) =>
      store.db.insert(executions).values({
        id: execution.id,
        scopeId: execution.scopeId,
        json: JSON.stringify(execution),
      }).run(),
    update: (
      executionId: Execution["id"],
      patch: Partial<Omit<Execution, "id" | "scopeId" | "createdByScopeId" | "createdAt">>,
    ) => {
      const row = store.db.select().from(executions).where(eq(executions.id, executionId)).get();
      if (!row) return null;
      const next = { ...parseJson<Execution>(row.json), ...patch };
      store.db.update(executions).set({
        scopeId: next.scopeId,
        json: JSON.stringify(next),
      }).where(eq(executions.id, executionId)).run();
      return next;
    },
  },
    interactions: {
    getById: (interactionId: ExecutionInteraction["id"]) => {
      const row = store.db.select().from(executionInteractions).where(
        eq(executionInteractions.id, interactionId),
      ).get();
      return row ? parseJson<ExecutionInteraction>(row.json) : null;
    },
    listByExecutionId: (executionId: ExecutionInteraction["executionId"]) =>
      store.db.select().from(executionInteractions).where(
        eq(executionInteractions.executionId, executionId),
      ).all().map((row) => parseJson<ExecutionInteraction>(row.json)),
    getPendingByExecutionId: (executionId: ExecutionInteraction["executionId"]) => {
      const row = store.db.select().from(executionInteractions).where(
        and(
          eq(executionInteractions.executionId, executionId),
          eq(executionInteractions.status, "pending"),
        ),
      ).get();
      return row ? parseJson<ExecutionInteraction>(row.json) : null;
    },
    insert: (interaction: ExecutionInteraction) =>
      store.db.insert(executionInteractions).values({
        id: interaction.id,
        executionId: interaction.executionId,
        status: interaction.status,
        json: JSON.stringify(interaction),
      }).run(),
    update: (
      interactionId: ExecutionInteraction["id"],
      patch: Partial<Omit<ExecutionInteraction, "id" | "executionId" | "createdAt">>,
    ) => {
      const row = store.db.select().from(executionInteractions).where(
        eq(executionInteractions.id, interactionId),
      ).get();
      if (!row) return null;
      const next = { ...parseJson<ExecutionInteraction>(row.json), ...patch };
      store.db.update(executionInteractions).set({
        executionId: next.executionId,
        status: next.status,
        json: JSON.stringify(next),
      }).where(eq(executionInteractions.id, interactionId)).run();
      return next;
    },
  },
    steps: {
    getByExecutionAndSequence: (
      executionId: ExecutionStep["executionId"],
      sequence: ExecutionStep["sequence"],
    ) => {
      const row = store.db.select().from(executionSteps).where(
        and(
          eq(executionSteps.executionId, executionId),
          eq(executionSteps.sequence, sequence),
        ),
      ).get();
      return row ? parseJson<ExecutionStep>(row.json) : null;
    },
    listByExecutionId: (executionId: ExecutionStep["executionId"]) =>
      store.db.select().from(executionSteps).where(
        eq(executionSteps.executionId, executionId),
      ).orderBy(executionSteps.sequence).all().map((row) => parseJson<ExecutionStep>(row.json)),
    insert: (step: ExecutionStep) =>
      store.db.insert(executionSteps).values({
        id: step.id,
        executionId: step.executionId,
        sequence: step.sequence,
        json: JSON.stringify(step),
      }).run(),
    deleteByExecutionId: (executionId: ExecutionStep["executionId"]) => {
      store.db.delete(executionSteps).where(eq(executionSteps.executionId, executionId)).run();
    },
    updateByExecutionAndSequence: (
      executionId: ExecutionStep["executionId"],
      sequence: ExecutionStep["sequence"],
      patch: Partial<Omit<ExecutionStep, "id" | "executionId" | "sequence" | "createdAt">>,
    ) => {
      const row = store.db.select().from(executionSteps).where(
        and(
          eq(executionSteps.executionId, executionId),
          eq(executionSteps.sequence, sequence),
        ),
      ).get();
      if (!row) return null;
      const next = { ...parseJson<ExecutionStep>(row.json), ...patch };
      store.db.update(executionSteps).set({
        id: next.id,
        executionId: next.executionId,
        sequence: next.sequence,
        json: JSON.stringify(next),
      }).where(eq(executionSteps.id, row.id)).run();
      return next;
    },
  },
  },
});

export const createSqliteExecutorBackend = (
  options: CreateSqliteExecutorBackendOptions = {},
): ExecutorBackend => {
  const databasePath = options.databasePath && options.databasePath !== ":memory:"
    ? resolvePath(options.databasePath)
    : (options.databasePath ?? ":memory:");

  return createExecutorBackend({
    loadRepositories: () => {
      const store = openSqliteStore(databasePath);
      const { secrets, executions } = createStorageDomains(store);

      return {
        scope: {
          scopeName: options.scopeName ?? "SQLite SDK Example",
          scopeRoot: options.scopeRoot ?? null,
          metadata: {
            kind: "sqlite",
            databasePath,
          },
        },
        installation: {
          load: () => {
            const row = store.db.select().from(installations).where(eq(installations.key, "active")).get();
            return row
              ? {
                  scopeId: row.scopeId as LocalInstallation["scopeId"],
                  actorScopeId: row.actorScopeId as LocalInstallation["actorScopeId"],
                  resolutionScopeIds: parseJson<LocalInstallation["resolutionScopeIds"]>(
                    row.resolutionScopeIdsJson,
                  ),
                }
              : createInstallation(options);
          },
          getOrProvision: () => {
            const installation = (() => {
              const row = store.db.select().from(installations).where(eq(installations.key, "active")).get();
              return row
                ? {
                    scopeId: row.scopeId as LocalInstallation["scopeId"],
                    actorScopeId: row.actorScopeId as LocalInstallation["actorScopeId"],
                    resolutionScopeIds: parseJson<LocalInstallation["resolutionScopeIds"]>(
                      row.resolutionScopeIdsJson,
                    ),
                  }
                : createInstallation(options);
            })();
            store.db.insert(installations).values({
              key: "active",
              scopeId: installation.scopeId,
              actorScopeId: installation.actorScopeId,
              resolutionScopeIdsJson: JSON.stringify(installation.resolutionScopeIds),
            }).onConflictDoUpdate({
              target: installations.key,
              set: {
                scopeId: installation.scopeId,
                actorScopeId: installation.actorScopeId,
                resolutionScopeIdsJson: JSON.stringify(installation.resolutionScopeIds),
              },
            }).run();
            return installation;
          },
        },
        workspace: {
          config: {
            load: () => {
              const row = store.db.select().from(scopeConfigs).where(eq(scopeConfigs.key, "project")).get();
              const projectConfig = row
                ? parseJson<LocalExecutorConfig>(row.projectConfigJson)
                : {};
              return {
                config: projectConfig,
                homeConfig: null,
                projectConfig,
              } satisfies ScopeConfig;
            },
            writeProject: (config) => {
              store.db.insert(scopeConfigs).values({
                key: "project",
                projectConfigJson: JSON.stringify(config),
              }).onConflictDoUpdate({
                target: scopeConfigs.key,
                set: { projectConfigJson: JSON.stringify(config) },
              }).run();
            },
            resolveRelativePath: ({ path, scopeRoot }) => resolvePath(scopeRoot, path),
          },
          state: {
            load: () => {
              const row = store.db.select().from(scopeStates).where(eq(scopeStates.key, "active")).get();
              return row ? parseJson<ScopeState>(row.stateJson) : defaultScopeState();
            },
            write: (state) => {
              store.db.insert(scopeStates).values({
                key: "active",
                stateJson: JSON.stringify(state),
              }).onConflictDoUpdate({
                target: scopeStates.key,
                set: { stateJson: JSON.stringify(state) },
              }).run();
            },
          },
          sourceArtifacts: {
            build: createSourceArtifact,
            read: (sourceId) => {
              const row = store.db.select().from(sourceArtifacts).where(
                eq(sourceArtifacts.sourceId, sourceId),
              ).get();
              return row ? parseJson<SourceArtifact>(row.artifactJson) : null;
            },
            write: ({ sourceId, artifact }) => {
              store.db.insert(sourceArtifacts).values({
                sourceId,
                artifactJson: JSON.stringify(artifact),
              }).onConflictDoUpdate({
                target: sourceArtifacts.sourceId,
                set: { artifactJson: JSON.stringify(artifact) },
              }).run();
            },
            remove: (sourceId) => {
              store.db.delete(sourceArtifacts).where(eq(sourceArtifacts.sourceId, sourceId)).run();
            },
          },
        },
        secrets: {
          ...secrets,
          resolve: ({ ref }) => {
            const material = secrets.getById(
              ref.handle as SecretMaterial["id"],
            );
            if (!material || material.value === null) {
              throw new Error(`Missing secret material ${ref.handle}`);
            }
            return material.value;
          },
          store: ({ purpose, value, name, providerId }) => {
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
            secrets.upsert(material);
            return {
              providerId: material.providerId,
              handle: material.handle,
            } satisfies SecretRef;
          },
          delete: (ref) =>
            secrets.removeById(ref.handle as SecretMaterial["id"]),
          update: ({ ref, name, value }) => {
            const updated = secrets.updateById(
              ref.handle as SecretMaterial["id"],
              { name, value },
            );
            if (!updated) {
              throw new Error(`Missing secret material ${ref.handle}`);
            }
            return updated;
          },
        },
        executions,
        instanceConfig: {
          resolve: () => ({
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
        close: async () => {
          store.close();
        },
      } satisfies ExecutorBackendRepositories;
    },
  });
};
