import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, ilike, inArray, lt, lte, or } from "drizzle-orm";

import {
  Execution,
  ExecutionId,
  ExecutionInteraction,
  ExecutionInteractionId,
  buildExecutionListMeta,
  type CreateExecutionInput,
  type CreateExecutionInteractionInput,
  type ExecutionListItem,
  type ExecutionListOptions,
  type UpdateExecutionInput,
  type UpdateExecutionInteractionInput,
  ScopeId,
} from "@executor/sdk";
import type { DrizzleDb } from "./types";
import { executionInteractions, executions } from "./schema";

const encodeCursor = (execution: Execution): string =>
  encodeURIComponent(JSON.stringify({ createdAt: execution.createdAt, id: execution.id }));

const decodeCursor = (
  cursor: string,
): {
  readonly createdAt: number;
  readonly id: ExecutionId;
} | null => {
  try {
    const parsed = JSON.parse(decodeURIComponent(cursor)) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== "number" || typeof parsed.id !== "string") {
      return null;
    }
    return { createdAt: parsed.createdAt, id: ExecutionId.make(parsed.id) };
  } catch {
    return null;
  }
};

const toExecution = (row: typeof executions.$inferSelect): Execution =>
  new Execution({
    id: ExecutionId.make(row.id),
    scopeId: ScopeId.make(row.scopeId),
    status: row.status as Execution["status"],
    code: row.code,
    resultJson: row.resultJson,
    errorText: row.errorText,
    logsJson: row.logsJson,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const toInteraction = (row: typeof executionInteractions.$inferSelect): ExecutionInteraction =>
  new ExecutionInteraction({
    id: ExecutionInteractionId.make(row.id),
    executionId: ExecutionId.make(row.executionId),
    status: row.status as ExecutionInteraction["status"],
    kind: row.kind,
    purpose: row.purpose,
    payloadJson: row.payloadJson,
    responseJson: row.responseJson,
    responsePrivateJson: row.responsePrivateJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

export const makePgExecutionStore = (db: DrizzleDb, organizationId: string) => {
  return {
    create: (input: CreateExecutionInput) =>
      Effect.tryPromise(async () => {
        const id = ExecutionId.make(`exec_${randomUUID()}`);
        await db.insert(executions).values({
          id,
          scopeId: input.scopeId,
          organizationId,
          status: input.status,
          code: input.code,
          resultJson: input.resultJson,
          errorText: input.errorText,
          logsJson: input.logsJson,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        });
        return new Execution({ id, ...input });
      }).pipe(Effect.orDie),

    update: (id: ExecutionId, patch: UpdateExecutionInput) =>
      Effect.tryPromise(async () => {
        const currentRows = await db
          .select()
          .from(executions)
          .where(and(eq(executions.id, id), eq(executions.organizationId, organizationId)));
        const current = currentRows[0];
        if (!current) {
          throw new Error(`Execution not found: ${id}`);
        }

        const next = new Execution({
          ...toExecution(current),
          ...patch,
          id,
          scopeId: ScopeId.make(current.scopeId),
        });

        await db
          .update(executions)
          .set({
            status: next.status,
            code: next.code,
            resultJson: next.resultJson,
            errorText: next.errorText,
            logsJson: next.logsJson,
            startedAt: next.startedAt,
            completedAt: next.completedAt,
            updatedAt: next.updatedAt,
          })
          .where(and(eq(executions.id, id), eq(executions.organizationId, organizationId)));

        return next;
      }).pipe(Effect.orDie),

    list: (scopeId: ScopeId, options: ExecutionListOptions) =>
      Effect.tryPromise(async () => {
        const limit = Math.max(1, options.limit);
        const scopeConditions = [
          eq(executions.organizationId, organizationId),
          eq(executions.scopeId, scopeId),
        ];

        const filterConditions = [...scopeConditions];
        if (options.statusFilter && options.statusFilter.length > 0) {
          filterConditions.push(inArray(executions.status, [...options.statusFilter]));
        }
        if (options.timeRange?.from !== undefined) {
          filterConditions.push(gte(executions.createdAt, options.timeRange.from));
        }
        if (options.timeRange?.to !== undefined) {
          filterConditions.push(lte(executions.createdAt, options.timeRange.to));
        }
        if (options.codeQuery && options.codeQuery.trim().length > 0) {
          filterConditions.push(ilike(executions.code, `%${options.codeQuery.trim()}%`));
        }

        const conditions = [...filterConditions];
        const cursor = options.cursor ? decodeCursor(options.cursor) : null;
        if (cursor) {
          conditions.push(
            or(
              lt(executions.createdAt, cursor.createdAt),
              and(eq(executions.createdAt, cursor.createdAt), lt(executions.id, cursor.id)),
            )!,
          );
        }

        const rows = await db
          .select()
          .from(executions)
          .where(and(...conditions))
          .orderBy(desc(executions.createdAt), desc(executions.id))
          .limit(limit + 1);

        const pageRows = rows.slice(0, limit);
        const executionRows = pageRows.map(toExecution);
        const executionIds = executionRows.map((execution) => execution.id);
        const pendingRows =
          executionIds.length === 0
            ? []
            : await db
                .select()
                .from(executionInteractions)
                .where(
                  and(
                    eq(executionInteractions.organizationId, organizationId),
                    eq(executionInteractions.status, "pending"),
                    inArray(executionInteractions.executionId, executionIds),
                  ),
                )
                .orderBy(desc(executionInteractions.createdAt), desc(executionInteractions.id));

        const pendingByExecution = new Map<ExecutionId, ExecutionInteraction>();
        for (const row of pendingRows) {
          const interaction = toInteraction(row);
          if (!pendingByExecution.has(interaction.executionId)) {
            pendingByExecution.set(interaction.executionId, interaction);
          }
        }

        const items: ExecutionListItem[] = executionRows.map((execution) => ({
          ...execution,
          pendingInteraction: pendingByExecution.get(execution.id) ?? null,
        }));

        const hasMore = rows.length > limit;
        const last = executionRows.at(-1);

        let meta;
        if (options.includeMeta) {
          // Meta summarizes the full filtered set, independent of pagination.
          // Two queries: filtered rows for bucketing, and an unfiltered
          // scope count for totalRowCount.
          const [filteredForMeta, scopeTotals] = await Promise.all([
            db
              .select()
              .from(executions)
              .where(and(...filterConditions))
              .orderBy(desc(executions.createdAt), desc(executions.id)),
            db
              .select({ id: executions.id })
              .from(executions)
              .where(and(...scopeConditions)),
          ]);

          meta = buildExecutionListMeta(
            filteredForMeta.map(toExecution),
            options.timeRange,
            scopeTotals.length,
          );
        }

        return {
          executions: items,
          nextCursor: hasMore && last ? encodeCursor(last) : undefined,
          meta,
        };
      }).pipe(Effect.orDie),

    get: (id: ExecutionId) =>
      Effect.tryPromise(async () => {
        const executionRows = await db
          .select()
          .from(executions)
          .where(and(eq(executions.id, id), eq(executions.organizationId, organizationId)));
        const row = executionRows[0];
        if (!row) {
          return null;
        }

        const pendingRows = await db
          .select()
          .from(executionInteractions)
          .where(
            and(
              eq(executionInteractions.executionId, id),
              eq(executionInteractions.organizationId, organizationId),
              eq(executionInteractions.status, "pending"),
            ),
          )
          .orderBy(desc(executionInteractions.createdAt), desc(executionInteractions.id))
          .limit(1);

        return {
          execution: toExecution(row),
          pendingInteraction: pendingRows[0] ? toInteraction(pendingRows[0]) : null,
        };
      }).pipe(Effect.orDie),

    recordInteraction: (_executionId: ExecutionId, interaction: CreateExecutionInteractionInput) =>
      Effect.tryPromise(async () => {
        const id = ExecutionInteractionId.make(`interaction_${randomUUID()}`);
        await db.insert(executionInteractions).values({
          id,
          executionId: interaction.executionId,
          organizationId,
          status: interaction.status,
          kind: interaction.kind,
          purpose: interaction.purpose,
          payloadJson: interaction.payloadJson,
          responseJson: interaction.responseJson,
          responsePrivateJson: interaction.responsePrivateJson,
          createdAt: interaction.createdAt,
          updatedAt: interaction.updatedAt,
        });
        return new ExecutionInteraction({ id, ...interaction });
      }).pipe(Effect.orDie),

    resolveInteraction: (interactionId: ExecutionInteractionId, patch: UpdateExecutionInteractionInput) =>
      Effect.tryPromise(async () => {
        const currentRows = await db
          .select()
          .from(executionInteractions)
          .where(
            and(
              eq(executionInteractions.id, interactionId),
              eq(executionInteractions.organizationId, organizationId),
            ),
          );
        const current = currentRows[0];
        if (!current) {
          throw new Error(`Execution interaction not found: ${interactionId}`);
        }

        const next = new ExecutionInteraction({
          ...toInteraction(current),
          ...patch,
          id: interactionId,
          executionId: ExecutionId.make(current.executionId),
        });

        await db
          .update(executionInteractions)
          .set({
            status: next.status,
            kind: next.kind,
            purpose: next.purpose,
            payloadJson: next.payloadJson,
            responseJson: next.responseJson,
            responsePrivateJson: next.responsePrivateJson,
            updatedAt: next.updatedAt,
          })
          .where(
            and(
              eq(executionInteractions.id, interactionId),
              eq(executionInteractions.organizationId, organizationId),
            ),
          );

        return next;
      }).pipe(Effect.orDie),

    sweep: () =>
      Effect.tryPromise(async () => {
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const expiredExecutions = await db
          .select({ id: executions.id })
          .from(executions)
          .where(and(eq(executions.organizationId, organizationId), lt(executions.createdAt, cutoff)));
        const expiredIds = expiredExecutions.map((row) => row.id);

        if (expiredIds.length > 0) {
          await db
            .delete(executionInteractions)
            .where(
              and(
                eq(executionInteractions.organizationId, organizationId),
                inArray(executionInteractions.executionId, expiredIds),
              ),
            );
        }

        await db
          .delete(executions)
          .where(and(eq(executions.organizationId, organizationId), lt(executions.createdAt, cutoff)));
      }).pipe(Effect.orDie),
  };
};
