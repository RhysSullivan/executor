import { type Execution, ExecutionSchema } from "#schema";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { and, eq } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";
import { firstOption } from "./shared";

const decodeExecution = Schema.decodeUnknownSync(ExecutionSchema);

export const createExecutionsRepo = (
  client: DrizzleClient,
  tables: DrizzleTables,
) => ({
  getById: (executionId: Execution["id"]) =>
    client.use("rows.executions.get_by_id", async (db) => {
      const rows = await db
        .select()
        .from(tables.executionsTable)
        .where(eq(tables.executionsTable.id, executionId))
        .limit(1);

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeExecution(row.value))
        : Option.none<Execution>();
    }),

  getByWorkspaceAndId: (
    workspaceId: Execution["workspaceId"],
    executionId: Execution["id"],
  ) =>
    client.use("rows.executions.get_by_workspace_and_id", async (db) => {
      const rows = await db
        .select()
        .from(tables.executionsTable)
        .where(
          and(
            eq(tables.executionsTable.workspaceId, workspaceId),
            eq(tables.executionsTable.id, executionId),
          ),
        )
        .limit(1);

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeExecution(row.value))
        : Option.none<Execution>();
    }),

  insert: (execution: Execution) =>
    client.use("rows.executions.insert", async (db) => {
      await db.insert(tables.executionsTable).values(execution);
    }),

  update: (
    executionId: Execution["id"],
    patch: Partial<
      Omit<Execution, "id" | "workspaceId" | "createdByAccountId" | "createdAt">
    >,
  ) =>
    client.use("rows.executions.update", async (db) => {
      const rows = await db
        .update(tables.executionsTable)
        .set(patch)
        .where(eq(tables.executionsTable.id, executionId))
        .returning();

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeExecution(row.value))
        : Option.none<Execution>();
    }),
});
