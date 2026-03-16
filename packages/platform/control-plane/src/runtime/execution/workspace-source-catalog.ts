import {
  createToolCatalogFromEntries,
  type ToolCatalog,
} from "@executor/codemode-core";
import type { AccountId, Source } from "#schema";
import * as Effect from "effect/Effect";

import {
  RuntimeSourceCatalogStoreService,
  type LoadedSourceCatalogToolIndexEntry,
  catalogToolCatalogEntry,
} from "../catalog/source-catalog-runtime";
import type { RuntimeLocalWorkspaceState } from "../local/local-runtime-context";
import {
  makeWorkspaceStorageLayer,
  type SourceArtifactStoreShape,
  type WorkspaceConfigStoreShape,
  type WorkspaceStateStoreShape,
  type WorkspaceStorageServices,
} from "../local/local-storage";
import { provideRuntimeLocalWorkspace } from "./workspace-runtime-local";

const tokenize = (value: string): string[] =>
  value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const LOW_SIGNAL_QUERY_TOKENS = new Set([
  "a",
  "an",
  "the",
  "am",
  "as",
  "for",
  "from",
  "get",
  "i",
  "in",
  "is",
  "list",
  "me",
  "my",
  "of",
  "on",
  "or",
  "signed",
  "to",
  "who",
]);

const singularizeToken = (value: string): string =>
  value.length > 3 && value.endsWith("s") ? value.slice(0, -1) : value;

const tokenEquals = (left: string, right: string): boolean =>
  left === right || singularizeToken(left) === singularizeToken(right);

const hasTokenMatch = (
  tokens: readonly string[],
  queryToken: string,
): boolean => tokens.some((token) => tokenEquals(token, queryToken));

const hasSubstringMatch = (value: string, queryToken: string): boolean => {
  if (value.includes(queryToken)) {
    return true;
  }

  const singular = singularizeToken(queryToken);
  return singular !== queryToken && value.includes(singular);
};

const queryTokenWeight = (token: string): number =>
  LOW_SIGNAL_QUERY_TOKENS.has(token) ? 0.25 : 1;

export const loadWorkspaceCatalogTools = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
  includeSchemas: boolean;
}): Effect.Effect<
  readonly LoadedSourceCatalogToolIndexEntry[],
  Error,
  WorkspaceStorageServices
> =>
  Effect.map(
    input.sourceCatalogStore.loadWorkspaceSourceCatalogToolIndex({
      workspaceId: input.workspaceId,
      actorAccountId: input.accountId,
      includeSchemas: input.includeSchemas,
    }),
    (tools) =>
      tools.filter(
        (tool) => tool.source.enabled && tool.source.status === "connected",
      ),
  );

export const loadWorkspaceCatalogToolByPath = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
  path: string;
  includeSchemas: boolean;
}): Effect.Effect<
  LoadedSourceCatalogToolIndexEntry | null,
  Error,
  WorkspaceStorageServices
> =>
  input.sourceCatalogStore.loadWorkspaceSourceCatalogToolByPath({
    workspaceId: input.workspaceId,
    path: input.path,
    actorAccountId: input.accountId,
    includeSchemas: input.includeSchemas,
  }).pipe(
    Effect.map((tool) =>
      tool && tool.source.enabled && tool.source.status === "connected"
        ? tool
        : null,
    ),
  );

