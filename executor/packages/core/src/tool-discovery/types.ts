import type { ToolDefinition } from "../types";

export interface DiscoverIndexEntry {
  path: string;
  preferredPath: string;
  aliases: string[];
  description: string;
  approval: ToolDefinition["approval"];
  source: string;
  argsType: string;
  returnsType: string;
  displayArgsType: string;
  displayReturnsType: string;
  expandedArgsShape: string;
  expandedReturnsShape: string;
  argPreviewKeys: string[];
  searchText: string;
  normalizedPath: string;
  normalizedSearchText: string;
}

export interface RankedIndexEntry {
  entry: DiscoverIndexEntry;
  score: number;
}
