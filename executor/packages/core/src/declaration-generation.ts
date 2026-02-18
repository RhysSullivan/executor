import type { ToolDescriptor } from "./types";

/**
 * Generate the tool inventory text for the MCP execute description.
 * Includes full type signatures so the LLM can write correct code.
 */
export function generateToolInventory(tools: ToolDescriptor[]): string {
  if (!tools || tools.length === 0) return "";

  const namespaceCounts = new Map<string, number>();
  for (const tool of tools) {
    const topLevel = tool.path.split(".")[0] || tool.path;
    namespaceCounts.set(topLevel, (namespaceCounts.get(topLevel) ?? 0) + 1);
  }

  const namespaces = [...namespaceCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name} (${count})`);

  const examples = tools
    .filter((tool) => tool.path !== "discover")
    .slice(0, 8)
    .map((tool) => `  - tools.${tool.path}(...)`);

  const hasGraphqlTools = tools.some((tool) => tool.path.endsWith(".graphql"));

  return [
    "",
    "You have access to these tool namespaces:",
    `  ${namespaces.join(", ")}`,
    "",
    "Prefer one broad lookup over many small ones: use `tools.catalog.namespaces({})` and `tools.catalog.tools({ namespace?, query?, limit: 20 })` first.",
    "Then use `tools.discover({ query, limit?, compact? })` when you need ranking. It returns `{ bestPath, results, total }` (not an array).",
    "Prefer `bestPath` when present; each result includes `{ path, inputHint, outputHint, typing? }` and `typing.inputSchemaJson` / `typing.outputSchemaJson` when available.",
    "For migration/ETL tasks: discover once, then execute in small batches and return compact summaries (counts, IDs, top-N samples).",
    "Never shadow the global `tools` object (do NOT write `const tools = ...`).",
    "Then call tools directly using the returned path.",
    ...(hasGraphqlTools
      ? ["GraphQL tools return `{ data, errors }`; prefer `source.query.*` / `source.mutation.*` helpers over raw `source.graphql` when available."]
      : []),
    ...(examples.length > 0
      ? ["", "Example callable paths:", ...examples]
      : []),
  ].join("\n");
}
