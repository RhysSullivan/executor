import type { JsonSchema, ToolDefinition } from "../types";

export interface DiscoverIndexEntry {
  path: string;
  preferredPath: string;
  aliases: string[];
  description: string;
  approval: ToolDefinition["approval"];
  source: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  requiredInputKeys: string[];
  previewInputKeys: string[];
  displayInputHint: string;
  displayOutputHint: string;
  searchText: string;
  normalizedPath: string;
  normalizedSearchText: string;
}

export interface RankedIndexEntry {
  entry: DiscoverIndexEntry;
  score: number;
}
