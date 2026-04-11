import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  like,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import {
  Execution,
  ExecutionId,
  ExecutionInteraction,
  ExecutionInteractionId,
  ExecutionToolCall,
  ExecutionToolCallId,
  buildExecutionListMeta,
  type CreateExecutionInput,
  type CreateExecutionInteractionInput,
  type CreateExecutionToolCallInput,
  type ExecutionListItem,
  type ExecutionListOptions,
  type UpdateExecutionInput,
  type UpdateExecutionInteractionInput,
  type UpdateExecutionToolCallInput,
  type ExecutionToolCallStatus,
  ScopeId,
} from "@executor/sdk";
import type { DrizzleDb } from "./types";
import { executionInteractions, executionToolCalls, executions } from "./schema";

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
    triggerKind: row.triggerKind,
    triggerMetaJson: row.triggerMetaJson,
    toolCallCount: row.toolCallCount,
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

const toToolCall = (row: typeof executionToolCalls.$inferSelect): ExecutionToolCall =>
  new ExecutionToolCall({
    id: ExecutionToolCallId.make(row.id),
    executionId: ExecutionId.make(row.executionId),
    status: row.status as ExecutionToolCallStatus,
    toolPath: row.toolPath,
    namespace: row.namespace,
    argsJson: row.argsJson,
    resultJson: row.resultJson,
    errorText: row.errorText,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    durationMs: row.durationMs,
  });

/**
 * Translate a `toolPathFilter` entry into a SQL predicate suitable
 * for an `ANY (…)` / `OR` composition. Supports exact match and
 * trailing `.*` glob.
 */
