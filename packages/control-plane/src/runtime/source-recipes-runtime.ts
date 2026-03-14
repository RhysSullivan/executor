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

import {
  readLocalSourceArtifact,
} from "./local-source-artifacts";
import { LocalSourceArtifactMissingError } from "./local-errors";
import {
  requireRuntimeLocalWorkspace,
} from "./local-runtime-context";
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
    const runtimeLocalWorkspace = yield* requireRuntimeLocalWorkspace(input.workspaceId);
    const sources = yield* loadSourcesInWorkspace(input.rows, input.workspaceId, {
      actorAccountId: input.actorAccountId,
    });
    const localRecipes = yield* Effect.forEach(sources, (source) =>
      Effect.gen(function* () {
        const artifact = yield* readLocalSourceArtifact({
          context: runtimeLocalWorkspace.context,
          sourceId: source.id,
        });
        if (artifact === null) {
          return null;
        }

        const sourceRecord: StoredSourceRecord = {
          id: source.id,
          workspaceId: source.workspaceId,
          recipeId: artifact.recipeId,
          recipeRevisionId: artifact.revision.id,
          name: source.name,
          kind: source.kind,
          endpoint: source.endpoint,
          status: source.status,
          enabled: source.enabled,
          namespace: source.namespace,
          importAuthPolicy: source.importAuthPolicy,
          bindingConfigJson: getSourceAdapterForSource(source).serializeBindingConfig(source),
          sourceHash: source.sourceHash,
          lastError: source.lastError,
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
        };

        const manifest = yield* parseManifestForRecipe({
          source,
          revision: artifact.revision,
        });

        return {
          source,
          sourceRecord,
          revision: artifact.revision,
          documents: artifact.documents,
          schemaBundles: artifact.schemaBundles,
          operations: artifact.operations,
          manifest,
        } satisfies LoadedSourceRecipe;
      }),
    );
    return localRecipes.filter((recipe): recipe is LoadedSourceRecipe => recipe !== null);
  });

export const loadSourceWithRecipe = (input: {
  rows: SqlControlPlaneRows;
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  actorAccountId?: AccountId | null;
}): Effect.Effect<LoadedSourceRecipe, Error | LocalSourceArtifactMissingError, never> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* requireRuntimeLocalWorkspace(input.workspaceId);
    const source = yield* loadSourceById(input.rows, {
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      actorAccountId: input.actorAccountId,
    });
    const artifact = yield* readLocalSourceArtifact({
      context: runtimeLocalWorkspace.context,
      sourceId: source.id,
    });
    if (artifact === null) {
      return yield* Effect.fail(
        new LocalSourceArtifactMissingError({
          message: `Recipe artifact missing for source ${input.sourceId}`,
          sourceId: input.sourceId,
        }),
      );
    }

    const sourceRecord: StoredSourceRecord = {
      id: source.id,
      workspaceId: source.workspaceId,
      recipeId: artifact.recipeId,
      recipeRevisionId: artifact.revision.id,
      name: source.name,
      kind: source.kind,
      endpoint: source.endpoint,
      status: source.status,
      enabled: source.enabled,
      namespace: source.namespace,
      importAuthPolicy: source.importAuthPolicy,
      bindingConfigJson: getSourceAdapterForSource(source).serializeBindingConfig(source),
      sourceHash: source.sourceHash,
      lastError: source.lastError,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    };
    const manifest = yield* parseManifestForRecipe({
      source,
      revision: artifact.revision,
    });

    return {
      source,
      sourceRecord,
      revision: artifact.revision,
      documents: artifact.documents,
      schemaBundles: artifact.schemaBundles,
      operations: artifact.operations,
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
    const recipes = yield* loadWorkspaceSourceRecipes({
      rows: input.rows,
      workspaceId: input.workspaceId,
      actorAccountId: input.actorAccountId,
    });
    const tools = yield* expandRecipeTools({
      recipes,
      includeSchemas: input.includeSchemas,
    });
    return tools.map((tool) => ({
      path: tool.path,
      searchNamespace: tool.searchNamespace,
      searchText: tool.searchText,
      source: tool.source,
      sourceRecord: tool.sourceRecord,
      operation: tool.operation,
      metadata: tool.metadata,
      schemaBundleId: tool.schemaBundleId,
      descriptor: tool.descriptor,
    }));
  });

export const loadWorkspaceSourceRecipeToolByPath = (input: {
  rows: SqlControlPlaneRows;
  workspaceId: WorkspaceId;
  path: string;
  actorAccountId?: AccountId | null;
  includeSchemas: boolean;
}): Effect.Effect<LoadedSourceRecipeToolIndexEntry | null, Error, never> =>
  Effect.gen(function* () {
    const recipes = yield* loadWorkspaceSourceRecipes({
      rows: input.rows,
      workspaceId: input.workspaceId,
      actorAccountId: input.actorAccountId,
    });
    const tools = yield* expandRecipeTools({
      recipes,
      includeSchemas: input.includeSchemas,
    });
    const tool = tools.find((entry) => entry.path === input.path) ?? null;
    return tool
      ? {
          path: tool.path,
          searchNamespace: tool.searchNamespace,
          searchText: tool.searchText,
          source: tool.source,
          sourceRecord: tool.sourceRecord,
          operation: tool.operation,
          metadata: tool.metadata,
          schemaBundleId: tool.schemaBundleId,
          descriptor: tool.descriptor,
        }
      : null;
  });
