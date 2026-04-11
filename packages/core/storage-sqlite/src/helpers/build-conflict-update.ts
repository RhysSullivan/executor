import { getTableColumns, sql, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

export const buildConflictUpdateAllColumns = <
  T extends SQLiteTable,
  Q extends keyof T["_"]["columns"],
>(
  table: T,
  excluded: readonly Q[],
): Record<Exclude<keyof T["_"]["columns"], Q>, SQL> => {
  const columns = getTableColumns(table);
  const excludedSet = new Set(excluded as readonly string[]);
  return Object.fromEntries(
    Object.entries(columns)
      .filter(([name]) => !excludedSet.has(name))
      .map(([name, column]) => [name, sql.raw(`excluded."${column.name}"`)]),
  ) as Record<Exclude<keyof T["_"]["columns"], Q>, SQL>;
};
