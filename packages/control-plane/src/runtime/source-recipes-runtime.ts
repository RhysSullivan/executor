import {
  type ToolDescriptor,
} from "@executor/codemode-core";
import type { SqlControlPlaneRows } from "#persistence";
import type {
  AccountId,
  Source,
  StoredSourceRecord,
  StoredSourceRecipeDocumentRecord,
  StoredSourceRecipeOperationRecord,
  StoredSourceRecipeSchemaBundleRecord,
  StoredSourceRecipeRevisionRecord,
  WorkspaceId,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { namespaceFromSourceName } from "./source-names";
import {
  getSourceAdapterForOperation,
  getSourceAdapterForSource,
} from "./source-adapters";
import type { SourceAdapterPersistedOperationMetadata } from "./source-adapters/types";
import { firstSchemaBundle } from "./source-adapters/shared";
import { loadSourceById, loadSourcesInWorkspace } from "./source-store";

type RecipeManifest = unknown | null;

export type LoadedSourceRecipe = {
  source: Source;
  sourceRecord: StoredSourceRecord;
  revision: StoredSourceRecipeRevisionRecord;
  documents: readonly StoredSourceRecipeDocumentRecord[];
  schemaBundles: readonly StoredSourceRecipeSchemaBundleRecord[];
  operations: readonly StoredSourceRecipeOperationRecord[];
  manifest: RecipeManifest;
};

export type LoadedSourceRecipeTool = {
  path: string;
  searchNamespace: string;
  searchText: string;
  source: Source;
  sourceRecord: StoredSourceRecord;
  revision: StoredSourceRecipeRevisionRecord;
  operation: StoredSourceRecipeOperationRecord;
  metadata: SourceAdapterPersistedOperationMetadata;
  schemaBundleId: string | null;
  manifest: RecipeManifest;
  descriptor: ToolDescriptor;
};

export type LoadedSourceRecipeToolIndexEntry = {
  path: string;
  searchNamespace: string;
  searchText: string;
  source: Source;
  sourceRecord: StoredSourceRecord;
  operation: StoredSourceRecipeOperationRecord;
  metadata: SourceAdapterPersistedOperationMetadata;
  schemaBundleId: string | null;
  descriptor: ToolDescriptor;
};

const parseManifestForRecipe = (input: {
  source: Source;
  revision: StoredSourceRecipeRevisionRecord;
}): Effect.Effect<RecipeManifest, Error, never> =>
  getSourceAdapterForSource(input.source).parseManifest({
    source: input.source,
    manifestJson: input.revision.manifestJson,
  });

const catalogNamespaceFromPath = (path: string): string => {
  const [first, second] = path.split(".");
  return second ? `${first}.${second}` : first;
};

export const recipeToolPath = (input: {
  source: Source;
  operation: StoredSourceRecipeOperationRecord;
}): string => {
  const namespace = input.source.namespace ?? namespaceFromSourceName(input.source.name);
  return namespace ? `${namespace}.${input.operation.toolId}` : input.operation.toolId;
};

export const recipeToolSearchNamespace = (input: {
  source: Source;
  path: string;
  operation: StoredSourceRecipeOperationRecord;
}): string =>
  getSourceAdapterForOperation(input.operation).searchNamespace?.({
    source: input.source,
    path: input.path,
    operation: input.operation,
  })
  ?? catalogNamespaceFromPath(input.path);

export const recipeToolDescriptor = (input: {
  source: Source;
  operation: StoredSourceRecipeOperationRecord;
  path: string;
  schemaBundleId?: string | null;
  includeSchemas: boolean;
}): ToolDescriptor =>
  getSourceAdapterForOperation(input.operation).createToolDescriptor(input);

export const recipeToolMetadata = (input: {
  source: Source;
  operation: StoredSourceRecipeOperationRecord;
  path: string;
}): Effect.Effect<SourceAdapterPersistedOperationMetadata, Error, never> =>
  getSourceAdapterForOperation(input.operation).describePersistedOperation(input);

const sourceRecipeDocumentForSource = (input: {
  source: Source;
  documents: readonly StoredSourceRecipeDocumentRecord[];
}): StoredSourceRecipeDocumentRecord | null => {
  const preferredKind = getSourceAdapterForSource(input.source).primaryDocumentKind;

  if (preferredKind === null) {
    return null;
  }

  return input.documents.find((document) => document.documentKind === preferredKind) ?? null;
};

export const recipePrimaryDocumentText = (input: {
  source: Source;
  documents: readonly StoredSourceRecipeDocumentRecord[];
}): string | null =>
  sourceRecipeDocumentForSource(input)?.contentText ?? null;

const primarySchemaBundleForRevision = (input: {
  source: Source;
  schemaBundles: readonly StoredSourceRecipeSchemaBundleRecord[];
}): StoredSourceRecipeSchemaBundleRecord | null => {
  const selected = firstSchemaBundle({
    schemaBundles: input.schemaBundles.map((schemaBundle) => ({
      id: schemaBundle.id,
      kind: schemaBundle.bundleKind,
      hash: schemaBundle.contentHash,
      refsJson: schemaBundle.refsJson,
    })),
    preferredKind: getSourceAdapterForSource(input.source).primarySchemaBundleKind,
  });

  return selected
    ? input.schemaBundles.find((schemaBundle) => schemaBundle.id === selected.id) ?? null
    : null;
};

export const loadWorkspaceSourceRecipes = (input: {
  rows: SqlControlPlaneRows;
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
}): Effect.Effect<readonly LoadedSourceRecipe[], Error, never> =>
  Effect.gen(function* () {
    const sourceRecords = yield* input.rows.sources.listByWorkspaceId(input.workspaceId);
    const sources = yield* loadSourcesInWorkspace(input.rows, input.workspaceId, {
      actorAccountId: input.actorAccountId,
    });

    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const relevantSourceRecords = sourceRecords.filter((sourceRecord) => sourceById.has(sourceRecord.id));
    const revisionIds = [...new Set(relevantSourceRecords.map((sourceRecord) => sourceRecord.recipeRevisionId))];

    const revisions = yield* input.rows.sourceRecipeRevisions.listByIds(revisionIds);
    const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
    const documents = yield* input.rows.sourceRecipeDocuments.listByRevisionIds(revisionIds);
    const schemaBundles = yield* input.rows.sourceRecipeSchemaBundles.listByRevisionIds(revisionIds);
    const documentsByRevisionId = new Map<string, StoredSourceRecipeDocumentRecord[]>();
    for (const document of documents) {
      const existing = documentsByRevisionId.get(document.recipeRevisionId) ?? [];
      existing.push(document);
      documentsByRevisionId.set(document.recipeRevisionId, existing);
    }
    const schemaBundlesByRevisionId = new Map<string, StoredSourceRecipeSchemaBundleRecord[]>();
    for (const schemaBundle of schemaBundles) {
      const existing = schemaBundlesByRevisionId.get(schemaBundle.recipeRevisionId) ?? [];
      existing.push(schemaBundle);
      schemaBundlesByRevisionId.set(schemaBundle.recipeRevisionId, existing);
    }
    const operations = yield* input.rows.sourceRecipeOperations.listByRevisionIds(revisionIds);
    const operationsByRevisionId = new Map<string, StoredSourceRecipeOperationRecord[]>();
    for (const operation of operations) {
      const existing = operationsByRevisionId.get(operation.recipeRevisionId) ?? [];
      existing.push(operation);
      operationsByRevisionId.set(operation.recipeRevisionId, existing);
    }

    return yield* Effect.forEach(relevantSourceRecords, (sourceRecord) =>
      Effect.gen(function* () {
        const source = sourceById.get(sourceRecord.id);
        if (!source) {
          return yield* Effect.fail(
            new Error(`Projected source missing for ${sourceRecord.id}`),
          );
        }

        const revision = revisionById.get(sourceRecord.recipeRevisionId);
        if (!revision) {
          return yield* Effect.fail(
            new Error(`Recipe revision missing for source ${sourceRecord.id}`),
          );
        }

        const manifest = yield* parseManifestForRecipe({
          source,
          revision,
        });

        return {
          source,
          sourceRecord,
          revision,
          documents: documentsByRevisionId.get(sourceRecord.recipeRevisionId) ?? [],
          schemaBundles: schemaBundlesByRevisionId.get(sourceRecord.recipeRevisionId) ?? [],
          operations: operationsByRevisionId.get(sourceRecord.recipeRevisionId) ?? [],
          manifest,
        } satisfies LoadedSourceRecipe;
      }),
    );
  });

export const loadSourceWithRecipe = (input: {
  rows: SqlControlPlaneRows;
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  actorAccountId?: AccountId | null;
}): Effect.Effect<LoadedSourceRecipe, Error, never> =>
  Effect.gen(function* () {
    const sourceRecord = yield* input.rows.sources.getByWorkspaceAndId(
      input.workspaceId,
      input.sourceId,
    );
    if (Option.isNone(sourceRecord)) {
      return yield* Effect.fail(
        new Error(`Source not found: workspaceId=${input.workspaceId} sourceId=${input.sourceId}`),
      );
    }

    const source = yield* loadSourceById(input.rows, {
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      actorAccountId: input.actorAccountId,
    });
    const revision = yield* input.rows.sourceRecipeRevisions.getById(sourceRecord.value.recipeRevisionId);
    if (Option.isNone(revision)) {
      return yield* Effect.fail(
        new Error(`Recipe revision missing for source ${input.sourceId}`),
      );
    }
    const [documents, schemaBundles, operations, manifest] = yield* Effect.all([
      input.rows.sourceRecipeDocuments.listByRevisionId(sourceRecord.value.recipeRevisionId),
      input.rows.sourceRecipeSchemaBundles.listByRevisionId(sourceRecord.value.recipeRevisionId),
      input.rows.sourceRecipeOperations.listByRevisionId(sourceRecord.value.recipeRevisionId),
      parseManifestForRecipe({
        source,
        revision: revision.value,
      }),
    ]);

    return {
      source,
      sourceRecord: sourceRecord.value,
      revision: revision.value,
      documents,
      schemaBundles,
      operations,
      manifest,
    } satisfies LoadedSourceRecipe;
  });

export const expandRecipeTools = (input: {
  recipes: readonly LoadedSourceRecipe[];
  includeSchemas: boolean;
}): Effect.Effect<readonly LoadedSourceRecipeTool[], Error, never> =>
  Effect.map(
    Effect.forEach(input.recipes, (recipe) =>
      Effect.forEach(recipe.operations, (operation) =>
        Effect.gen(function* () {
          const path = recipeToolPath({
            source: recipe.source,
            operation,
          });
          const searchNamespace = recipeToolSearchNamespace({
            source: recipe.source,
            path,
            operation,
          });
          const schemaBundleId = primarySchemaBundleForRevision({
            source: recipe.source,
            schemaBundles: recipe.schemaBundles,
          })?.id ?? null;
          const metadata = yield* recipeToolMetadata({
            source: recipe.source,
            operation,
            path,
          });

          return {
            path,
            searchNamespace,
            searchText: [
              path,
              searchNamespace,
              recipe.source.name,
              metadata.searchText,
            ]
              .filter((part) => part.length > 0)
              .join(" ")
              .toLowerCase(),
            source: recipe.source,
            sourceRecord: recipe.sourceRecord,
            revision: recipe.revision,
            operation,
            metadata,
            schemaBundleId,
            manifest: recipe.manifest,
            descriptor: recipeToolDescriptor({
              source: recipe.source,
              operation,
              path,
              schemaBundleId,
              includeSchemas: input.includeSchemas,
            }),
          } satisfies LoadedSourceRecipeTool;
        })
      ),
    ),
    (recipes) => recipes.flat(),
  );

export const loadWorkspaceSourceRecipeToolIndex = (input: {
  rows: SqlControlPlaneRows;
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
  includeSchemas: boolean;
}): Effect.Effect<readonly LoadedSourceRecipeToolIndexEntry[], Error, never> =>
  Effect.gen(function* () {
    const sourceRecords = yield* input.rows.sources.listByWorkspaceId(input.workspaceId);
    const sources = yield* loadSourcesInWorkspace(input.rows, input.workspaceId, {
      actorAccountId: input.actorAccountId,
    });
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const relevantSourceRecords = sourceRecords.filter((sourceRecord) => sourceById.has(sourceRecord.id));
    const revisionIds = [...new Set(relevantSourceRecords.map((sourceRecord) => sourceRecord.recipeRevisionId))];
    const [operations, schemaBundles] = yield* Effect.all([
      input.rows.sourceRecipeOperations.listByRevisionIds(revisionIds),
      input.rows.sourceRecipeSchemaBundles.listByRevisionIds(revisionIds),
    ]);

    const operationsByRevisionId = new Map<string, StoredSourceRecipeOperationRecord[]>();
    for (const operation of operations) {
      const existing = operationsByRevisionId.get(operation.recipeRevisionId) ?? [];
      existing.push(operation);
      operationsByRevisionId.set(operation.recipeRevisionId, existing);
    }

    const schemaBundlesByRevisionId = new Map<string, StoredSourceRecipeSchemaBundleRecord[]>();
    for (const schemaBundle of schemaBundles) {
      const existing = schemaBundlesByRevisionId.get(schemaBundle.recipeRevisionId) ?? [];
      existing.push(schemaBundle);
      schemaBundlesByRevisionId.set(schemaBundle.recipeRevisionId, existing);
    }

    const entryGroups = yield* Effect.forEach(
      relevantSourceRecords,
      (sourceRecord) => {
        const source = sourceById.get(sourceRecord.id);
        if (!source) {
          return Effect.succeed<readonly LoadedSourceRecipeToolIndexEntry[]>([]);
        }

        return Effect.forEach(
          operationsByRevisionId.get(sourceRecord.recipeRevisionId) ?? [],
          (operation) =>
            Effect.gen(function* () {
              const path = recipeToolPath({
                source,
                operation,
              });
              const searchNamespace = recipeToolSearchNamespace({
                source,
                path,
                operation,
              });
              const schemaBundleId = primarySchemaBundleForRevision({
                source,
                schemaBundles: schemaBundlesByRevisionId.get(sourceRecord.recipeRevisionId) ?? [],
              })?.id ?? null;
              const metadata = yield* recipeToolMetadata({
                source,
                operation,
                path,
              });

              return {
                path,
                searchNamespace,
                searchText: [
                  path,
                  searchNamespace,
                  source.name,
                  metadata.searchText,
                ]
                  .filter((part) => part.length > 0)
                  .join(" ")
                  .toLowerCase(),
                source,
                sourceRecord,
                operation,
                metadata,
                schemaBundleId,
                descriptor: recipeToolDescriptor({
                  source,
                  operation,
                  path,
                  schemaBundleId,
                  includeSchemas: input.includeSchemas,
                }),
              } satisfies LoadedSourceRecipeToolIndexEntry;
            }),
        );
      },
    );

    return entryGroups.flat();
  });

export const loadWorkspaceSourceRecipeToolByPath = (input: {
  rows: SqlControlPlaneRows;
  workspaceId: WorkspaceId;
  path: string;
  actorAccountId?: AccountId | null;
  includeSchemas: boolean;
}): Effect.Effect<LoadedSourceRecipeToolIndexEntry | null, Error, never> =>
  Effect.gen(function* () {
    const sourceRecords = yield* input.rows.sources.listByWorkspaceId(input.workspaceId);
    const sources = yield* loadSourcesInWorkspace(input.rows, input.workspaceId, {
      actorAccountId: input.actorAccountId,
    });
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const relevantSourceRecords = sourceRecords.filter((sourceRecord) => sourceById.has(sourceRecord.id));

    const candidates = relevantSourceRecords.flatMap((sourceRecord) => {
      const source = sourceById.get(sourceRecord.id);
      if (!source) {
        return [];
      }

      const namespace = source.namespace ?? namespaceFromSourceName(source.name);
      if (namespace.length > 0) {
        if (!input.path.startsWith(`${namespace}.`)) {
          return [];
        }

        return [{
          source,
          sourceRecord,
          toolId: input.path.slice(namespace.length + 1),
        }];
      }

      return [{
        source,
        sourceRecord,
        toolId: input.path,
      }];
    });

    if (candidates.length === 0) {
      return null;
    }

    const revisionIds = [...new Set(candidates.map((candidate) => candidate.sourceRecord.recipeRevisionId))];
    const [operations, schemaBundles] = yield* Effect.all([
      input.rows.sourceRecipeOperations.listByRevisionIds(revisionIds),
      input.rows.sourceRecipeSchemaBundles.listByRevisionIds(revisionIds),
    ]);
    const schemaBundlesByRevisionId = new Map<string, StoredSourceRecipeSchemaBundleRecord[]>();
    for (const schemaBundle of schemaBundles) {
      const existing = schemaBundlesByRevisionId.get(schemaBundle.recipeRevisionId) ?? [];
      existing.push(schemaBundle);
      schemaBundlesByRevisionId.set(schemaBundle.recipeRevisionId, existing);
    }

    for (const candidate of candidates) {
      const operation = operations.find((entry) =>
        entry.recipeRevisionId === candidate.sourceRecord.recipeRevisionId
        && entry.toolId === candidate.toolId
      );
      if (!operation) {
        continue;
      }

      const path = recipeToolPath({
        source: candidate.source,
        operation,
      });
      const searchNamespace = recipeToolSearchNamespace({
        source: candidate.source,
        path,
        operation,
      });
      const schemaBundleId = primarySchemaBundleForRevision({
        source: candidate.source,
        schemaBundles:
          schemaBundlesByRevisionId.get(candidate.sourceRecord.recipeRevisionId) ?? [],
      })?.id ?? null;
      const metadata = yield* recipeToolMetadata({
        source: candidate.source,
        operation,
        path,
      });

      return {
        path,
        searchNamespace,
        searchText: [
          path,
          searchNamespace,
          candidate.source.name,
          metadata.searchText,
        ]
          .filter((part) => part.length > 0)
          .join(" ")
          .toLowerCase(),
        source: candidate.source,
        sourceRecord: candidate.sourceRecord,
        operation,
        metadata,
        schemaBundleId,
        descriptor: recipeToolDescriptor({
          source: candidate.source,
          operation,
          path,
          schemaBundleId,
          includeSchemas: input.includeSchemas,
        }),
      } satisfies LoadedSourceRecipeToolIndexEntry;
    }

    return null;
  });
