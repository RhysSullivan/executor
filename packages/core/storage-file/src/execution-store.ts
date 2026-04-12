import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import type * as SqlClient from "@effect/sql/SqlClient";

import {
  Execution,
  ExecutionId,
  ExecutionInteraction,
  ExecutionInteractionId,
  ExecutionToolCall,
  ExecutionToolCallId,
  buildExecutionListMeta,
  encodeCursor,
  decodeCursor,
  matchToolPathPattern,
  pickExecutionSorter,
  type CreateExecutionInput,
  type CreateExecutionInteractionInput,
  type CreateExecutionToolCallInput,
  type ExecutionListItem,
  type ExecutionListOptions,
  type UpdateExecutionInput,
  type UpdateExecutionInteractionInput,
  type UpdateExecutionToolCallInput,
  type ExecutionStatus,
  type ExecutionToolCallStatus,
  ScopeId,
} from "@executor/sdk";

import { absorbSql } from "./sql-utils";

type ExecutionRow = {
  id: string;
  scope_id: string;
  status: string;
  code: string;
  result_json: string | null;
  error_text: string | null;
  logs_json: string | null;
  started_at: number | null;
  completed_at: number | null;
  trigger_kind: string | null;
  trigger_meta_json: string | null;
  tool_call_count: number;
  created_at: number;
  updated_at: number;
};

type ExecutionInteractionRow = {
  id: string;
  execution_id: string;
  status: string;
  kind: string;
  purpose: string;
  payload_json: string;
  response_json: string | null;
  response_private_json: string | null;
  created_at: number;
  updated_at: number;
};

type ExecutionToolCallRow = {
  id: string;
  execution_id: string;
  status: string;
  tool_path: string;
  namespace: string;
  args_json: string | null;
  result_json: string | null;
  error_text: string | null;
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
};

