import { Effect } from "effect";
import type {
  Executor,
  ToolId,
  Tool,
  ToolSchema,
  InvokeOptions,
  Source,
} from "@executor/sdk";
import type { SandboxToolInvoker } from "@executor/codemode-core";
import { ExecutionToolError } from "./errors";

/**
 * Extract the source namespace from a tool path. Tool paths look like
 * "<sourceId>.<op>" or "<sourceId>.<group>.<op>" — we take the first
 * segment as a cheap, non-lookup stand-in for the source id so the span
 * attribute is always populated without hitting `executor.sources.list()`
 * per call.
 */
const extractSourceNamespace = (path: string): string => {
  const idx = path.indexOf(".");
  return idx === -1 ? path : path.slice(0, idx);
};

/**
 * Bridges QuickJS `tools.someSource.someOp(args)` calls into
 * `executor.tools.invoke(toolId, args)`.
 *
 * Wrapped in `Effect.fn("mcp.tool.dispatch")` so every tool call becomes a
 * span in the Effect tracer. Attributes:
 *   - `mcp.tool.name`      — full tool path (e.g. "github.repos.get")
 *   - `mcp.tool.source_id` — first segment of the path (namespace)
 *
 * `mcp.tool.kind` (openapi | mcp | graphql | code) is NOT annotated here
 * because it would require a `sources.list()` lookup on every invocation.
 * Callers that already know the source kind can annotate at their own span.
 */
export const makeExecutorToolInvoker = (
  executor: Executor,
  options: { readonly invokeOptions: InvokeOptions },
): SandboxToolInvoker => ({
  invoke: Effect.fn("mcp.tool.dispatch")(function* ({ path, args }) {
    yield* Effect.annotateCurrentSpan({
      "mcp.tool.name": path,
      "mcp.tool.source_id": extractSourceNamespace(path),
    });

    const result = yield* executor.tools.invoke(path as ToolId, args, options.invokeOptions).pipe(
      Effect.catchTag("ElicitationDeclinedError", (err) =>
        Effect.fail(
          new ExecutionToolError({
            message: `Tool "${err.toolId}" requires approval but the request was ${err.action === "cancel" ? "cancelled" : "declined"} by the user.`,
            cause: err,
          }),
        ),
      ),
    );
    const r = result as { readonly error?: unknown; readonly data?: unknown } | unknown;
    if (
      r !== null &&
      typeof r === "object" &&
      "error" in r &&
      (r as { error?: unknown }).error !== null &&
      (r as { error?: unknown }).error !== undefined
    ) {
      return yield* Effect.fail((r as { error: unknown }).error);
    }
    if (r !== null && typeof r === "object" && "data" in r) {
      return (r as { data: unknown }).data;
    }
    return r;
  }),
});

export type ToolDiscoveryResult = {
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly sourceId: string;
  readonly score: number;
};

export type ExecutorSourceListItem = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly runtime?: boolean;
  readonly canRemove?: boolean;
  readonly canRefresh?: boolean;
  readonly toolCount: number;
};

type SearchableTool = Pick<Tool, "id" | "sourceId" | "name" | "description">;

type PreparedField = {
  readonly raw: string;
  readonly tokens: readonly string[];
};

const SEARCH_FIELD_WEIGHTS = {
  path: 12,
  sourceId: 8,
  name: 10,
  description: 5,
} as const;

const normalizeSearchText = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase()
    .trim();

const tokenizeSearchText = (value: string): string[] =>
  normalizeSearchText(value)
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);

const prepareField = (value?: string): PreparedField => ({
  raw: normalizeSearchText(value ?? ""),
  tokens: tokenizeSearchText(value ?? ""),
});

const scorePreparedField = (
  query: string,
  queryTokens: readonly string[],
  field: PreparedField,
  weight: number,
): {
  readonly score: number;
  readonly matchedTokens: ReadonlySet<string>;
  readonly exactPhraseMatch: boolean;
} => {
  if (field.raw.length === 0) {
    return {
      score: 0,
      matchedTokens: new Set<string>(),
      exactPhraseMatch: false,
    };
  }

  let score = 0;
  const matchedTokens = new Set<string>();
  const exactPhraseMatch = query.length > 0 && field.raw.includes(query);

  if (query.length > 0) {
    if (field.raw === query) {
      score += weight * 14;
    } else if (field.raw.startsWith(query)) {
      score += weight * 9;
    } else if (exactPhraseMatch) {
      score += weight * 6;
    }
  }

  for (const token of queryTokens) {
    if (field.tokens.includes(token)) {
      score += weight * 4;
      matchedTokens.add(token);
      continue;
    }

    if (
      field.tokens.some((candidate) => candidate.startsWith(token) || token.startsWith(candidate))
    ) {
      score += weight * 2;
      matchedTokens.add(token);
      continue;
    }

    if (field.raw.includes(token)) {
      score += weight;
      matchedTokens.add(token);
    }
  }

  return {
    score,
    matchedTokens,
    exactPhraseMatch,
  };
};

const matchesNamespace = (tool: SearchableTool, namespace?: string): boolean => {
  if (!namespace || normalizeSearchText(namespace).length === 0) {
    return true;
  }

  const namespaceTokens = tokenizeSearchText(namespace);
  if (namespaceTokens.length === 0) {
    return true;
  }

  const sourceTokens = tokenizeSearchText(tool.sourceId);
  const pathTokens = tokenizeSearchText(tool.id);

  const isPrefixMatch = (tokens: readonly string[]): boolean =>
    namespaceTokens.every((token, index) => tokens[index] === token);

  return isPrefixMatch(sourceTokens) || isPrefixMatch(pathTokens);
};

