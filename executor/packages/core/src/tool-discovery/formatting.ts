import {
  compactArgDisplayHint,
  compactReturnTypeHint,
  extractTopLevelTypeKeys,
} from "../type-hints";
import type { DiscoverIndexEntry } from "./types";

export function buildExampleCall(entry: DiscoverIndexEntry): string {
  const callPath = entry.preferredPath;
  if (entry.path.endsWith(".graphql")) {
    return `await tools.${callPath}({ query: "query { __typename }", variables: {} });`;
  }

  if (entry.argsType === "{}") {
    return `await tools.${callPath}({});`;
  }

  const keys = entry.argPreviewKeys.length > 0 ? entry.argPreviewKeys : extractTopLevelTypeKeys(entry.argsType);
  if (keys.length > 0) {
    const argsSnippet = keys
      .slice(0, 5)
      .map((key) => `${key}: ${key.toLowerCase().includes("input") ? "{ /* ... */ }" : "..."}`)
      .join(", ");

    return `await tools.${callPath}({ ${argsSnippet} });`;
  }

  return `await tools.${callPath}({ /* ... */ });`;
}

export function formatSignature(entry: DiscoverIndexEntry, depth: number, compact: boolean): string {
  if (compact) {
    if (depth <= 0) {
      return "(input: ...): Promise<...>";
    }

    const args = compactArgDisplayHint(entry.argsType, entry.argPreviewKeys);
    const returns = compactReturnTypeHint(entry.returnsType);

    if (depth === 1) {
      return `(input: ${args}): Promise<${returns}>`;
    }

    return `(input: ${args}): Promise<${returns}> [source=${entry.source}]`;
  }

  if (depth <= 0) {
    return `(input: ${entry.argsType}): Promise<...>`;
  }

  if (depth === 1) {
    return `(input: ${entry.argsType}): Promise<${entry.returnsType}>`;
  }

  return `(input: ${entry.argsType}): Promise<${entry.returnsType}> [source=${entry.source}]`;
}
