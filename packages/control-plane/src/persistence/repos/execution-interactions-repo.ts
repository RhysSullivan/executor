import {
  type ExecutionInteraction,
  ExecutionInteractionSchema,
} from "#schema";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { and, desc, eq } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";
import { firstOption } from "./shared";

const decodeExecutionInteraction = Schema.decodeUnknownSync(
  ExecutionInteractionSchema,
);

export const createExecutionInteractionsRepo = (
  client: DrizzleClient,
  tables: DrizzleTables,
) => ({
  listByExecutionId: (executionId: ExecutionInteraction["executionId"]) =>
    client.use("rows.execution_interactions.list_by_execution_id", async (db) => {
      const rows = await db
        .select()
        .from(tables.executionInteractionsTable)
        .where(eq(tables.executionInteractionsTable.executionId, executionId))
        .orderBy(
          desc(tables.executionInteractionsTable.updatedAt),
          desc(tables.executionInteractionsTable.id),
        );

      return rows.map((row) => decodeExecutionInteraction(row));
    }),

  getPendingByExecutionId: (executionId: ExecutionInteraction["executionId"]) =>
    client.use(
      "rows.execution_interactions.get_pending_by_execution_id",
      async (db) => {
        const rows = await db
          .select()
          .from(tables.executionInteractionsTable)
          .where(
            and(
              eq(tables.executionInteractionsTable.executionId, executionId),
              eq(tables.executionInteractionsTable.status, "pending"),
            ),
          )
          .orderBy(
            desc(tables.executionInteractionsTable.updatedAt),
            desc(tables.executionInteractionsTable.id),
          )
          .limit(1);

        const row = firstOption(rows);
        return Option.isSome(row)
          ? Option.some(decodeExecutionInteraction(row.value))
          : Option.none<ExecutionInteraction>();
      },
    ),

  insert: (interaction: ExecutionInteraction) =>
    client.use("rows.execution_interactions.insert", async (db) => {
      await db.insert(tables.executionInteractionsTable).values(interaction);
    }),

  update: (
    interactionId: ExecutionInteraction["id"],
    patch: Partial<Omit<ExecutionInteraction, "id" | "executionId" | "createdAt">>,
  ) =>
    client.use("rows.execution_interactions.update", async (db) => {
      const rows = await db
        .update(tables.executionInteractionsTable)
        .set(patch)
        .where(eq(tables.executionInteractionsTable.id, interactionId))
        .returning();

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeExecutionInteraction(row.value))
        : Option.none<ExecutionInteraction>();
    }),
});
