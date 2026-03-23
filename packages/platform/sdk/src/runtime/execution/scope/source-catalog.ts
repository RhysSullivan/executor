import {
  createToolCatalogFromEntries,
  type ToolCatalog,
  type ToolNamespace,
} from "@executor/codemode-core";
import type {
  ScopeId,
  Source,
} from "#schema";
import * as Effect from "effect/Effect";

import {
  RuntimeSourceCatalogStoreService,
  type LoadedSourceCatalogToolIndexEntry,
  catalogToolCatalogEntry,
} from "../../catalog/source/runtime";
import type {
  RuntimeLocalScopeState,
} from "../../scope/runtime-context";
import {
  makeScopeStorageLayer,
  type SourceArtifactStoreShape,
  type ScopeConfigStoreShape,
  type ScopeStateStoreShape,
  type ScopeStorageServices,
} from "../../scope/storage";
import {
  provideRuntimeLocalScope,
} from "./local";

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

const namespaceFromPath = (path: string): string => {
  const [first, second] = path.split(".");
  return second ? `${first}.${second}` : first;
};

const sortNamespaces = (namespaces: Iterable<ToolNamespace>): ToolNamespace[] =>
  [...namespaces].sort((left, right) => left.namespace.localeCompare(right.namespace));

const loadWorkspaceCatalogNamespaces = (input: {
  scopeId: Source["scopeId"];
  actorScopeId: ScopeId;
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
}): Effect.Effect<
  readonly ToolNamespace[],
  Error,
  ScopeStorageServices
> =>
  Effect.gen(function* () {
    const catalogs = yield* input.sourceCatalogStore.loadWorkspaceSourceCatalogs({
      scopeId: input.scopeId,
      actorScopeId: input.actorScopeId,
    });

    const namespaces = new Map<string, ToolNamespace>();

    for (const catalog of catalogs) {
      if (!catalog.source.enabled || catalog.source.status !== "connected") {
        continue;
      }

      for (const descriptor of Object.values(catalog.projected.toolDescriptors)) {
        const namespace = namespaceFromPath(descriptor.toolPath.join("."));
        const existing = namespaces.get(namespace);
        namespaces.set(namespace, {
          namespace,
          toolCount: (existing?.toolCount ?? 0) + 1,
        });
      }
    }

    return sortNamespaces(namespaces.values());
  });

export const loadWorkspaceCatalogTools = (input: {
  scopeId: Source["scopeId"];
  actorScopeId: ScopeId;
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
}): Effect.Effect<
  readonly LoadedSourceCatalogToolIndexEntry[],
  Error,
  ScopeStorageServices
> =>
  Effect.map(
    input.sourceCatalogStore.loadWorkspaceSourceCatalogToolIndex({
      scopeId: input.scopeId,
      actorScopeId: input.actorScopeId,
    }),
    (tools) =>
      tools.filter(
        (tool) => tool.source.enabled && tool.source.status === "connected",
      ),
  );

export const loadWorkspaceCatalogToolByPath = (input: {
  scopeId: Source["scopeId"];
  actorScopeId: ScopeId;
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
  path: string;
  includeSchemas: boolean;
}): Effect.Effect<
  LoadedSourceCatalogToolIndexEntry | null,
  Error,
  ScopeStorageServices
> =>
  input.sourceCatalogStore.loadWorkspaceSourceCatalogToolByPath({
    scopeId: input.scopeId,
    path: input.path,
    actorScopeId: input.actorScopeId,
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
  const templateText = [
    tool.executable.display?.pathTemplate,
    tool.executable.display?.operationId,
    tool.executable.display?.leaf,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .toLowerCase();

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

export const createScopeSourceCatalog = (input: {
  scopeId: Source["scopeId"];
  actorScopeId: ScopeId;
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
  scopeConfigStore: ScopeConfigStoreShape;
  scopeStateStore: ScopeStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  runtimeLocalScope: RuntimeLocalScopeState | null;
}): ToolCatalog => {
  const scopeStorageLayer = makeScopeStorageLayer({
    scopeConfigStore: input.scopeConfigStore,
    scopeStateStore: input.scopeStateStore,
    sourceArtifactStore: input.sourceArtifactStore,
  });
  const provideWorkspaceStorage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(scopeStorageLayer));

  const buildSharedCatalog = () =>
    provideWorkspaceStorage(Effect.gen(function* () {
      const catalogTools = yield* loadWorkspaceCatalogTools({
        scopeId: input.scopeId,
        actorScopeId: input.actorScopeId,
        sourceCatalogStore: input.sourceCatalogStore,
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

  const leanSharedCatalog = Effect.runSync(
    Effect.cached(buildSharedCatalog()),
  );

  return {
    listNamespaces: ({ limit }) =>
      provideRuntimeLocalScope(
        provideWorkspaceStorage(Effect.map(
          loadWorkspaceCatalogNamespaces({
            scopeId: input.scopeId,
            actorScopeId: input.actorScopeId,
            sourceCatalogStore: input.sourceCatalogStore,
          }),
          (namespaces) => namespaces.slice(0, limit),
        )),
        input.runtimeLocalScope,
      ),

    listTools: ({ namespace, query, limit }) =>
      provideRuntimeLocalScope(
        Effect.flatMap(leanSharedCatalog, (catalog) =>
          catalog.listTools({
            ...(namespace !== undefined ? { namespace } : {}),
            ...(query !== undefined ? { query } : {}),
            limit,
            includeSchemas: false,
          }),
        ),
        input.runtimeLocalScope,
      ),

    getToolByPath: ({ path, includeSchemas }) =>
      provideRuntimeLocalScope(
        includeSchemas
          ? Effect.map(
              provideWorkspaceStorage(loadWorkspaceCatalogToolByPath({
                scopeId: input.scopeId,
                actorScopeId: input.actorScopeId,
                sourceCatalogStore: input.sourceCatalogStore,
                path,
                includeSchemas: true,
              })),
              (tool) => tool?.descriptor ?? null,
            )
          : Effect.flatMap(leanSharedCatalog, (catalog) =>
              catalog.getToolByPath({ path, includeSchemas: false })
            ),
        input.runtimeLocalScope,
      ),

    searchTools: ({ query, namespace, limit }) =>
      provideRuntimeLocalScope(
        Effect.flatMap(leanSharedCatalog, (catalog) =>
          catalog.searchTools({
            query,
            ...(namespace !== undefined ? { namespace } : {}),
            limit,
          }),
        ),
        input.runtimeLocalScope,
      ),
  } satisfies ToolCatalog;
};
