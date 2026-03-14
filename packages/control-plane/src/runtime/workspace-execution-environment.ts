import {
  createSystemToolMap,
  createToolCatalogFromTools,
  makeToolInvokerFromTools,
  type SearchHit,
  type ToolCatalog,
  type ToolInvoker,
  type ToolNamespace,
  type ToolPath,
  type ToolSchemaBundle,
} from "@executor/codemode-core";
import { makeQuickJsExecutor } from "@executor/runtime-quickjs";
import {
  SqlControlPlaneRowsService,
  type SqlControlPlaneRows,
} from "#persistence";
import type { AccountId, Source, SourceRecipeSchemaBundleId } from "#schema";
import { SourceRecipeSchemaBundleIdSchema } from "#schema";
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
  RuntimeSourceAuthServiceTag,
  type RuntimeSourceAuthService,
} from "./source-auth-service";
import {
  loadSourceWithRecipe,
  loadWorkspaceSourceRecipeToolByPath,
  loadWorkspaceSourceRecipeToolIndex,
  loadWorkspaceSourceRecipes,
  type LoadedSourceRecipeToolIndexEntry,
} from "./source-recipes-runtime";
import { resolveSourceAuthMaterial } from "./source-auth-material";
import { namespaceFromSourceName } from "./source-names";
import { getSourceAdapterForOperation } from "./source-adapters";
import {
  createDefaultSecretMaterialResolver,
  type ResolveSecretMaterial,
  type SecretMaterialResolveContext,
} from "./secret-material-providers";
import {
  evaluateInvocationPolicy,
  type InvocationDescriptor,
} from "./invocation-policy-engine";
import {
  loadRuntimeLocalWorkspacePolicies,
} from "./policies-operations";
import {
  getRuntimeLocalWorkspaceOption,
  RuntimeLocalWorkspaceService,
  type RuntimeLocalWorkspaceState,
} from "./local-runtime-context";

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

const loadWorkspaceRecipeTools = (input: {
  rows: SqlControlPlaneRows;
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  includeSchemas: boolean;
}): Effect.Effect<readonly LoadedSourceRecipeToolIndexEntry[], Error, never> =>
  Effect.map(
    loadWorkspaceSourceRecipeToolIndex({
      rows: input.rows,
      workspaceId: input.workspaceId,
      actorAccountId: input.accountId,
      includeSchemas: input.includeSchemas,
    }),
    (tools) =>
      tools.filter(
        (tool) => tool.source.enabled && tool.source.status === "connected",
      ),
  );

const loadWorkspaceRecipeToolByPath = (input: {
  rows: SqlControlPlaneRows;
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  path: string;
  includeSchemas: boolean;
}): Effect.Effect<LoadedSourceRecipeToolIndexEntry | null, Error, never> =>
  loadWorkspaceSourceRecipeToolByPath({
    rows: input.rows,
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

const loadWorkspaceSchemaBundle = (input: {
  rows: SqlControlPlaneRows;
  workspaceId: Source["workspaceId"];
  id: SourceRecipeSchemaBundleId;
}): Effect.Effect<ToolSchemaBundle | null, Error, never> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* getRuntimeLocalWorkspaceOption();
    if (runtimeLocalWorkspace !== null) {
      const recipes = yield* loadWorkspaceSourceRecipes({
        rows: input.rows,
        workspaceId: input.workspaceId,
      });
      const localBundle = recipes
        .flatMap((recipe) => recipe.schemaBundles)
        .find((schemaBundle) => schemaBundle.id === input.id);
      return localBundle
        ? {
            id: localBundle.id,
            kind: localBundle.bundleKind,
            hash: localBundle.contentHash,
            refsJson: localBundle.refsJson,
          }
        : null;
    }

    const bundle = yield* input.rows.sourceRecipeSchemaBundles.getById(input.id);
    if (Option.isSome(bundle)) {
      const sourceRecords = yield* input.rows.sources.listByWorkspaceId(input.workspaceId);
      if (sourceRecords.some((sourceRecord) => sourceRecord.recipeRevisionId === bundle.value.recipeRevisionId)) {
        return {
          id: bundle.value.id,
          kind: bundle.value.bundleKind,
          hash: bundle.value.contentHash,
          refsJson: bundle.value.refsJson,
        };
      }
    }
    return null;
  });

