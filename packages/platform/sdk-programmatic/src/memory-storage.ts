import type {
  LocalInstallation,
} from "@executor/platform-sdk/schema";
import {
  ScopeIdSchema,
} from "@executor/platform-sdk/schema";
import {
  createExecutorBackend,
  type ExecutorBackend,
  type ExecutorBackendRepositories,
} from "@executor/platform-sdk/backend";
import type { ExecutorRuntimeOptions } from "@executor/platform-sdk/runtime";

import type { CreateExecutorOptions } from "./types";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Return null for missing values — NOT Option.none().
// Option.none() is also an Effect in the Effect library, so toEffect
// would try to evaluate it as an Effect rather than wrapping it.
const findOrNull = <T>(items: T[], predicate: (item: T) => boolean): T | null => {
  const found = items.find(predicate);
  return found != null ? clone(found) : null;
};

const makeMemoryInstallation = (): LocalInstallation => {
  const scopeId = ScopeIdSchema.make(`ws_mem_${crypto.randomUUID().slice(0, 16)}`);
  const actorId = ScopeIdSchema.make(`acc_mem_${crypto.randomUUID().slice(0, 16)}`);
  return {
    scopeId,
    actorScopeId: actorId,
    resolutionScopeIds: [scopeId, actorId],
  };
};

// Generic in-memory collection with common CRUD patterns.
// All "find" methods return T | null (never Option) to avoid
// the Option-is-also-an-Effect pitfall in the backend wrapper.
const createCollection = <T extends Record<string, unknown>>() => {
  const items: T[] = [];

  return {
    items,
    findBy: (predicate: (item: T) => boolean): T | null =>
      findOrNull(items, predicate),
    filterBy: (predicate: (item: T) => boolean) =>
      clone(items.filter(predicate)),
    insert: (item: T) => { items.push(clone(item)); },
    upsertBy: (key: (item: T) => string, item: T) => {
      const k = key(item);
      const idx = items.findIndex((i) => key(i) === k);
      if (idx >= 0) items[idx] = clone(item);
      else items.push(clone(item));
    },
    removeBy: (predicate: (item: T) => boolean): boolean => {
      const idx = items.findIndex(predicate);
      if (idx >= 0) { items.splice(idx, 1); return true; }
      return false;
    },
    removeAllBy: (predicate: (item: T) => boolean): number => {
      const before = items.length;
      const keep = items.filter((i) => !predicate(i));
      items.length = 0;
      items.push(...keep);
      return before - keep.length;
    },
    updateBy: <P>(predicate: (item: T) => boolean, patch: P): T | null => {
      const item = items.find(predicate);
      if (!item) return null;
      Object.assign(item, patch);
      return clone(item);
    },
  };
};

