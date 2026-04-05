import { Effect } from "effect";
import type { Executor, ToolMetadata, Source } from "@executor/sdk";

/**
 * Builds a tool description dynamically.
 *
 * Structure:
 *   1. Workflow (top — critical, least likely to be truncated)
 *   2. Available namespaces (bottom)
 */
export const buildExecuteDescription = (
  executor: Executor,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const sources: readonly Source[] = yield* executor.sources.list();
    const tools: readonly ToolMetadata[] = yield* executor.tools.list();

    const namespaces = new Set<string>();
    for (const tool of tools) namespaces.add(tool.sourceId);

    return formatDescription([...namespaces], sources);
  });

const formatDescription = (
  namespaces: readonly string[],
  sources: readonly Source[],
): string => {
  const lines: string[] = [
    "Execute TypeScript in a sandboxed runtime with access to configured API tools.",
    "",
    "## Workflow",
    "",
    '1. `const matches = await tools.discover({ query: "<intent + key nouns>", limit: 12 });`',
    '2. `const path = matches[0]?.path; if (!path) return "No matching tools found.";`',
    "3. `const details = await tools.describe.tool({ path });`",
    "4. Use `details.inputTypeScript` / `details.outputTypeScript` and `details.typeScriptDefinitions` for compact shapes.",
    "5. Call the tool: `const result = await tools.<path>(input);`",
    "",
    "## Rules",
    "",
    "- `tools.discover()` returns ranked matches, best-first. Use short intent phrases like `github issues`, `repo details`, or `create calendar event`.",
    "- When you already know the namespace, narrow with `tools.discover({ namespace: \"github\", query: \"issues\" })`.",
    "- The `tools` object is a lazy proxy — `Object.keys(tools)` won't work. Use `tools.discover()` to find tools.",
    "- Pass an object to system tools, e.g. `tools.discover({ query: \"...\" })` or `tools.discover({ namespace: \"github\", query: \"issues\" })`, and `tools.describe.tool({ path })`.",
    "- `tools.describe.tool()` returns compact TypeScript shapes only; JSON Schema is internal and not exposed here.",
    "- Do not use `fetch` — all API calls go through `tools.*`.",
    "- If execution pauses for interaction, resume it with the returned `resumePayload`.",
  ];

  if (namespaces.length > 0) {
    lines.push("");
    lines.push("## Available namespaces");
    lines.push("");
    const sorted = [...namespaces].sort();
    for (const ns of sorted) {
      const source = sources.find((s) => s.id === ns);
      const label = source?.name ?? ns;
      lines.push(`- \`${ns}\`${label !== ns ? ` — ${label}` : ""}`);
    }
  }

  return lines.join("\n");
};