const scoreRecipeTool = (
  queryTokens: readonly string[],
  tool: LoadedSourceRecipeToolIndexEntry,
): number => {
  const pathText = tool.path.toLowerCase();
  const namespaceText = tool.searchNamespace.toLowerCase();
  const toolIdText = tool.operation.toolId.toLowerCase();
  const titleText = tool.operation.title?.toLowerCase() ?? "";
  const descriptionText = tool.operation.description?.toLowerCase() ?? "";
  const templateText = tool.metadata.pathTemplate?.toLowerCase() ?? "";

  const pathTokens = tokenize(`${tool.path} ${tool.operation.toolId}`);
  const namespaceTokens = tokenize(tool.searchNamespace);
  const titleTokens = tokenize(tool.operation.title ?? "");
  const templateTokens = tokenize(tool.metadata.pathTemplate ?? "");

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

const approvalSchema = {
  type: "object",
  properties: {
    approve: {
      type: "boolean",
      description: "Whether to approve this tool execution",
    },
  },
  required: ["approve"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

const approvalMessageForInvocation = (
  descriptor: InvocationDescriptor,
): string => {
  if (descriptor.approvalLabel) {
    return `Allow ${descriptor.approvalLabel}?`;
  }

  return `Allow tool call: ${descriptor.toolPath}?`;
};

const toInvocationDescriptorFromRecipeTool = (input: {
  tool: LoadedSourceRecipeToolIndexEntry;
}): InvocationDescriptor => ({
  toolPath: input.tool.path,
  sourceId: input.tool.source.id,
  sourceName: input.tool.source.name,
  sourceKind: input.tool.source.kind,
  sourceNamespace:
    input.tool.source.namespace ??
    namespaceFromSourceName(input.tool.source.name),
  operationKind: input.tool.operation.operationKind,
  interaction: input.tool.metadata.interaction,
  approvalLabel: input.tool.metadata.approvalLabel,
});

const authorizePersistedToolInvocation = (input: {
  rows: SqlControlPlaneRows;
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  descriptor: InvocationDescriptor;
  args: unknown;
  source: Source;
  context?: Record<string, unknown>;
  onElicitation?: Parameters<
    typeof makeToolInvokerFromTools
  >[0]["onElicitation"];
}): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const localWorkspacePolicies = yield* loadRuntimeLocalWorkspacePolicies(input.workspaceId).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );

    const decision = evaluateInvocationPolicy({
      descriptor: input.descriptor,
      args: input.args,
      policies: localWorkspacePolicies.policies,
      context: {
        workspaceId: input.workspaceId,
      },
    });

    if (decision.kind === "allow") {
      return;
    }

    if (decision.kind === "deny") {
      return yield* Effect.fail(new Error(decision.reason));
    }

    if (!input.onElicitation) {
      return yield* Effect.fail(
        new Error(
          `Approval required for ${input.descriptor.toolPath}, but no elicitation-capable host is available`,
        ),
      );
    }

    const interactionId =
      typeof input.context?.callId === "string" &&
      input.context.callId.length > 0
        ? `tool_execution_gate:${input.context.callId}`
        : `tool_execution_gate:${crypto.randomUUID()}`;
    const response = yield* input
      .onElicitation({
        interactionId,
        path: asToolPath(input.descriptor.toolPath),
        sourceKey: input.source.id,
        args: input.args,
        context: {
          ...(input.context ?? {}),
          interactionPurpose: "tool_execution_gate",
          interactionReason: decision.reason,
          invocationDescriptor: {
            operationKind: input.descriptor.operationKind,
            interaction: input.descriptor.interaction,
            approvalLabel: input.descriptor.approvalLabel,
            sourceId: input.source.id,
            sourceName: input.source.name,
          },
        },
        elicitation: {
          mode: "form",
          message: approvalMessageForInvocation(input.descriptor),
          requestedSchema: approvalSchema,
        },
      })
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
      );

    if (response.action !== "accept") {
      return yield* Effect.fail(
        new Error(
          `Tool invocation not approved for ${input.descriptor.toolPath}`,
        ),
      );
    }
  });

