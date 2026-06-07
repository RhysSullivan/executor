import { Effect } from "effect";
import type { Executor, Integration } from "@executor-js/sdk/core";

/**
 * Builds a tool description dynamically.
 *
 * Structure:
 *   1. Workflow (top — critical, least likely to be truncated)
 *   2. Available namespaces (bottom)
 *
 * v2: namespaces are the integration catalog. A tool's sandbox address is
 * `tools.<integration>.<owner>.<connection>.<tool>`, so the integration slug
 * is the first callable segment the model needs to know about.
 */
export const buildExecuteDescription = (executor: Executor): Effect.Effect<string> =>
  Effect.gen(function* () {
    const integrations: readonly Integration[] = yield* executor.integrations.list().pipe(
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: ExecutionEngine.getDescription currently exposes no error channel; engine typed-error widening is covered separately
      Effect.orDie,
      Effect.withSpan("executor.integrations.list"),
    );

    const description = yield* Effect.sync(() => formatDescription(integrations)).pipe(
      Effect.withSpan("schema.compile.description", {
        attributes: { "executor.integration_count": integrations.length },
      }),
    );

    yield* Effect.annotateCurrentSpan({
      "executor.integration_count": integrations.length,
      "schema.kind": "execute",
      // Integration inventory so a failing session build (which runs this
      // during init) names *what* it was resolving: empty/OpenAPI-only
      // catalogs build cleanly, catalogs with remote MCP integrations are the
      // ones that fail.
      "executor.integration_slugs": integrations
        .map((integration) => String(integration.slug))
        .slice(0, 50)
        .join(","),
      "executor.integration_kinds": [
        ...new Set(integrations.map((integration) => integration.kind)),
      ].join(","),
    });

    return description;
  }).pipe(Effect.withSpan("schema.describe.execute"));

const formatDescription = (integrations: readonly Integration[]): string => {
  const lines: string[] = [
    "Execute TypeScript in a sandboxed runtime with access to configured API tools.",
    "",
    "## Workflow",
    "",
    '1. `const { items: matches } = await tools.search({ query: "<intent + key nouns>", limit: 12 });`',
    '2. `const path = matches[0]?.path; if (!path) return "No matching tools found.";`',
    "3. `const details = await tools.describe.tool({ path });`",
    "4. Use `details.inputTypeScript` / `details.outputTypeScript` and `details.typeScriptDefinitions` for compact shapes.",
    "5. Use `tools.executor.sources.list()` when you need configured integration inventory.",
    "6. Call the tool: `const result = await tools.<path>(input);`",
    "",
    "## Rules",
    "",
    "- `tools.search()` returns paginated, ranked matches: `{ items, total, hasMore, nextOffset }`. Best-first. Use short intent phrases like `github issues`, `repo details`, or `create calendar event`.",
    '- When you already know the namespace, narrow with `tools.search({ namespace: "github", query: "issues" })`.',
    "- `tools.executor.sources.list()` returns the same paged shape: `{ items: [{ id, toolCount, ... }], total, hasMore, nextOffset }`.",
    "- Tool calls return a value union: `{ ok: true, data }` for success or `{ ok: false, error: { code, message, status?, details?, retryable? } }` for expected tool/domain failures. Branch on `result.ok`.",
    "- If `hasMore` is true and you didn't find what you need, fetch the next page: `tools.search({ query, offset: nextOffset, limit })`. Same `offset` parameter on `tools.executor.sources.list({ offset, limit })`.",
    "- Always use the full address when calling tools: `tools.<integration>.<owner>.<connection>.<tool>(args)`. The `path` returned by `tools.search()` / `tools.describe.tool()` is already this exact address — call `tools[path]` rather than guessing segments.",
    "- The `tools` object is a lazy proxy — `Object.keys(tools)` won't work. Use `tools.search()` or `tools.executor.sources.list()` instead.",
    '- Pass an object to system tools, e.g. `tools.search({ query: "..." })`, `tools.executor.sources.list()`, and `tools.describe.tool({ path })`.',
    "- `tools.describe.tool()` returns compact TypeScript shapes. Use `inputTypeScript`, `outputTypeScript`, and `typeScriptDefinitions`.",
    "- For tools that return large collections (e.g. `getStates`, `getAll`), filter results in code rather than calling per-item tools.",
    "- Do not use `fetch` — all API calls go through `tools.*`.",
    "- If execution pauses for interaction, resume it with the returned `resumePayload`.",
    "- TypeScript type syntax (`: T`, `as T`, generics, interfaces, type aliases) is stripped before execution — feel free to write idiomatic TypeScript using the shapes from `tools.describe.tool()`. Decorators and `enum` are not supported.",
  ];

  if (integrations.length > 0) {
    lines.push("");
    lines.push("## Available namespaces");
    lines.push("");
    const sorted = [...integrations]
      .sort((a, b) => String(a.slug).localeCompare(String(b.slug)))
      .slice(0, 50);
    for (const integration of sorted) {
      lines.push(`- \`${integration.slug}\``);
    }
    if (integrations.length > sorted.length) {
      lines.push(`- ... ${integrations.length - sorted.length} more`);
    }
  }

  return lines.join("\n");
};
