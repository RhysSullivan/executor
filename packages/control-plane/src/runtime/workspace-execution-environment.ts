import {
  createSystemToolMap,
  createToolCatalogFromTools,
  makeToolInvokerFromTools,
  type SearchHit,
  type ToolCatalog,
  type ToolDescriptor,
  type ToolInvoker,
  type ToolNamespace,
  type ToolPath,
  typeSignatureFromSchemaJson,
} from "@executor-v3/codemode-core";
import {
  createSdkMcpConnector,
  createMcpToolsFromManifest,
} from "@executor-v3/codemode-mcp";
import {
  buildOpenApiToolPresentation,
  compileOpenApiToolDefinitions,
  createOpenApiToolsFromManifest,
  extractOpenApiManifest,
  openApiOutputTypeSignatureFromSchemaJson,
  type OpenApiToolDefinition,
  type OpenApiToolManifest,
} from "@executor-v3/codemode-openapi";
import { makeInProcessExecutor } from "@executor-v3/runtime-local-inproc";
import {
  SqlControlPlaneRowsService,
  type SqlControlPlaneRows,
} from "#persistence";
import type {
  Source,
  StoredToolArtifactRecord,
} from "#schema";
import * as Context from "effect/Context";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  ExecutionEnvironment,
  ResolveExecutionEnvironment,
} from "./execution-state";
import { createExecutorToolMap } from "./executor-tools";
import {
  createGraphqlToolsFromManifest,
  extractGraphqlManifest,
  graphqlToolDescriptorFromDefinition,
  compileGraphqlToolDefinitions,
  type GraphqlToolDefinition,
  type GraphqlToolManifest,
} from "./graphql-tools";
import {
  loadSourceById as loadStoredSourceById,
  loadSourcesInWorkspace,
} from "./source-store";
import {
  RuntimeSourceAuthServiceTag,
  type RuntimeSourceAuthService,
} from "./source-auth-service";
import {
  createDefaultSecretMaterialResolver,
  type ResolveSecretMaterial,
  type SecretMaterialResolveContext,
} from "./secret-material-providers";
import {
  namespaceFromSourceName,
  resolveSourceAuthMaterial,
  storedToolIdFromArtifact,
} from "./tool-artifacts";

const asToolPath = (value: string): ToolPath => value as ToolPath;

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
  value.length > 3 && value.endsWith("s")
    ? value.slice(0, -1)
    : value;

const tokenEquals = (left: string, right: string): boolean =>
  left === right || singularizeToken(left) === singularizeToken(right);

const hasTokenMatch = (tokens: readonly string[], queryToken: string): boolean =>
  tokens.some((token) => tokenEquals(token, queryToken));

const hasSubstringMatch = (value: string, queryToken: string): boolean => {
  if (value.includes(queryToken)) {
    return true;
  }

  const singular = singularizeToken(queryToken);
  return singular !== queryToken && value.includes(singular);
};

const SecretResolutionContextEnvelopeSchema = Schema.Struct({
  params: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
});

const decodeSecretResolutionContextEnvelope = Schema.decodeUnknownEither(
  SecretResolutionContextEnvelopeSchema,
);

const toSecretResolutionContext = (
  value: unknown,
): SecretMaterialResolveContext | undefined => {
  const decoded = decodeSecretResolutionContextEnvelope(value);
  if (Either.isLeft(decoded) || decoded.right.params === undefined) {
    return undefined;
  }

  return {
    params: decoded.right.params,
  };
};

const queryTokenWeight = (token: string): number =>
  LOW_SIGNAL_QUERY_TOKENS.has(token) ? 0.25 : 1;