const provideRuntimeLocalWorkspace = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null,
): Effect.Effect<A, E, R> =>
  runtimeLocalWorkspace === null
    ? effect
    : effect.pipe(
        Effect.provideService(
          RuntimeLocalWorkspaceService,
          runtimeLocalWorkspace,
        ),
      );

const createWorkspaceToolCatalog = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  rows: SqlControlPlaneRows;
  executorCatalog: ToolCatalog;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null;
}): ToolCatalog => ({
  listNamespaces: ({ limit }) =>
    provideRuntimeLocalWorkspace(Effect.gen(function* () {
      const [recipeTools, executor] = yield* Effect.all([
        loadWorkspaceRecipeTools({
          rows: input.rows,
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          includeSchemas: false,
        }),
        input.executorCatalog.listNamespaces({ limit }),
      ]);

      const merged = new Map<string, ToolNamespace>();
      for (const tool of recipeTools) {
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
            namespace.toolCount !== undefined ||
            existing?.toolCount === undefined
              ? namespace.toolCount
              : existing.toolCount,
        });
      }

      return [...merged.values()]
        .sort((left, right) => left.namespace.localeCompare(right.namespace))
        .slice(0, limit);
    }), input.runtimeLocalWorkspace),

  listTools: ({ namespace, query, limit, includeSchemas = false }) =>
    provideRuntimeLocalWorkspace(Effect.gen(function* () {
      const [recipeTools, executor] = yield* Effect.all([
        loadWorkspaceRecipeTools({
          rows: input.rows,
          workspaceId: input.workspaceId,
          accountId: input.accountId,
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
              return tokenize(query).every((token) =>
                tool.searchText.includes(token),
              );
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

      return [...recipeTools.map((tool) => tool.descriptor), ...executor]
        .sort((left, right) => left.path.localeCompare(right.path))
        .slice(0, limit);
    }), input.runtimeLocalWorkspace),

  getToolByPath: ({ path, includeSchemas }) =>
    provideRuntimeLocalWorkspace(Effect.gen(function* () {
      const executor = yield* input.executorCatalog.getToolByPath({
        path,
        includeSchemas,
      });
      if (executor) {
        return executor;
      }

      const recipeTool = yield* loadWorkspaceRecipeToolByPath({
        rows: input.rows,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        path,
        includeSchemas,
      });
      return recipeTool?.descriptor ?? null;
    }), input.runtimeLocalWorkspace),

  getSchemaBundle: ({ id }) =>
    provideRuntimeLocalWorkspace(loadWorkspaceSchemaBundle({
      rows: input.rows,
      workspaceId: input.workspaceId,
      id: SourceRecipeSchemaBundleIdSchema.make(id),
    }), input.runtimeLocalWorkspace),

  searchTools: ({ query, namespace, limit }) =>
    provideRuntimeLocalWorkspace(Effect.gen(function* () {
      const queryTokens = tokenize(query);
      const [recipeTools, executor] = yield* Effect.all([
        loadWorkspaceRecipeTools({
          rows: input.rows,
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          includeSchemas: false,
        }).pipe(
          Effect.map((tools) =>
            tools.filter(
              (tool) => !namespace || tool.searchNamespace === namespace,
            ),
          ),
        ),
        input.executorCatalog.searchTools({
          query,
          ...(namespace !== undefined ? { namespace } : {}),
          limit,
        }),
      ]);

      const recipeHits: SearchHit[] = recipeTools
        .map((tool) => ({
          path: asToolPath(tool.path),
          score: scoreRecipeTool(queryTokens, tool),
        }))
        .filter((hit) => hit.score > 0);

      return [...recipeHits, ...executor]
        .sort(
          (left, right) =>
            right.score - left.score || left.path.localeCompare(right.path),
        )
        .slice(0, limit);
    }), input.runtimeLocalWorkspace),
});

const createWorkspaceToolInvoker = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  rows: SqlControlPlaneRows;
  resolveSecretMaterial: ResolveSecretMaterial;
  sourceAuthService: RuntimeSourceAuthService;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null;
  onElicitation?: Parameters<
    typeof makeToolInvokerFromTools
  >[0]["onElicitation"];
}): {
  catalog: ToolCatalog;
  toolInvoker: ToolInvoker;
} => {
  const executorTools = createExecutorToolMap({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    sourceAuthService: input.sourceAuthService,
    runtimeLocalWorkspace: input.runtimeLocalWorkspace,
  });
  const executorCatalog = createToolCatalogFromTools({
    tools: executorTools,
  });
  const catalog = createWorkspaceToolCatalog({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    rows: input.rows,
    executorCatalog,
    runtimeLocalWorkspace: input.runtimeLocalWorkspace,
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
    provideRuntimeLocalWorkspace(Effect.gen(function* () {
      const recipeTool = yield* loadWorkspaceRecipeToolByPath({
        rows: input.rows,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        path: invocation.path,
        includeSchemas: false,
      });
      if (!recipeTool) {
        return yield* Effect.fail(
          new Error(`Unknown tool path: ${invocation.path}`),
        );
      }

      yield* authorizePersistedToolInvocation({
        rows: input.rows,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        descriptor: toInvocationDescriptorFromRecipeTool({ tool: recipeTool }),
        args: invocation.args,
        source: recipeTool.source,
        context: invocation.context,
        onElicitation: input.onElicitation,
      });

      const auth = yield* resolveSourceAuthMaterial({
        rows: input.rows,
        source: recipeTool.source,
        actorAccountId: input.accountId,
        resolveSecretMaterial: input.resolveSecretMaterial,
        context: toSecretResolutionContext(invocation.context),
      });
      const schemaBundle = recipeTool.schemaBundleId
        ? yield* loadWorkspaceSchemaBundle({
            rows: input.rows,
            workspaceId: input.workspaceId,
            id: SourceRecipeSchemaBundleIdSchema.make(recipeTool.schemaBundleId),
          })
        : null;
      const recipe = yield* loadSourceWithRecipe({
        rows: input.rows,
        workspaceId: input.workspaceId,
        sourceId: recipeTool.source.id,
        actorAccountId: input.accountId,
      });

      return yield* getSourceAdapterForOperation(recipeTool.operation)
        .invokePersistedTool({
          rows: input.rows,
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          source: recipeTool.source,
          path: invocation.path,
          operation: recipeTool.operation,
          schemaBundle,
          manifestJson: recipe.revision.manifestJson,
          auth,
          args: invocation.args,
          context: invocation.context,
          onElicitation: input.onElicitation,
        });
    }), input.runtimeLocalWorkspace);

  return {
    catalog,
    toolInvoker: {
      invoke: ({ path, args, context }) =>
        provideRuntimeLocalWorkspace(
          systemToolPaths.has(path)
            ? systemInvoker.invoke({ path, args, context })
            : executorToolPaths.has(path)
              ? executorInvoker.invoke({ path, args, context })
              : invokePersistedTool({ path, args, context }),
          input.runtimeLocalWorkspace,
        ),
    },
  };
};

export const createWorkspaceExecutionEnvironmentResolver = (input: {
  rows: SqlControlPlaneRows;
  resolveSecretMaterial?: ResolveSecretMaterial;
  sourceAuthService: RuntimeSourceAuthService;
}): ResolveExecutionEnvironment => {
  const resolveSecretMaterial =
    input.resolveSecretMaterial ??
    createDefaultSecretMaterialResolver({
      rows: input.rows,
    });

  return ({ workspaceId, accountId, onElicitation }) =>
    Effect.gen(function* () {
      const runtimeLocalWorkspace = yield* getRuntimeLocalWorkspaceOption();
      const { catalog, toolInvoker } = createWorkspaceToolInvoker({
        workspaceId,
        accountId,
        rows: input.rows,
        resolveSecretMaterial,
        sourceAuthService: input.sourceAuthService,
        runtimeLocalWorkspace,
        onElicitation,
      });

      const executor = makeQuickJsExecutor();

      return {
        executor,
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
>() {}

export const RuntimeExecutionResolverLive = (
  input: {
    executionResolver?: ResolveExecutionEnvironment;
    resolveSecretMaterial?: ResolveSecretMaterial;
  } = {},
) =>
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
