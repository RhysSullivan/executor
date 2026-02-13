import { Result } from "better-result";
import { generateToolInventory } from "./typechecker";
import type { TaskRecord, ToolDescriptor } from "./types";

function asCodeBlock(language: string, value: string): string {
  return `\n\n\`\`\`${language}\n${value}\n\`\`\``;
}

function listTopLevelToolKeys(tools: ToolDescriptor[]): string[] {
  const keys = new Set<string>();
  for (const tool of tools) {
    const first = tool.path.split(".")[0];
    if (first) keys.add(first);
  }
  return [...keys].sort();
}

export function summarizeTask(task: TaskRecord, result: unknown = task.result): string {
  const maxResultPreviewChars = 30_000;
  const lines = [
    `taskId: ${task.id}`,
    `status: ${task.status}`,
    `runtimeId: ${task.runtimeId}`,
  ];

  if (task.exitCode !== undefined) {
    lines.push(`exitCode: ${task.exitCode}`);
  }

  if (task.error) {
    lines.push(`error: ${task.error}`);
  }

  let text = lines.join("\n");
  if (result !== undefined) {
    const serialized = Result.try(() => JSON.stringify(result, null, 2)).unwrapOr(String(result));
    if (serialized.length > maxResultPreviewChars) {
      text += asCodeBlock(
        "json",
        `${serialized.slice(0, maxResultPreviewChars)}\n... [result preview truncated ${serialized.length - maxResultPreviewChars} chars]`,
      );
    } else {
      text += asCodeBlock("json", serialized);
    }
  }
  return text;
}

export function buildRunCodeDescription(tools?: ToolDescriptor[]): string {
  const base =
    "Execute TypeScript code in a sandboxed runtime. The code has access to a `tools` object with typed methods for calling external services. Use `return` to return a value. Waits for completion and returns only explicit return values (console output is not returned). Runtime has no filesystem/process/import access; use `tools.*` for external calls.";
  const toolList = tools ?? [];
  const topLevelKeys = listTopLevelToolKeys(toolList);
  const rootKeysNote = topLevelKeys.length > 0
    ? `\n\nTop-level tool keys: ${topLevelKeys.join(", ")}`
    : "";
  const hasGraphqlTools = toolList.some((tool) => tool.path.endsWith(".graphql"));
  const discoverNote = "\n\nTooling tip: avoid repeated tiny discovery calls. Start with a single broad inventory pass via `tools.catalog.namespaces({})` and `tools.catalog.tools({ namespace?, query?, compact: true, depth: 1, limit: 20 })`, then do at most one focused `tools.discover({ query, compact: true, depth: 1, limit: 12 })`. If you still need full signatures for a final pick, rerun only that shortlist with `compact: false`. `discover` returns `{ bestPath, results, total }`; prefer `bestPath` when present, otherwise copy `results[i].exampleCall`. Do not assign to `const tools = ...`; use a different variable name (e.g. `const discovered = ...`).";
  const executionNote = "\n\nExecution tip: for migration/ETL-style tasks, discover once, then run in small batches and `return` compact summaries (counts, IDs, and top-N samples) instead of full objects.";
  const graphqlNote = hasGraphqlTools
    ? "\n\nGraphQL tip: prefer `source.query.*` / `source.mutation.*` helper paths when available; GraphQL tools return `{ data, errors }`."
    : "";

  return base + rootKeysNote + discoverNote + executionNote + graphqlNote + generateToolInventory(toolList);
}