export const createMemoryBackend = (
  sdkOptions?: CreateExecutorOptions,
): ExecutorBackend =>
  createExecutorBackend({
    loadRepositories: (_runtimeOptions: ExecutorRuntimeOptions) => {
      const installation = makeMemoryInstallation();
      const resolveSecret = sdkOptions?.resolveSecret;

      const authArtifacts = createCollection<any>();
      const authLeases = createCollection<any>();
      const sourceOauthClients = createCollection<any>();
      const scopeOauthClients = createCollection<any>();
      const providerGrants = createCollection<any>();
      const sourceSessions = createCollection<any>();
      const secretMaterials = createCollection<any>();
      const executionRuns = createCollection<any>();
      const executionInteractions = createCollection<any>();
      const executionSteps = createCollection<any>();
      const artifacts = new Map<string, any>();

      return {
        scope: {
          scopeName: "memory",
          scopeRoot: process.cwd(),
        },
        installation: {
          load: () => clone(installation),
          getOrProvision: () => clone(installation),
        },
        workspace: {
          config: (() => {
            let projectConfig: any = null;
            return {
              load: () => ({
                config: projectConfig,
                homeConfig: null,
                projectConfig,
              }),
              writeProject: (config: any) => { projectConfig = clone(config); },
              resolveRelativePath: ({ path }: { path: string; scopeRoot: string }) => path,
            };
          })(),
          state: (() => {
            let stateData: any = {
              version: 1 as const,
              sources: {} as Record<string, any>,
              policies: {} as Record<string, any>,
            };
            return {
              load: () => clone(stateData),
              write: (data: any) => { stateData = clone(data); },
            };
          })(),
          sourceArtifacts: {
            // build is called by the source catalog sync — for in-memory use
            // it produces a minimal artifact structure
            build: (({ source, syncResult }: any) => ({
              version: 4,
              sourceId: source.id,
              catalogId: `catalog_${source.id}`,
              generatedAt: Date.now(),
              revision: {
                revisionId: `rev_${crypto.randomUUID().slice(0, 8)}`,
                revisionNumber: 1,
              },
              snapshot: syncResult,
            })) as any,
            read: (sourceId: string) => artifacts.get(sourceId) ?? null,
            write: ({ sourceId, artifact }: { sourceId: string; artifact: any }) => {
              artifacts.set(sourceId, artifact);
            },
            remove: (sourceId: string) => { artifacts.delete(sourceId); },
          },
          sourceAuth: {
            artifacts: {
              listByScopeId: (scopeId: any) =>
                authArtifacts.filterBy((a) => a.scopeId === scopeId),
              listByScopeAndSourceId: ({ scopeId, sourceId }: any) =>
                authArtifacts.filterBy((a) => a.scopeId === scopeId && a.sourceId === sourceId),
              getByScopeSourceAndActor: ({ scopeId, sourceId, actorScopeId, slot }: any) =>
                authArtifacts.findBy((a) =>
                  a.scopeId === scopeId && a.sourceId === sourceId &&
                  a.actorScopeId === actorScopeId && a.slot === slot),
              upsert: (artifact: any) =>
                authArtifacts.upsertBy(
                  (a) => `${a.scopeId}:${a.sourceId}:${a.actorScopeId}:${a.slot}`,
                  artifact,
                ),
              removeByScopeSourceAndActor: ({ scopeId, sourceId, actorScopeId, slot }: any) =>
                authArtifacts.removeBy((a) =>
                  a.scopeId === scopeId && a.sourceId === sourceId &&
                  a.actorScopeId === actorScopeId &&
                  (slot === undefined || a.slot === slot)),
              removeByScopeAndSourceId: ({ scopeId, sourceId }: any) =>
                authArtifacts.removeAllBy((a) => a.scopeId === scopeId && a.sourceId === sourceId),
            },
            leases: {
              listAll: () => clone(authLeases.items),
              getByAuthArtifactId: (id: any) =>
                authLeases.findBy((l) => l.authArtifactId === id),
              upsert: (lease: any) =>
                authLeases.upsertBy((l) => l.authArtifactId, lease),
              removeByAuthArtifactId: (id: any) =>
                authLeases.removeBy((l) => l.authArtifactId === id),
            },
            sourceOauthClients: {
              getByScopeSourceAndProvider: ({ scopeId, sourceId, providerKey }: any) =>
                sourceOauthClients.findBy((c) =>
                  c.scopeId === scopeId && c.sourceId === sourceId && c.providerKey === providerKey),
              upsert: (client: any) =>
                sourceOauthClients.upsertBy(
                  (c) => `${c.scopeId}:${c.sourceId}:${c.providerKey}`,
                  client,
                ),
              removeByScopeAndSourceId: ({ scopeId, sourceId }: any) =>
                sourceOauthClients.removeAllBy((c) => c.scopeId === scopeId && c.sourceId === sourceId),
            },
            scopeOauthClients: {
              listByScopeAndProvider: ({ scopeId, providerKey }: any) =>
                scopeOauthClients.filterBy((c) => c.scopeId === scopeId && c.providerKey === providerKey),
              getById: (id: any) => scopeOauthClients.findBy((c) => c.id === id),
              upsert: (client: any) => scopeOauthClients.upsertBy((c) => c.id, client),
              removeById: (id: any) => scopeOauthClients.removeBy((c) => c.id === id),
            },
            providerGrants: {
              listByScopeId: (scopeId: any) =>
                providerGrants.filterBy((g) => g.scopeId === scopeId),
              listByScopeActorAndProvider: ({ scopeId, actorScopeId, providerKey }: any) =>
                providerGrants.filterBy((g) =>
                  g.scopeId === scopeId && g.actorScopeId === actorScopeId && g.providerKey === providerKey),
              getById: (id: any) => providerGrants.findBy((g) => g.id === id),
              upsert: (grant: any) => providerGrants.upsertBy((g) => g.id, grant),
              removeById: (id: any) => providerGrants.removeBy((g) => g.id === id),
            },
            sourceSessions: {
              listAll: () => clone(sourceSessions.items),
              listByScopeId: (scopeId: any) =>
                sourceSessions.filterBy((s) => s.scopeId === scopeId),
              getById: (id: any) => sourceSessions.findBy((s) => s.id === id),
              getByState: (state: any) => sourceSessions.findBy((s) => s.state === state),
              getPendingByScopeSourceAndActor: ({ scopeId, sourceId, actorScopeId, credentialSlot }: any) =>
                sourceSessions.findBy((s) =>
                  s.scopeId === scopeId && s.sourceId === sourceId &&
                  s.actorScopeId === actorScopeId && s.status === "pending" &&
                  (credentialSlot === undefined || s.credentialSlot === credentialSlot)),
              insert: (session: any) => sourceSessions.insert(session),
              update: (id: any, patch: any) =>
                sourceSessions.updateBy((s) => s.id === id, patch),
              upsert: (session: any) => sourceSessions.upsertBy((s) => s.id, session),
              removeByScopeAndSourceId: (scopeId: any, sourceId: any) =>
                sourceSessions.removeAllBy((s) => s.scopeId === scopeId && s.sourceId === sourceId) > 0,
            },
          },
        },
        secrets: {
          getById: (id: any) => secretMaterials.findBy((m) => m.id === id),
          listAll: () => secretMaterials.items.map((m: any) => ({
            id: m.id, providerId: m.providerId, name: m.name,
            purpose: m.purpose, createdAt: m.createdAt, updatedAt: m.updatedAt,
          })),
          upsert: (material: any) => secretMaterials.upsertBy((m) => m.id, material),
          updateById: (id: any, patch: any) =>
            secretMaterials.updateBy((m) => m.id === id, { ...patch, updatedAt: Date.now() }),
          removeById: (id: any) => secretMaterials.removeBy((m) => m.id === id),
          resolve: resolveSecret
            ? ({ secretId, context }: any) => Promise.resolve(resolveSecret({ secretId, context }))
            : ({ secretId }: any) => {
              const m = secretMaterials.items.find((m: any) => m.id === secretId);
              return m?.value ?? null;
            },
          store: (payload: any) => {
            const now = Date.now();
            const material = { ...payload, createdAt: now, updatedAt: now };
            secretMaterials.upsertBy((m) => m.id, material);
            const { value: _, ...summary } = material;
            return summary;
          },
          delete: (payload: any) => secretMaterials.removeBy((m) => m.id === payload.id),
          update: (payload: any) =>
            secretMaterials.updateBy((m) => m.id === payload.id, { ...payload, updatedAt: Date.now() }),
        },
        executions: {
          runs: {
            getById: (id: any) => executionRuns.findBy((e) => e.id === id),
            getByScopeAndId: (scopeId: any, id: any) =>
              executionRuns.findBy((e) => e.scopeId === scopeId && e.id === id),
            insert: (execution: any) => executionRuns.insert(execution),
            update: (id: any, patch: any) =>
              executionRuns.updateBy((e) => e.id === id, patch),
          },
          interactions: {
            getById: (id: any) => executionInteractions.findBy((i) => i.id === id),
            listByExecutionId: (executionId: any) =>
              executionInteractions.filterBy((i) => i.executionId === executionId),
            getPendingByExecutionId: (executionId: any) =>
              executionInteractions.findBy((i) =>
                i.executionId === executionId && i.status === "pending"),
            insert: (interaction: any) => executionInteractions.insert(interaction),
            update: (id: any, patch: any) =>
              executionInteractions.updateBy((i) => i.id === id, patch),
          },
          steps: {
            getByExecutionAndSequence: (executionId: any, sequence: any) =>
              executionSteps.findBy((s) =>
                s.executionId === executionId && s.sequence === sequence),
            listByExecutionId: (executionId: any) =>
              executionSteps.filterBy((s) => s.executionId === executionId),
            insert: (step: any) => executionSteps.insert(step),
            deleteByExecutionId: (executionId: any) => {
              executionSteps.removeAllBy((s) => s.executionId === executionId);
            },
            updateByExecutionAndSequence: (executionId: any, sequence: any, patch: any) =>
              executionSteps.updateBy(
                (s) => s.executionId === executionId && s.sequence === sequence,
                patch,
              ),
          },
        },
        instanceConfig: {
          resolve: () => ({
            platform: "memory",
            secretProviders: [],
            defaultSecretStoreProvider: "memory",
          }),
        },
      } as unknown as ExecutorBackendRepositories;
    },
  });