const toExecution = (row: ExecutionRow): Execution =>
  new Execution({
    id: ExecutionId.make(row.id),
    scopeId: ScopeId.make(row.scope_id),
    status: row.status as ExecutionStatus,
    code: row.code,
    resultJson: row.result_json,
    errorText: row.error_text,
    logsJson: row.logs_json,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    triggerKind: row.trigger_kind,
    triggerMetaJson: row.trigger_meta_json,
    toolCallCount: row.tool_call_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const toInteraction = (row: ExecutionInteractionRow): ExecutionInteraction =>
  new ExecutionInteraction({
    id: ExecutionInteractionId.make(row.id),
    executionId: ExecutionId.make(row.execution_id),
    status: row.status as ExecutionInteraction["status"],
    kind: row.kind,
    purpose: row.purpose,
    payloadJson: row.payload_json,
    responseJson: row.response_json,
    responsePrivateJson: row.response_private_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const toToolCall = (row: ExecutionToolCallRow): ExecutionToolCall =>
  new ExecutionToolCall({
    id: ExecutionToolCallId.make(row.id),
    executionId: ExecutionId.make(row.execution_id),
    status: row.status as ExecutionToolCallStatus,
    toolPath: row.tool_path,
    namespace: row.namespace,
    argsJson: row.args_json,
    resultJson: row.result_json,
    errorText: row.error_text,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
  });

export const makeSqliteExecutionStore = (sql: SqlClient.SqlClient) => {
  const matchesFilters = (
    execution: Execution,
    options: ExecutionListOptions,
    toolPathsByExecution: Map<ExecutionId, string[]>,
    executionIdsWithInteractions: ReadonlySet<ExecutionId>,
  ): boolean => {
    if (options.statusFilter && options.statusFilter.length > 0) {
      const allowed = new Set<ExecutionStatus>(options.statusFilter);
      if (!allowed.has(execution.status)) return false;
    }

    if (options.triggerFilter && options.triggerFilter.length > 0) {
      const allowed = new Set(options.triggerFilter);
      const kind = execution.triggerKind ?? "unknown";
      if (!allowed.has(kind)) return false;
    }

    if (options.timeRange?.from !== undefined && execution.createdAt < options.timeRange.from) {
      return false;
    }
    if (options.timeRange?.to !== undefined && execution.createdAt > options.timeRange.to) {
      return false;
    }
    if (options.after !== undefined && execution.createdAt <= options.after) {
      return false;
    }
    if (options.codeQuery) {
      const query = options.codeQuery.trim().toLowerCase();
      if (query.length > 0 && !execution.code.toLowerCase().includes(query)) return false;
    }

    if (options.toolPathFilter && options.toolPathFilter.length > 0) {
      const paths = toolPathsByExecution.get(execution.id) ?? [];
      const any = options.toolPathFilter.some((pattern) =>
        paths.some((path) => matchToolPathPattern(path, pattern)),
      );
      if (!any) return false;
    }

    if (options.hadElicitation !== undefined) {
      const hasInteraction = executionIdsWithInteractions.has(execution.id);
      if (options.hadElicitation !== hasInteraction) return false;
    }

    return true;
  };

  const getPendingInteractions = (): Effect.Effect<Map<ExecutionId, ExecutionInteraction>> =>
    absorbSql(
      Effect.gen(function* () {
        const rows = yield* sql<ExecutionInteractionRow>`
          SELECT *
          FROM execution_interactions
          WHERE status = 'pending'
          ORDER BY created_at DESC, id DESC
        `;

        const map = new Map<ExecutionId, ExecutionInteraction>();
        for (const row of rows) {
          const interaction = toInteraction(row);
          if (!map.has(interaction.executionId)) {
            map.set(interaction.executionId, interaction);
          }
        }
        return map;
      }),
    );

  const getToolPathsForScope = (scopeId: ScopeId): Effect.Effect<Map<ExecutionId, string[]>> =>
    absorbSql(
      Effect.gen(function* () {
        const rows = yield* sql<{ execution_id: string; tool_path: string }>`
          SELECT tc.execution_id, tc.tool_path
          FROM execution_tool_calls tc
          INNER JOIN executions e ON e.id = tc.execution_id
          WHERE e.scope_id = ${scopeId}
        `;
        const map = new Map<ExecutionId, string[]>();
        for (const row of rows) {
          const executionId = ExecutionId.make(row.execution_id);
          const list = map.get(executionId);
          if (list) {
            list.push(row.tool_path);
          } else {
            map.set(executionId, [row.tool_path]);
          }
        }
        return map;
      }),
    );

  /**
   * Distinct set of execution IDs in the given scope that have at
   * least one recorded {@link ExecutionInteraction}. Used by the
   * `hadElicitation` filter and `meta.interactionCounts`.
   */
  const getExecutionIdsWithInteractions = (scopeId: ScopeId): Effect.Effect<Set<ExecutionId>> =>
    absorbSql(
      Effect.gen(function* () {
        const rows = yield* sql<{ execution_id: string }>`
          SELECT DISTINCT ei.execution_id
          FROM execution_interactions ei
          INNER JOIN executions e ON e.id = ei.execution_id
          WHERE e.scope_id = ${scopeId}
        `;
        return new Set(rows.map((row) => ExecutionId.make(row.execution_id)));
      }),
    );

  return {
    create: (input: CreateExecutionInput) =>
      absorbSql(
        Effect.gen(function* () {
          const id = ExecutionId.make(`exec_${randomUUID()}`);
          yield* sql`
            INSERT INTO executions (
              id, scope_id, status, code, result_json, error_text, logs_json,
              started_at, completed_at, trigger_kind, trigger_meta_json,
              tool_call_count, created_at, updated_at
            ) VALUES (
              ${id},
              ${input.scopeId},
              ${input.status},
              ${input.code},
              ${input.resultJson},
              ${input.errorText},
              ${input.logsJson},
              ${input.startedAt},
              ${input.completedAt},
              ${input.triggerKind},
              ${input.triggerMetaJson},
              ${input.toolCallCount},
              ${input.createdAt},
              ${input.updatedAt}
            )
          `;

          return new Execution({ id, ...input });
        }),
      ),

    update: (id: ExecutionId, patch: UpdateExecutionInput) =>
      absorbSql(
        Effect.gen(function* () {
          const currentRows = yield* sql<ExecutionRow>`SELECT * FROM executions WHERE id = ${id}`;
          const current = currentRows[0];
          if (!current) {
            return yield* Effect.die(new Error(`Execution not found: ${id}`));
          }

          const next = new Execution({
            ...toExecution(current),
            ...patch,
            id,
            scopeId: ScopeId.make(current.scope_id),
          });

          yield* sql`
            UPDATE executions SET
              status = ${next.status},
              code = ${next.code},
              result_json = ${next.resultJson},
              error_text = ${next.errorText},
              logs_json = ${next.logsJson},
              started_at = ${next.startedAt},
              completed_at = ${next.completedAt},
              tool_call_count = ${next.toolCallCount},
              updated_at = ${next.updatedAt}
            WHERE id = ${id}
          `;

          return next;
        }),
      ),

    list: (scopeId: ScopeId, options: ExecutionListOptions) =>
      absorbSql(
        Effect.gen(function* () {
          const limit = Math.max(1, options.limit);
          const allRows = yield* sql<ExecutionRow>`
            SELECT *
            FROM executions
            WHERE scope_id = ${scopeId}
          `;

          const allInScope = allRows.map(toExecution);

          // Tool path map is needed for both filter evaluation (when
          // toolPathFilter is set) and meta toolFacets. Load once.
          const toolPathsByExecution = yield* getToolPathsForScope(scopeId);
          // Execution IDs with at least one interaction — needed for the
          // `hadElicitation` filter and `meta.interactionCounts`.
          const executionIdsWithInteractions = yield* getExecutionIdsWithInteractions(scopeId);

          // Apply filters, then sort by the requested key (default:
          // createdAt desc). Sort happens in JS since the SQL query
          // already loaded every row in scope.
          const allFiltered = allInScope
            .filter((execution) =>
              matchesFilters(
                execution,
                options,
                toolPathsByExecution,
                executionIdsWithInteractions,
              ),
            )
            .sort(pickExecutionSorter(options.sort));

          // Cursor-by-id: find the row by its unique id in the sorted
          // list and paginate from the next index. Works for any sort
          // order because we match by identity, not by sort key.
          const cursor = options.cursor ? decodeCursor(options.cursor) : null;
          const startIndex = cursor
            ? allFiltered.findIndex((execution) => execution.id === cursor.id) + 1
            : 0;
          const afterCursor = allFiltered.slice(Math.max(0, startIndex));

          const executions = afterCursor.slice(0, limit);
          const pendingInteractions = yield* getPendingInteractions();

          const items: ExecutionListItem[] = executions.map((execution) => ({
            ...execution,
            pendingInteraction: pendingInteractions.get(execution.id) ?? null,
          }));

          const hasMore = afterCursor.length > limit;
          const last = executions.at(-1);

          let meta;
          if (options.includeMeta) {
            const filteredIds = new Set(allFiltered.map((execution) => execution.id));
            const toolPathCounts = new Map<string, number>();
            for (const [execId, paths] of toolPathsByExecution.entries()) {
              if (!filteredIds.has(execId)) continue;
              for (const path of paths) {
                toolPathCounts.set(path, (toolPathCounts.get(path) ?? 0) + 1);
              }
            }
            meta = buildExecutionListMeta({
              filtered: allFiltered,
              timeRange: options.timeRange,
              totalRowCount: allInScope.length,
              toolPathCounts,
              executionIdsWithInteractions,
            });
          }

          return {
            executions: items,
            nextCursor: hasMore && last ? encodeCursor(last) : undefined,
            meta,
          };
        }),
      ),

    get: (id: ExecutionId) =>
      absorbSql(
        Effect.gen(function* () {
          const rows = yield* sql<ExecutionRow>`SELECT * FROM executions WHERE id = ${id}`;
          const row = rows[0];
          if (!row) {
            return null;
          }

          const execution = toExecution(row);
          const pendingRows = yield* sql<ExecutionInteractionRow>`
            SELECT *
            FROM execution_interactions
            WHERE execution_id = ${id} AND status = 'pending'
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          `;

          return {
            execution,
            pendingInteraction: pendingRows[0] ? toInteraction(pendingRows[0]) : null,
          };
        }),
      ),

    recordInteraction: (_executionId: ExecutionId, interaction: CreateExecutionInteractionInput) =>
      absorbSql(
        Effect.gen(function* () {
          const id = ExecutionInteractionId.make(`interaction_${randomUUID()}`);
          yield* sql`
            INSERT INTO execution_interactions (
              id, execution_id, status, kind, purpose, payload_json,
              response_json, response_private_json, created_at, updated_at
            ) VALUES (
              ${id},
              ${interaction.executionId},
              ${interaction.status},
              ${interaction.kind},
              ${interaction.purpose},
              ${interaction.payloadJson},
              ${interaction.responseJson},
              ${interaction.responsePrivateJson},
              ${interaction.createdAt},
              ${interaction.updatedAt}
            )
          `;

          return new ExecutionInteraction({ id, ...interaction });
        }),
      ),

    resolveInteraction: (
      interactionId: ExecutionInteractionId,
      patch: UpdateExecutionInteractionInput,
    ) =>
      absorbSql(
        Effect.gen(function* () {
          const currentRows = yield* sql<ExecutionInteractionRow>`
            SELECT * FROM execution_interactions WHERE id = ${interactionId}
          `;
          const current = currentRows[0];
          if (!current) {
            return yield* Effect.die(
              new Error(`Execution interaction not found: ${interactionId}`),
            );
          }

          const next = new ExecutionInteraction({
            ...toInteraction(current),
            ...patch,
            id: interactionId,
            executionId: ExecutionId.make(current.execution_id),
          });

          yield* sql`
            UPDATE execution_interactions SET
              status = ${next.status},
              kind = ${next.kind},
              purpose = ${next.purpose},
              payload_json = ${next.payloadJson},
              response_json = ${next.responseJson},
              response_private_json = ${next.responsePrivateJson},
              updated_at = ${next.updatedAt}
            WHERE id = ${interactionId}
          `;

          return next;
        }),
      ),

    recordToolCall: (input: CreateExecutionToolCallInput) =>
      absorbSql(
        Effect.gen(function* () {
          const id = ExecutionToolCallId.make(`toolcall_${randomUUID()}`);
          yield* sql`
            INSERT INTO execution_tool_calls (
              id, execution_id, status, tool_path, namespace, args_json,
              result_json, error_text, started_at, completed_at, duration_ms
            ) VALUES (
              ${id},
              ${input.executionId},
              ${input.status},
              ${input.toolPath},
              ${input.namespace},
              ${input.argsJson},
              ${input.resultJson},
              ${input.errorText},
              ${input.startedAt},
              ${input.completedAt},
              ${input.durationMs}
            )
          `;
          return new ExecutionToolCall({ id, ...input });
        }),
      ),

    finishToolCall: (id: ExecutionToolCallId, patch: UpdateExecutionToolCallInput) =>
      absorbSql(
        Effect.gen(function* () {
          const currentRows = yield* sql<ExecutionToolCallRow>`
            SELECT * FROM execution_tool_calls WHERE id = ${id}
          `;
          const current = currentRows[0];
          if (!current) {
            return yield* Effect.die(new Error(`Execution tool call not found: ${id}`));
          }

          const next = new ExecutionToolCall({
            ...toToolCall(current),
            ...patch,
            id,
            executionId: ExecutionId.make(current.execution_id),
          });

          yield* sql`
            UPDATE execution_tool_calls SET
              status = ${next.status},
              result_json = ${next.resultJson},
              error_text = ${next.errorText},
              completed_at = ${next.completedAt},
              duration_ms = ${next.durationMs}
            WHERE id = ${id}
          `;

          return next;
        }),
      ),

    listToolCalls: (executionId: ExecutionId) =>
      absorbSql(
        Effect.gen(function* () {
          const rows = yield* sql<ExecutionToolCallRow>`
            SELECT * FROM execution_tool_calls
            WHERE execution_id = ${executionId}
            ORDER BY started_at ASC, id ASC
          `;
          return rows.map(toToolCall);
        }),
      ),

    sweep: () =>
      absorbSql(
        Effect.gen(function* () {
          const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
          // Tool calls cascade via FK, but emit the DELETE explicitly
          // so we're immune to the foreign_keys pragma not being set.
          yield* sql`DELETE FROM execution_tool_calls WHERE execution_id IN (
            SELECT id FROM executions WHERE created_at < ${cutoff}
          )`;
          yield* sql`DELETE FROM execution_interactions WHERE execution_id IN (
            SELECT id FROM executions WHERE created_at < ${cutoff}
          )`;
          yield* sql`DELETE FROM executions WHERE created_at < ${cutoff}`;
        }),
      ),
  };
};
