import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import type * as SqlClient from "@effect/sql/SqlClient";

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
  type ExecutionStatus,
  ScopeId,
} from "@executor/sdk";

import { absorbSql } from "./sql-utils";

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

const matchesFilters = (execution: Execution, options: ExecutionListOptions): boolean => {
  if (options.statusFilter && options.statusFilter.length > 0) {
    const allowed = new Set<ExecutionStatus>(options.statusFilter);
    if (!allowed.has(execution.status)) {
      return false;
    }
  }

  if (options.timeRange?.from !== undefined && execution.createdAt < options.timeRange.from) {
    return false;
  }

  if (options.timeRange?.to !== undefined && execution.createdAt > options.timeRange.to) {
    return false;
  }

  if (options.codeQuery) {
    const query = options.codeQuery.trim().toLowerCase();
    if (query.length > 0 && !execution.code.toLowerCase().includes(query)) {
      return false;
    }
  }

  return true;
};

export const makeSqliteExecutionStore = (sql: SqlClient.SqlClient) => {
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

  return {
    create: (input: CreateExecutionInput) =>
      absorbSql(
        Effect.gen(function* () {
          const id = ExecutionId.make(`exec_${randomUUID()}`);
          yield* sql`
            INSERT INTO executions (
              id, scope_id, status, code, result_json, error_text, logs_json,
              started_at, completed_at, created_at, updated_at
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
            ORDER BY created_at DESC, id DESC
          `;

          const allInScope = allRows.map(toExecution);
          const allFiltered = allInScope.filter((execution) =>
            matchesFilters(execution, options),
          );

          const cursor = options.cursor ? decodeCursor(options.cursor) : null;
          const afterCursor = allFiltered.filter((execution) =>
            cursor
              ? execution.createdAt < cursor.createdAt ||
                (execution.createdAt === cursor.createdAt && execution.id < cursor.id)
              : true,
          );

          const executions = afterCursor.slice(0, limit);
          const pendingInteractions = yield* getPendingInteractions();

          const items: ExecutionListItem[] = executions.map((execution) => ({
            ...execution,
            pendingInteraction: pendingInteractions.get(execution.id) ?? null,
          }));

          const hasMore = afterCursor.length > limit;
          const last = executions.at(-1);
          const meta = options.includeMeta
            ? buildExecutionListMeta(allFiltered, options.timeRange, allInScope.length)
            : undefined;

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

    resolveInteraction: (interactionId: ExecutionInteractionId, patch: UpdateExecutionInteractionInput) =>
      absorbSql(
        Effect.gen(function* () {
          const currentRows = yield* sql<ExecutionInteractionRow>`
            SELECT * FROM execution_interactions WHERE id = ${interactionId}
          `;
          const current = currentRows[0];
          if (!current) {
            return yield* Effect.die(new Error(`Execution interaction not found: ${interactionId}`));
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

    sweep: () =>
      absorbSql(
        Effect.gen(function* () {
          const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
          yield* sql`DELETE FROM execution_interactions WHERE execution_id IN (
            SELECT id FROM executions WHERE created_at < ${cutoff}
          )`;
          yield* sql`DELETE FROM executions WHERE created_at < ${cutoff}`;
        }),
      ),
  };
};