const toolPathPredicate = (pattern: string): SQL => {
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // keep trailing `.`
    return like(executionToolCalls.toolPath, `${prefix}%`);
  }
  return eq(executionToolCalls.toolPath, pattern);
};

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
          triggerKind: input.triggerKind,
          triggerMetaJson: input.triggerMetaJson,
          toolCallCount: input.toolCallCount,
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
            toolCallCount: next.toolCallCount,
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
        if (options.triggerFilter && options.triggerFilter.length > 0) {
          // Postgres `NULL` is not equal to any literal, so treat "unknown"
          // as "triggerKind IS NULL" when the filter includes it.
          const kinds = options.triggerFilter.filter((k) => k !== "unknown");
          const includeUnknown = options.triggerFilter.includes("unknown");
          const parts: SQL[] = [];
          if (kinds.length > 0) parts.push(inArray(executions.triggerKind, kinds));
          if (includeUnknown) parts.push(sql`${executions.triggerKind} IS NULL`);
          if (parts.length > 0) {
            filterConditions.push(parts.length === 1 ? parts[0]! : or(...parts)!);
          }
        }
        if (options.timeRange?.from !== undefined) {
          filterConditions.push(gte(executions.createdAt, options.timeRange.from));
        }
        if (options.timeRange?.to !== undefined) {
          filterConditions.push(lte(executions.createdAt, options.timeRange.to));
        }
        if (options.after !== undefined) {
          filterConditions.push(gt(executions.createdAt, options.after));
        }
        if (options.codeQuery && options.codeQuery.trim().length > 0) {
          filterConditions.push(ilike(executions.code, `%${options.codeQuery.trim()}%`));
        }
        if (options.toolPathFilter && options.toolPathFilter.length > 0) {
          // Subquery: execution_ids that have at least one matching tool call
          const patternConditions = options.toolPathFilter.map(toolPathPredicate);
          const patternWhere =
            patternConditions.length === 1 ? patternConditions[0]! : or(...patternConditions)!;
          const subquery = db
            .select({ id: executionToolCalls.executionId })
            .from(executionToolCalls)
            .where(
              and(
                eq(executionToolCalls.organizationId, organizationId),
                patternWhere,
              ),
            );
          filterConditions.push(inArray(executions.id, subquery));
        }
        if (options.hadElicitation !== undefined) {
          // Subquery: execution_ids with at least one recorded interaction,
          // scoped to this org. `inArray` → elicited runs, `notInArray` →
          // autonomous runs.
          const interactionSubquery = db
            .select({ id: executionInteractions.executionId })
            .from(executionInteractions)
            .where(eq(executionInteractions.organizationId, organizationId));
          filterConditions.push(
            options.hadElicitation
              ? inArray(executions.id, interactionSubquery)
              : notInArray(executions.id, interactionSubquery),
          );
        }

        const conditions = [...filterConditions];

        // Determine sort for ORDER BY. Default is `createdAt desc`
        // which maps exactly to the historical behavior.
        const sortField = options.sort?.field ?? "createdAt";
        const sortDirection = options.sort?.direction ?? "desc";

        // Cursor pagination is only honored when the sort matches the
        // default (createdAt). For `durationMs` sort the cursor would
        // need to encode the computed duration to be correct — we
        // skip cursor support in that case; the first page returns
        // the top `limit` rows and no nextCursor.
        const cursor = options.cursor ? decodeCursor(options.cursor) : null;
        const cursorAppliesToSort = sortField === "createdAt";
        if (cursor && cursorAppliesToSort) {
          // Preserve the existing createdAt-desc cursor predicate
          // regardless of asc/desc — the cursor describes a boundary
          // row, and we want rows strictly "after" it in sort order.
          if (sortDirection === "desc") {
            conditions.push(
              or(
                lt(executions.createdAt, cursor.createdAt),
                and(eq(executions.createdAt, cursor.createdAt), lt(executions.id, cursor.id)),
              )!,
            );
          } else {
            conditions.push(
              or(
                gt(executions.createdAt, cursor.createdAt),
                and(eq(executions.createdAt, cursor.createdAt), gt(executions.id, cursor.id)),
              )!,
            );
          }
        }

        // Build ORDER BY based on the requested sort. `durationMs` is
        // computed as `(completed_at - started_at)` with COALESCE so
        // NULLs sort to the end regardless of direction.
        const orderBy = (() => {
          if (sortField === "durationMs") {
            const expr =
              sortDirection === "asc"
                ? sql`coalesce(${executions.completedAt} - ${executions.startedAt}, 9223372036854775807) asc`
                : sql`coalesce(${executions.completedAt} - ${executions.startedAt}, -1) desc`;
            return [expr, desc(executions.id)];
          }
          return sortDirection === "asc"
            ? [asc(executions.createdAt), desc(executions.id)]
            : [desc(executions.createdAt), desc(executions.id)];
        })();

        const rows = await db
          .select()
          .from(executions)
          .where(and(...conditions))
          .orderBy(...orderBy)
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
          // Four queries: filtered rows (for triggerCounts + chart), the
          // scope-wide total count, a grouped tool-path count over the
          // filtered subset, and the distinct set of filtered execution
          // IDs that recorded at least one interaction.
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

          const filteredExecutions = filteredForMeta.map(toExecution);
          const filteredIds = filteredExecutions.map((execution) => execution.id);

          const [toolCountRows, interactionRows] =
            filteredIds.length === 0
              ? [[], []]
              : await Promise.all([
                  db
                    .select({
                      toolPath: executionToolCalls.toolPath,
                      count: sql<number>`count(*)::int`,
                    })
                    .from(executionToolCalls)
                    .where(
                      and(
                        eq(executionToolCalls.organizationId, organizationId),
                        inArray(executionToolCalls.executionId, filteredIds),
                      ),
                    )
                    .groupBy(executionToolCalls.toolPath),
                  db
                    .selectDistinct({ executionId: executionInteractions.executionId })
                    .from(executionInteractions)
                    .where(
                      and(
                        eq(executionInteractions.organizationId, organizationId),
                        inArray(executionInteractions.executionId, filteredIds),
                      ),
                    ),
                ]);

          const toolPathCounts = new Map<string, number>();
          for (const row of toolCountRows) {
            toolPathCounts.set(row.toolPath, Number(row.count));
          }

          const executionIdsWithInteractions = new Set<ExecutionId>(
            interactionRows.map((row) => ExecutionId.make(row.executionId)),
          );

          meta = buildExecutionListMeta({
            filtered: filteredExecutions,
            timeRange: options.timeRange,
            totalRowCount: scopeTotals.length,
            toolPathCounts,
            executionIdsWithInteractions,
          });
        }

        // Only issue a nextCursor when cursor pagination is valid for
        // this sort. For `durationMs` sort the cursor format can't
        // describe "next page" correctly; the frontend loads just the
        // first page and shows `hasNextPage: false`.
        const shouldEmitCursor = cursorAppliesToSort && hasMore && !!last;

        return {
          executions: items,
          nextCursor: shouldEmitCursor ? encodeCursor(last!) : undefined,
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

    recordToolCall: (input: CreateExecutionToolCallInput) =>
      Effect.tryPromise(async () => {
        const id = ExecutionToolCallId.make(`toolcall_${randomUUID()}`);
        await db.insert(executionToolCalls).values({
          id,
          organizationId,
          executionId: input.executionId,
          status: input.status,
          toolPath: input.toolPath,
          namespace: input.namespace,
          argsJson: input.argsJson,
          resultJson: input.resultJson,
          errorText: input.errorText,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
          durationMs: input.durationMs,
        });
        return new ExecutionToolCall({ id, ...input });
      }).pipe(Effect.orDie),

    finishToolCall: (id: ExecutionToolCallId, patch: UpdateExecutionToolCallInput) =>
      Effect.tryPromise(async () => {
        const currentRows = await db
          .select()
          .from(executionToolCalls)
          .where(
            and(
              eq(executionToolCalls.id, id),
              eq(executionToolCalls.organizationId, organizationId),
            ),
          );
        const current = currentRows[0];
        if (!current) {
          throw new Error(`Execution tool call not found: ${id}`);
        }

        const next = new ExecutionToolCall({
          ...toToolCall(current),
          ...patch,
          id,
          executionId: ExecutionId.make(current.executionId),
        });

        await db
          .update(executionToolCalls)
          .set({
            status: next.status,
            resultJson: next.resultJson,
            errorText: next.errorText,
            completedAt: next.completedAt,
            durationMs: next.durationMs,
          })
          .where(
            and(
              eq(executionToolCalls.id, id),
              eq(executionToolCalls.organizationId, organizationId),
            ),
          );

        return next;
      }).pipe(Effect.orDie),

    listToolCalls: (executionId: ExecutionId) =>
      Effect.tryPromise(async () => {
        const rows = await db
          .select()
          .from(executionToolCalls)
          .where(
            and(
              eq(executionToolCalls.organizationId, organizationId),
              eq(executionToolCalls.executionId, executionId),
            ),
          )
          .orderBy(asc(executionToolCalls.startedAt), asc(executionToolCalls.id));
        return rows.map(toToolCall);
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
            .delete(executionToolCalls)
            .where(
              and(
                eq(executionToolCalls.organizationId, organizationId),
                inArray(executionToolCalls.executionId, expiredIds),
              ),
            );
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
