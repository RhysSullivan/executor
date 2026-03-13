import {
  type ExecutionStep,
  ExecutionStepSchema,
} from "#schema";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { and, desc, eq } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";
import { firstOption } from "./shared";

const decodeExecutionStep = Schema.decodeUnknownSync(ExecutionStepSchema);

export const createExecutionStepsRepo = (
  client: DrizzleClient,
  tables: DrizzleTables,
) => ({
  getByExecutionAndSequence: (
    executionId: ExecutionStep["executionId"],
    sequence: ExecutionStep["sequence"],
  ) =>
    client.use("rows.execution_steps.get_by_execution_and_sequence", async (db) => {
      const rows = await db
        .select()
        .from(tables.executionStepsTable)
        .where(
          and(
            eq(tables.executionStepsTable.executionId, executionId),
            eq(tables.executionStepsTable.sequence, sequence),
          ),
        )
        .limit(1);

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeExecutionStep(row.value))
        : Option.none<ExecutionStep>();
    }),

  listByExecutionId: (executionId: ExecutionStep["executionId"]) =>
    client.use("rows.execution_steps.list_by_execution_id", async (db) => {
      const rows = await db
        .select()
        .from(tables.executionStepsTable)
        .where(eq(tables.executionStepsTable.executionId, executionId))
        .orderBy(
          tables.executionStepsTable.sequence,
          desc(tables.executionStepsTable.updatedAt),
        );

      return rows.map((row) => decodeExecutionStep(row));
    }),

  insert: (step: ExecutionStep) =>
    client.use("rows.execution_steps.insert", async (db) => {
      await db.insert(tables.executionStepsTable).values(step);
    }),

  deleteByExecutionId: (executionId: ExecutionStep["executionId"]) =>
    client.use("rows.execution_steps.delete_by_execution_id", async (db) => {
      await db
        .delete(tables.executionStepsTable)
        .where(eq(tables.executionStepsTable.executionId, executionId));
    }),

  updateByExecutionAndSequence: (
    executionId: ExecutionStep["executionId"],
    sequence: ExecutionStep["sequence"],
    patch: Partial<Omit<ExecutionStep, "id" | "executionId" | "sequence" | "createdAt">>,
  ) =>
    client.use("rows.execution_steps.update_by_execution_and_sequence", async (db) => {
      const rows = await db
        .update(tables.executionStepsTable)
        .set(patch)
        .where(
          and(
            eq(tables.executionStepsTable.executionId, executionId),
            eq(tables.executionStepsTable.sequence, sequence),
          ),
        )
        .returning();

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeExecutionStep(row.value))
        : Option.none<ExecutionStep>();
    }),
});
