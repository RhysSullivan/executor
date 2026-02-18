import { parseAsString } from "nuqs";
import { asTrimmedString } from "@/lib/url-state/shared";

export const taskQueryParsers = {
  selected: parseAsString,
};

export type TasksSearch = {
  selected?: string;
};

export function normalizeTasksSearch(search: Record<string, unknown>): TasksSearch {
  const selected = asTrimmedString(search.selected);

  return {
    ...(selected ? { selected } : {}),
  };
}