const scoreToolMatch = (tool: SearchableTool, query: string): ToolDiscoveryResult | null => {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenizeSearchText(query);

  if (normalizedQuery.length === 0 || queryTokens.length === 0) {
    return null;
  }

  const path = prepareField(tool.id);
  const sourceId = prepareField(tool.sourceId);
  const name = prepareField(tool.name);
  const description = prepareField(tool.description);

  const fieldScores = [
    scorePreparedField(normalizedQuery, queryTokens, path, SEARCH_FIELD_WEIGHTS.path),
    scorePreparedField(normalizedQuery, queryTokens, sourceId, SEARCH_FIELD_WEIGHTS.sourceId),
    scorePreparedField(normalizedQuery, queryTokens, name, SEARCH_FIELD_WEIGHTS.name),
    scorePreparedField(normalizedQuery, queryTokens, description, SEARCH_FIELD_WEIGHTS.description),
  ];

  const matchedTokens = new Set<string>();
  let score = 0;
  let exactPhraseMatch = false;

  for (const fieldScore of fieldScores) {
    score += fieldScore.score;
    exactPhraseMatch ||= fieldScore.exactPhraseMatch;
    for (const token of fieldScore.matchedTokens) {
      matchedTokens.add(token);
    }
  }

  if (matchedTokens.size === 0) {
    return null;
  }

  const coverage = matchedTokens.size / queryTokens.length;
  const minimumCoverage = queryTokens.length <= 2 ? 1 : 0.6;

  if (coverage < minimumCoverage && !exactPhraseMatch) {
    return null;
  }

  if (coverage === 1) {
    score += 25;
  } else {
    score += Math.round(coverage * 10);
  }

  if (path.tokens[0] === queryTokens[0] || name.tokens[0] === queryTokens[0]) {
    score += 8;
  }

  if (
    normalizeSearchText(tool.id) === normalizedQuery ||
    normalizeSearchText(tool.name) === normalizedQuery
  ) {
    score += 20;
  }

  return {
    path: tool.id,
    name: tool.name,
    description: tool.description,
    sourceId: tool.sourceId,
    score,
  };
};

/** What `tools.search()` calls inside the sandbox. */
export const searchTools = Effect.fn("executor.tools.search")(function* (
  executor: Executor,
  query: string,
  limit = 12,
  options?: { readonly namespace?: string },
) {
  yield* Effect.annotateCurrentSpan({
    "executor.search.query_length": query.length,
    "executor.search.limit": limit,
    ...(options?.namespace ? { "executor.search.namespace": options.namespace } : {}),
  });

  if (normalizeSearchText(query).length === 0) {
    return [] as ReadonlyArray<ToolDiscoveryResult>;
  }

  const all = yield* executor.tools.list({ includeAnnotations: false }).pipe(Effect.orDie);
  const results = all
    .filter((tool: Tool) => matchesNamespace(tool, options?.namespace))
    .map((tool: Tool) => scoreToolMatch(tool, query))
    .filter((tool): tool is ToolDiscoveryResult => tool !== null)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit);

  yield* Effect.annotateCurrentSpan({
    "executor.search.candidate_count": all.length,
    "executor.search.result_count": results.length,
  });
  return results;
});

/** What `tools.executor.sources.list()` calls inside the sandbox. */
export const listExecutorSources = Effect.fn("executor.sources.list")(function* (
  executor: Executor,
  options?: { readonly query?: string; readonly limit?: number },
) {
  const normalizedQuery = normalizeSearchText(options?.query ?? "");
  const limit = options?.limit ?? 200;
  const sources = yield* executor.sources.list().pipe(Effect.orDie);

  const filtered =
    normalizedQuery.length === 0
      ? sources
      : sources.filter((source: Source) => {
          const haystack = normalizeSearchText([source.id, source.name, source.kind].join(" "));
          return tokenizeSearchText(normalizedQuery).every((token) => haystack.includes(token));
        });

  // Single query for all tools, then count per source in memory.
  const allTools = yield* executor.tools.list({ includeAnnotations: false }).pipe(Effect.orDie);
  const toolCountBySource = new Map<string, number>();
  for (const tool of allTools) {
    toolCountBySource.set(tool.sourceId, (toolCountBySource.get(tool.sourceId) ?? 0) + 1);
  }

  const withCounts = filtered.map(
    (source: Source) =>
      ({
        id: source.id,
        name: source.name,
        kind: source.kind,
        runtime: source.runtime,
        canRemove: source.canRemove,
        canRefresh: source.canRefresh,
        toolCount: toolCountBySource.get(source.id) ?? 0,
      }) satisfies ExecutorSourceListItem,
  );

  const results = withCounts
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .slice(0, limit);

  yield* Effect.annotateCurrentSpan({
    "executor.sources.candidate_count": sources.length,
    "executor.sources.result_count": results.length,
  });
  return results;
});

/** What `tools.describe.tool()` calls inside the sandbox. */
export const describeTool = Effect.fn("executor.tools.describe")(function* (
  executor: Executor,
  path: string,
) {
  yield* Effect.annotateCurrentSpan({ "mcp.tool.name": path });

  // Single tools.schema() call — it already fetches the tool row
  // internally. No need to also call tools.list() just for name/description.
  const schema: ToolSchema | null = yield* executor.tools.schema(path);

  // tools.schema() returns null if the tool doesn't exist. Fall back to
  // a minimal stub so callers can still render something.
  if (schema === null) {
    return { path, name: path };
  }

  // The schema's id is the tool path; name/description come from the
  // tool row which tools.schema() already loaded.
  return {
    path,
    name: schema.name ?? path,
    description: schema.description,
    inputTypeScript: schema.inputTypeScript,
    outputTypeScript: schema.outputTypeScript,
    typeScriptDefinitions: schema.typeScriptDefinitions,
  };
});
