import { createAuthRowOperations } from "./row-operations-auth";
import { createCoreRowOperations } from "./row-operations-core";
import {
  type DrizzleDb,
  type DrizzleTables,
  type SqlAdapter,
} from "./sql-internals";

type WriteLocked = <A>(run: () => Promise<A>) => Promise<A>;

type CreateRowOperationsInput = {
  adapter: SqlAdapter;
  db: DrizzleDb;
  tables: DrizzleTables;
  writeLocked: WriteLocked;
};

export const createRowOperations = (input: CreateRowOperationsInput) => ({
  ...createCoreRowOperations(input),
  ...createAuthRowOperations(input),
});