const scoreCatalogTool = (
  queryTokens: readonly string[],
  tool: LoadedSourceCatalogToolIndexEntry,
): number => {
  const pathText = tool.path.toLowerCase();
  const namespaceText = tool.searchNamespace.toLowerCase();
  const toolIdText = tool.path.split(".").at(-1)?.toLowerCase() ?? "";
  const titleText = tool.capability.surface.title?.toLowerCase() ?? "";
  const descriptionText =
    tool.capability.surface.summary?.toLowerCase()
    ?? tool.capability.surface.description?.toLowerCase()
    ?? "";
  const templateText =
    tool.executable.protocol === "http"
      ? tool.executable.pathTemplate.toLowerCase()
      : tool.executable.protocol === "graphql"
        ? tool.executable.rootField.toLowerCase()
        : tool.executable.toolName.toLowerCase();

  const pathTokens = tokenize(`${tool.path} ${toolIdText}`);
  const namespaceTokens = tokenize(tool.searchNamespace);
  const titleTokens = tokenize(tool.capability.surface.title ?? "");
  const templateTokens = tokenize(templateText);

  let score = 0;
  let structuralHits = 0;
  let namespaceHits = 0;
  let pathHits = 0;

  for (const token of queryTokens) {
    const weight = queryTokenWeight(token);

    if (hasTokenMatch(pathTokens, token)) {
      score += 12 * weight;
      structuralHits += 1;
      pathHits += 1;
      continue;
    }

    if (hasTokenMatch(namespaceTokens, token)) {
      score += 11 * weight;
      structuralHits += 1;
      namespaceHits += 1;
      continue;
    }

    if (hasTokenMatch(titleTokens, token)) {
      score += 9 * weight;
      structuralHits += 1;
      continue;
    }

    if (hasTokenMatch(templateTokens, token)) {
      score += 8 * weight;
      structuralHits += 1;
      continue;
    }

    if (
      hasSubstringMatch(pathText, token) ||
      hasSubstringMatch(toolIdText, token)
    ) {
      score += 6 * weight;
      structuralHits += 1;
      pathHits += 1;
      continue;
    }

    if (hasSubstringMatch(namespaceText, token)) {
      score += 5 * weight;
      structuralHits += 1;
      namespaceHits += 1;
      continue;
    }

    if (
      hasSubstringMatch(titleText, token) ||
      hasSubstringMatch(templateText, token)
    ) {
      score += 4 * weight;
      structuralHits += 1;
      continue;
    }

    if (hasSubstringMatch(descriptionText, token)) {
      score += 0.5 * weight;
    }
  }

  const strongTokens = queryTokens.filter(
    (token) => queryTokenWeight(token) >= 1,
  );
  if (strongTokens.length >= 2) {
    for (let index = 0; index < strongTokens.length - 1; index += 1) {
      const current = strongTokens[index]!;
      const next = strongTokens[index + 1]!;
      const phrases = [
        `${current}-${next}`,
        `${current}.${next}`,
        `${current}/${next}`,
      ];

      if (
        phrases.some(
          (phrase) =>
            pathText.includes(phrase) || templateText.includes(phrase),
        )
      ) {
        score += 10;
      }
    }
  }

  if (namespaceHits > 0 && pathHits > 0) {
    score += 8;
  }

  if (structuralHits === 0 && score > 0) {
    score *= 0.25;
  }

  return score;
};

export const createWorkspaceSourceCatalog = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null;
}): ToolCatalog => {
  const workspaceStorageLayer = makeWorkspaceStorageLayer({
    workspaceConfigStore: input.workspaceConfigStore,
    workspaceStateStore: input.workspaceStateStore,
    sourceArtifactStore: input.sourceArtifactStore,
  });
  const provideWorkspaceStorage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(workspaceStorageLayer));

  const createSharedCatalog = (includeSchemas: boolean): Effect.Effect<ToolCatalog, Error, never> =>
    provideWorkspaceStorage(Effect.gen(function* () {
      const catalogTools = yield* loadWorkspaceCatalogTools({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        sourceCatalogStore: input.sourceCatalogStore,
        includeSchemas,
      });

      return createToolCatalogFromEntries({
        entries: catalogTools.map((tool) =>
          catalogToolCatalogEntry({
            tool,
            score: (queryTokens) => scoreCatalogTool(queryTokens, tool),
          }),
        ),
      });
    }));

  return {
    listNamespaces: ({ limit }) =>
      provideRuntimeLocalWorkspace(
        Effect.flatMap(createSharedCatalog(false), (catalog) =>
          catalog.listNamespaces({ limit }),
        ),
        input.runtimeLocalWorkspace,
      ),

    listTools: ({ namespace, query, limit, includeSchemas = false }) =>
      provideRuntimeLocalWorkspace(
        Effect.flatMap(createSharedCatalog(includeSchemas), (catalog) =>
          catalog.listTools({
            ...(namespace !== undefined ? { namespace } : {}),
            ...(query !== undefined ? { query } : {}),
            limit,
            includeSchemas,
          }),
        ),
        input.runtimeLocalWorkspace,
      ),

    getToolByPath: ({ path, includeSchemas }) =>
      provideRuntimeLocalWorkspace(
        Effect.flatMap(createSharedCatalog(includeSchemas), (catalog) =>
          catalog.getToolByPath({ path, includeSchemas }),
        ),
        input.runtimeLocalWorkspace,
      ),

    searchTools: ({ query, namespace, limit }) =>
      provideRuntimeLocalWorkspace(
        Effect.flatMap(createSharedCatalog(false), (catalog) =>
          catalog.searchTools({
            query,
            ...(namespace !== undefined ? { namespace } : {}),
            limit,
          }),
        ),
        input.runtimeLocalWorkspace,
      ),
  } satisfies ToolCatalog;
};