const scoreArtifact = (
  queryTokens: readonly string[],
  artifact: StoredToolArtifactRecord,
): number => {
  const pathText = artifact.path.toLowerCase();
  const namespaceText = artifact.searchNamespace.toLowerCase();
  const toolIdText = artifact.toolId.toLowerCase();
  const titleText = artifact.title?.toLowerCase() ?? "";
  const descriptionText = artifact.description?.toLowerCase() ?? "";
  const templateText = artifact.openApiPathTemplate?.toLowerCase() ?? "";

  const pathTokens = tokenize(`${artifact.path} ${artifact.toolId}`);
  const namespaceTokens = tokenize(artifact.searchNamespace);
  const titleTokens = tokenize(artifact.title ?? "");
  const templateTokens = tokenize(artifact.openApiPathTemplate ?? "");

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

    if (hasSubstringMatch(pathText, token) || hasSubstringMatch(toolIdText, token)) {
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

    if (hasSubstringMatch(titleText, token) || hasSubstringMatch(templateText, token)) {
      score += 4 * weight;
      structuralHits += 1;
      continue;
    }

    if (hasSubstringMatch(descriptionText, token)) {
      score += 0.5 * weight;
    }
  }

  const strongTokens = queryTokens.filter((token) => queryTokenWeight(token) >= 1);
  if (strongTokens.length >= 2) {
    for (let index = 0; index < strongTokens.length - 1; index += 1) {
      const current = strongTokens[index]!;
      const next = strongTokens[index + 1]!;
      const phrases = [
        `${current}-${next}`,
        `${current}.${next}`,
        `${current}/${next}`,
      ];

      if (phrases.some((phrase) => pathText.includes(phrase) || templateText.includes(phrase))) {
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

const catalogNamespaceFromPath = (path: string): string => {
  const [first, second] = path.split(".");
  return second ? `${first}.${second}` : first;
};

const toPersistedDescriptor = (input: {
  artifact: StoredToolArtifactRecord;
  includeSchemas: boolean;
}): ToolDescriptor => ({
  path: asToolPath(input.artifact.path),
  sourceKey: input.artifact.sourceId,
  description: input.artifact.description ?? input.artifact.title ?? undefined,
  interaction: "auto",
  inputType: typeSignatureFromSchemaJson(
    input.artifact.inputSchemaJson ?? undefined,
    "unknown",
    320,
  ),
  outputType:
    input.artifact.providerKind === "openapi"
      ? openApiOutputTypeSignatureFromSchemaJson(
        input.artifact.outputSchemaJson ?? undefined,
        320,
      )
      : typeSignatureFromSchemaJson(
        input.artifact.outputSchemaJson ?? undefined,
        "unknown",
        320,
      ),
  inputSchemaJson: input.includeSchemas ? input.artifact.inputSchemaJson ?? undefined : undefined,
  outputSchemaJson: input.includeSchemas ? input.artifact.outputSchemaJson ?? undefined : undefined,
  ...(input.artifact.providerKind ? { providerKind: input.artifact.providerKind } : {}),
});

type OpenApiWorkspaceTool = {
  path: ToolPath;
  source: Source;
  manifest: OpenApiToolManifest;
  definition: OpenApiToolDefinition;
  descriptor: ToolDescriptor;
  searchNamespace: string;
  searchText: string;
};

type GraphqlWorkspaceTool = {
  path: ToolPath;
  source: Source;
  manifest: GraphqlToolManifest;
  definition: GraphqlToolDefinition;
  descriptor: ToolDescriptor;
  searchNamespace: string;
  searchText: string;
};

const loadOpenApiWorkspaceTools = (input: {
  rows: SqlControlPlaneRows;
  workspaceId: Source["workspaceId"];
  includeSchemas: boolean;
}): Effect.Effect<ReadonlyArray<OpenApiWorkspaceTool>, Error, never> =>
  Effect.gen(function* () {
    const sourceRecords = yield* input.rows.sources.listByWorkspaceId(input.workspaceId).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );
    const documentBySourceId = new Map(
      sourceRecords.map((record) => [record.id, record.sourceDocumentText]),
    );
    const sources = yield* loadSourcesInWorkspace(input.rows, input.workspaceId);

    const connectedOpenApiSources = sources.filter((source) =>
      source.enabled
      && source.status === "connected"
      && source.kind === "openapi"
      && typeof documentBySourceId.get(source.id) === "string"
      && documentBySourceId.get(source.id)!.length > 0,
    );

    const toolGroups = yield* Effect.forEach(
      connectedOpenApiSources,
      (source) =>
        Effect.gen(function* () {
          const openApiDocument = documentBySourceId.get(source.id)!;
          const manifest = yield* extractOpenApiManifest(
            source.name,
            openApiDocument,
          ).pipe(
            Effect.mapError((cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
            ),
          );
          const definitions = compileOpenApiToolDefinitions(manifest);
          const namespace = source.namespace ?? namespaceFromSourceName(source.name);

          return definitions.map((definition) => {
            const presentation = buildOpenApiToolPresentation({
              manifest,
              definition,
            });
            const path = asToolPath(
              namespace ? `${namespace}.${definition.toolId}` : definition.toolId,
            );
            const searchNamespace = catalogNamespaceFromPath(path);
            const searchText = [
              path,
              searchNamespace,
              definition.name,
              definition.description,
              definition.rawToolId,
              definition.tags.join(" "),
              definition.method.toUpperCase(),
              definition.path,
            ]
              .filter((part): part is string => typeof part === "string" && part.length > 0)
              .join(" ")
              .toLowerCase();

            return {
              path,
              source,
              manifest,
              definition,
              descriptor: {
                path,
                sourceKey: source.id,
                description: definition.description,
                interaction: "auto",
                inputType: presentation.inputType,
                outputType: presentation.outputType,
                ...(input.includeSchemas && presentation.inputSchemaJson
                  ? { inputSchemaJson: presentation.inputSchemaJson }
                  : {}),
                ...(input.includeSchemas && presentation.outputSchemaJson
                  ? { outputSchemaJson: presentation.outputSchemaJson }
                  : {}),
                ...(presentation.exampleInputJson
                  ? { exampleInputJson: presentation.exampleInputJson }
                  : {}),
                ...(presentation.exampleOutputJson
                  ? { exampleOutputJson: presentation.exampleOutputJson }
                  : {}),
                providerKind: "openapi",
                providerDataJson: presentation.providerDataJson,
              } satisfies ToolDescriptor,
              searchNamespace,
              searchText,
            } satisfies OpenApiWorkspaceTool;
          });
        }),
      { concurrency: "unbounded" },
    );

    return toolGroups.flat();
  });

const loadGraphqlWorkspaceTools = (input: {
  rows: SqlControlPlaneRows;
  workspaceId: Source["workspaceId"];
  includeSchemas: boolean;
}): Effect.Effect<ReadonlyArray<GraphqlWorkspaceTool>, Error, never> =>
  Effect.gen(function* () {
    const sourceRecords = yield* input.rows.sources.listByWorkspaceId(input.workspaceId).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );
    const documentBySourceId = new Map(
      sourceRecords.map((record) => [record.id, record.sourceDocumentText]),
    );
    const sources = yield* loadSourcesInWorkspace(input.rows, input.workspaceId);

    const connectedGraphqlSources = sources.filter((source) =>
      source.enabled
      && source.status === "connected"
      && source.kind === "graphql"
      && typeof documentBySourceId.get(source.id) === "string"
      && documentBySourceId.get(source.id)!.length > 0,
    );

    const toolGroups = yield* Effect.forEach(
      connectedGraphqlSources,
      (source) =>
        Effect.gen(function* () {
          const graphqlDocument = documentBySourceId.get(source.id)!;
          const manifest = yield* extractGraphqlManifest(
            source.name,
            graphqlDocument,
          ).pipe(
            Effect.mapError((cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
            ),
          );
          const definitions = compileGraphqlToolDefinitions(manifest);
          const namespace = source.namespace ?? namespaceFromSourceName(source.name);

          return definitions.map((definition) => {
            const path = asToolPath(
              namespace ? `${namespace}.${definition.toolId}` : definition.toolId,
            );
            const searchNamespace = namespace;
            const descriptor = graphqlToolDescriptorFromDefinition({
              manifest,
              definition,
              path,
              sourceKey: source.id,
              includeSchemas: input.includeSchemas,
            });
            const searchText = [
              path,
              searchNamespace,
              source.name,
              definition.name,
              definition.description,
              definition.rawToolId,
              definition.fieldName,
              definition.group,
              definition.leaf,
              definition.operationType,
              definition.operationName,
              definition.searchTerms.join(" "),
              definition.toolId === "request"
                ? "graphql request query mutation variables"
                : "graphql field query mutation",
              manifest.queryTypeName,
              manifest.mutationTypeName,
              manifest.subscriptionTypeName,
            ]
              .filter((part): part is string => typeof part === "string" && part.length > 0)
              .join(" ")
              .toLowerCase();

            return {
              path,
              source,
              manifest,
              definition,
              descriptor,
              searchNamespace,
              searchText,
            } satisfies GraphqlWorkspaceTool;
          });
        }),
      { concurrency: "unbounded" },
    );

    return toolGroups.flat();
  });


const loadSourceById = (input: {
  rows: SqlControlPlaneRows;
  workspaceId: Source["workspaceId"];
  sourceId: Source["id"];
}): Effect.Effect<Source, Error, never> =>
  loadStoredSourceById(input.rows, {
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
    ),
  );

const createWorkspaceToolCatalog = (input: {
  workspaceId: Source["workspaceId"];
  rows: SqlControlPlaneRows;
  executorCatalog: ToolCatalog;
}): ToolCatalog => ({
  listNamespaces: ({ limit }) =>
    Effect.gen(function* () {
      const [persisted, openApiTools, graphqlTools, executor] = yield* Effect.all([
        input.rows.toolArtifacts.listNamespacesByWorkspaceId(input.workspaceId, {
          limit,
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
          ),
        ),
        loadOpenApiWorkspaceTools({
          rows: input.rows,
          workspaceId: input.workspaceId,
          includeSchemas: false,
        }),
        loadGraphqlWorkspaceTools({
          rows: input.rows,
          workspaceId: input.workspaceId,
          includeSchemas: false,
        }),
        input.executorCatalog.listNamespaces({ limit }),
      ]);

      const merged = new Map<string, ToolNamespace>();
      for (const namespace of persisted) {
        merged.set(namespace.namespace, namespace);
      }
      for (const tool of openApiTools) {
        const existing = merged.get(tool.searchNamespace);
        merged.set(tool.searchNamespace, {
          namespace: tool.searchNamespace,
          toolCount: (existing?.toolCount ?? 0) + 1,
        });
      }
      for (const tool of graphqlTools) {
        const existing = merged.get(tool.searchNamespace);
        merged.set(tool.searchNamespace, {
          namespace: tool.searchNamespace,
          toolCount: (existing?.toolCount ?? 0) + 1,
        });
      }
      for (const namespace of executor) {
        const existing = merged.get(namespace.namespace);
        merged.set(namespace.namespace, {
          namespace: namespace.namespace,
          displayName: namespace.displayName ?? existing?.displayName,
          toolCount:
            namespace.toolCount !== undefined || existing?.toolCount === undefined
              ? namespace.toolCount
              : existing.toolCount,
        });
      }

      return [...merged.values()]
        .sort((left, right) => left.namespace.localeCompare(right.namespace))
        .slice(0, limit);
    }),

  listTools: ({ namespace, query, limit, includeSchemas = false }) =>
    Effect.gen(function* () {
      const [persisted, openApiTools, graphqlTools, executor] = yield* Effect.all([
        namespace?.startsWith("executor")
          ? Effect.succeed([] as readonly StoredToolArtifactRecord[])
          : input.rows.toolArtifacts.listByWorkspaceId(input.workspaceId, {
            namespace,
            query,
            limit,
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
            ),
          ),
        loadOpenApiWorkspaceTools({
          rows: input.rows,
          workspaceId: input.workspaceId,
          includeSchemas,
        }).pipe(
          Effect.map((tools) =>
            tools.filter((tool) => {
              if (namespace && tool.searchNamespace !== namespace) {
                return false;
              }
              if (!query) {
                return true;
              }
              return tokenize(query).every((token) => tool.searchText.includes(token));
            }),
          ),
        ),
        loadGraphqlWorkspaceTools({
          rows: input.rows,
          workspaceId: input.workspaceId,
          includeSchemas,
        }).pipe(
          Effect.map((tools) =>
            tools.filter((tool) => {
              if (namespace && tool.searchNamespace !== namespace) {
                return false;
              }
              if (!query) {
                return true;
              }
              return tokenize(query).every((token) => tool.searchText.includes(token));
            }),
          ),
        ),
        input.executorCatalog.listTools({
          ...(namespace !== undefined ? { namespace } : {}),
          ...(query !== undefined ? { query } : {}),
          limit,
          includeSchemas,
        }),
      ]);

      const persistedDescriptors = persisted.map((artifact) =>
        toPersistedDescriptor({
          artifact,
          includeSchemas,
        }),
      );

      return [
        ...persistedDescriptors,
        ...openApiTools.map((tool) => tool.descriptor),
        ...graphqlTools.map((tool) => tool.descriptor),
        ...executor,
      ]
        .sort((left, right) => left.path.localeCompare(right.path))
        .slice(0, limit);
    }),

  getToolByPath: ({ path, includeSchemas }) =>
    Effect.gen(function* () {
      const executor = yield* input.executorCatalog.getToolByPath({
        path,
        includeSchemas,
      });
      if (executor) {
        return executor;
      }

      const openApiTools = yield* loadOpenApiWorkspaceTools({
        rows: input.rows,
        workspaceId: input.workspaceId,
        includeSchemas,
      });
      const openApiTool = openApiTools.find((tool) => tool.path === path);
      if (openApiTool) {
        return openApiTool.descriptor;
      }

      const graphqlTools = yield* loadGraphqlWorkspaceTools({
        rows: input.rows,
        workspaceId: input.workspaceId,
        includeSchemas,
      });
      const graphqlTool = graphqlTools.find((tool) => tool.path === path);
      if (graphqlTool) {
        return graphqlTool.descriptor;
      }

      const artifact = yield* input.rows.toolArtifacts.getByWorkspaceAndPath(
        input.workspaceId,
        path,
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
      );

      if (Option.isNone(artifact)) {
        return null;
      }

      return toPersistedDescriptor({
        artifact: artifact.value,
        includeSchemas,
      });
    }),

  searchTools: ({ query, namespace, limit }) =>
    Effect.gen(function* () {
      const queryTokens = tokenize(query);
      const [persisted, openApiTools, graphqlTools, executor] = yield* Effect.all([
        namespace?.startsWith("executor")
          ? Effect.succeed([] as readonly StoredToolArtifactRecord[])
          : input.rows.toolArtifacts.searchByWorkspaceId(input.workspaceId, {
            namespace,
            query,
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
            ),
          ),
        loadOpenApiWorkspaceTools({
          rows: input.rows,
          workspaceId: input.workspaceId,
          includeSchemas: false,
        }).pipe(
          Effect.map((tools) =>
            tools.filter((tool) => !namespace || tool.searchNamespace === namespace),
          ),
        ),
        loadGraphqlWorkspaceTools({
          rows: input.rows,
          workspaceId: input.workspaceId,
          includeSchemas: false,
        }).pipe(
          Effect.map((tools) =>
            tools.filter((tool) => !namespace || tool.searchNamespace === namespace),
          ),
        ),
        input.executorCatalog.searchTools({
          query,
          ...(namespace !== undefined ? { namespace } : {}),
          limit,
        }),
      ]);

      const persistedHits: SearchHit[] = persisted
        .map((artifact) => ({
          path: asToolPath(artifact.path),
          score: scoreArtifact(queryTokens, artifact),
        }))
        .filter((hit) => hit.score > 0);

      const openApiHits: SearchHit[] = openApiTools
        .map((tool) => ({
          path: tool.path,
          score: tokenize(query).reduce(
            (total, token) => total + (tool.searchText.includes(token) ? 1 : 0),
            0,
          ),
        }))
        .filter((hit) => hit.score > 0);

      const graphqlHits: SearchHit[] = graphqlTools
        .map((tool) => ({
          path: tool.path,
          score: tokenize(query).reduce(
            (total, token) => total + (tool.searchText.includes(token) ? 1 : 0),
            0,
          ),
        }))
        .filter((hit) => hit.score > 0);

      return [...persistedHits, ...openApiHits, ...graphqlHits, ...executor]
        .sort((left, right) =>
          right.score - left.score || left.path.localeCompare(right.path),
        )
        .slice(0, limit);
    }),
});

const createWorkspaceToolInvoker = (input: {
  workspaceId: Source["workspaceId"];
  rows: SqlControlPlaneRows;
  resolveSecretMaterial: ResolveSecretMaterial;
  sourceAuthService: RuntimeSourceAuthService;
  onElicitation?: Parameters<typeof makeToolInvokerFromTools>[0]["onElicitation"];
}): {
  catalog: ToolCatalog;
  toolInvoker: ToolInvoker;
} => {
  const executorTools = createExecutorToolMap({
    workspaceId: input.workspaceId,
    sourceAuthService: input.sourceAuthService,
  });
  const executorCatalog = createToolCatalogFromTools({
    tools: executorTools,
  });
  const catalog = createWorkspaceToolCatalog({
    workspaceId: input.workspaceId,
    rows: input.rows,
    executorCatalog,
  });
  const systemTools = createSystemToolMap({ catalog });
  const systemToolPaths = new Set(Object.keys(systemTools));
  const executorToolPaths = new Set(Object.keys(executorTools));
  const systemInvoker = makeToolInvokerFromTools({
    tools: systemTools,
    onElicitation: input.onElicitation,
  });
  const executorInvoker = makeToolInvokerFromTools({
    tools: executorTools,
    onElicitation: input.onElicitation,
  });

  const invokePersistedTool = (invocation: {
    path: string;
    args: unknown;
    context?: Record<string, unknown>;
  }) =>
    Effect.gen(function* () {
      const openApiTools = yield* loadOpenApiWorkspaceTools({
        rows: input.rows,
        workspaceId: input.workspaceId,
        includeSchemas: false,
      });
      const openApiTool = openApiTools.find((tool) => tool.path === invocation.path);
      if (openApiTool) {
        const auth = yield* resolveSourceAuthMaterial({
          source: openApiTool.source,
          resolveSecretMaterial: input.resolveSecretMaterial,
          context: toSecretResolutionContext(invocation.context),
        });

        const tools = createOpenApiToolsFromManifest({
          manifest: openApiTool.manifest,
          baseUrl: openApiTool.source.endpoint,
          namespace: openApiTool.source.namespace ?? namespaceFromSourceName(openApiTool.source.name),
          sourceKey: openApiTool.source.id,
          defaultHeaders: openApiTool.source.defaultHeaders ?? {},
          credentialHeaders: auth.headers,
        });

        return yield* makeToolInvokerFromTools({
          tools,
          onElicitation: input.onElicitation,
        }).invoke({
          path: invocation.path,
          args: invocation.args,
          context: invocation.context,
        });
      }

      const graphqlTools = yield* loadGraphqlWorkspaceTools({
        rows: input.rows,
        workspaceId: input.workspaceId,
        includeSchemas: false,
      });
      const graphqlTool = graphqlTools.find((tool) => tool.path === invocation.path);
      if (graphqlTool) {
        const auth = yield* resolveSourceAuthMaterial({
          source: graphqlTool.source,
          resolveSecretMaterial: input.resolveSecretMaterial,
          context: toSecretResolutionContext(invocation.context),
        });

        const tools = createGraphqlToolsFromManifest({
          manifest: graphqlTool.manifest,
          endpoint: graphqlTool.source.endpoint,
          namespace: graphqlTool.source.namespace ?? namespaceFromSourceName(graphqlTool.source.name),
          sourceKey: graphqlTool.source.id,
          defaultHeaders: graphqlTool.source.defaultHeaders ?? {},
          credentialHeaders: auth.headers,
        });

        return yield* makeToolInvokerFromTools({
          tools,
          onElicitation: input.onElicitation,
        }).invoke({
          path: invocation.path,
          args: invocation.args,
          context: invocation.context,
        });
      }

      const artifactOption = yield* input.rows.toolArtifacts
        .getByWorkspaceAndPath(input.workspaceId, invocation.path)
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
          ),
        );

      if (Option.isNone(artifactOption)) {
        return yield* Effect.fail(new Error(`Unknown tool path: ${invocation.path}`));
      }

      const artifact = artifactOption.value;
      const source = yield* loadSourceById({
        rows: input.rows,
        workspaceId: input.workspaceId,
        sourceId: artifact.sourceId,
      });

      if (!source.enabled || source.status !== "connected") {
        return yield* Effect.fail(
          new Error(`Source for tool path ${invocation.path} is not connected`),
        );
      }

      const auth = yield* resolveSourceAuthMaterial({
        source,
        resolveSecretMaterial: input.resolveSecretMaterial,
        context: toSecretResolutionContext(invocation.context),
      });

      if (artifact.providerKind === "mcp") {
        const tools = createMcpToolsFromManifest({
          manifest: {
            version: 1,
            tools: [{
              toolId: storedToolIdFromArtifact(artifact),
              toolName: artifact.mcpToolName ?? artifact.title ?? artifact.path,
              description: artifact.description ?? null,
              ...(artifact.inputSchemaJson ? { inputSchemaJson: artifact.inputSchemaJson } : {}),
              ...(artifact.outputSchemaJson ? { outputSchemaJson: artifact.outputSchemaJson } : {}),
            }],
          },
          connect: createSdkMcpConnector({
            endpoint: source.endpoint,
            transport: source.transport ?? undefined,
            queryParams: source.queryParams ?? undefined,
            headers: {
              ...(source.headers ?? {}),
              ...auth.headers,
            },
          }),
          namespace: source.namespace ?? namespaceFromSourceName(source.name),
          sourceKey: source.id,
        });

        return yield* makeToolInvokerFromTools({
          tools,
          onElicitation: input.onElicitation,
        }).invoke({
          path: invocation.path,
          args: invocation.args,
          context: invocation.context,
        });
      }

      return yield* Effect.fail(
        new Error(`Unsupported stored tool provider for ${invocation.path}`),
      );
    });

  return {
    catalog,
    toolInvoker: {
      invoke: ({ path, args, context }) =>
        systemToolPaths.has(path)
          ? systemInvoker.invoke({ path, args, context })
          : executorToolPaths.has(path)
            ? executorInvoker.invoke({ path, args, context })
            : invokePersistedTool({ path, args, context }),
    },
  };
};

export const createWorkspaceExecutionEnvironmentResolver = (input: {
  rows: SqlControlPlaneRows;
  resolveSecretMaterial?: ResolveSecretMaterial;
  sourceAuthService: RuntimeSourceAuthService;
}): ResolveExecutionEnvironment => {
  const resolveSecretMaterial =
    input.resolveSecretMaterial
    ?? createDefaultSecretMaterialResolver({
      rows: input.rows,
    });

  return ({ workspaceId, onElicitation }) =>
    Effect.sync(() => {
      const { catalog, toolInvoker } = createWorkspaceToolInvoker({
        workspaceId,
        rows: input.rows,
        resolveSecretMaterial,
        sourceAuthService: input.sourceAuthService,
        onElicitation,
      });

      return {
        executor: makeInProcessExecutor(),
        toolInvoker,
        catalog,
      } satisfies ExecutionEnvironment;
    });
};

export class RuntimeExecutionResolverService extends Context.Tag(
  "#runtime/RuntimeExecutionResolverService",
)<
  RuntimeExecutionResolverService,
  ReturnType<typeof createWorkspaceExecutionEnvironmentResolver>
>() {
}

export const RuntimeExecutionResolverLive = (input: {
  executionResolver?: ResolveExecutionEnvironment;
  resolveSecretMaterial?: ResolveSecretMaterial;
} = {}) =>
  input.executionResolver
    ? Layer.succeed(RuntimeExecutionResolverService, input.executionResolver)
    : Layer.effect(
      RuntimeExecutionResolverService,
      Effect.gen(function* () {
        const rows = yield* SqlControlPlaneRowsService;
        const sourceAuthService = yield* RuntimeSourceAuthServiceTag;

        return createWorkspaceExecutionEnvironmentResolver({
          rows,
          sourceAuthService,
          resolveSecretMaterial: input.resolveSecretMaterial,
        });
      }),
    );
