import { Effect } from "effect";

import {
  Execution,
  ExecutionInteraction,
  buildExecutionListMeta,
  type CreateExecutionInput,
  type CreateExecutionInteractionInput,
  type ExecutionListItem,
  type ExecutionListOptions,
  type ExecutionStatus,
  type UpdateExecutionInput,
  type UpdateExecutionInteractionInput,
} from "../executions";
import { ExecutionId, ExecutionInteractionId, ScopeId } from "../ids";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

const compareExecutionOrder = (left: Execution, right: Execution): number => {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt - left.createdAt;
  }
  return right.id.localeCompare(left.id);
};

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

export const makeInMemoryExecutionStore = () => {
  const executions = new Map<ExecutionId, Execution>();
  const interactions = new Map<ExecutionInteractionId, ExecutionInteraction>();

  const getPendingInteraction = (executionId: ExecutionId): ExecutionInteraction | null =>
    [...interactions.values()].find(
      (interaction) => interaction.executionId === executionId && interaction.status === "pending",
    ) ?? null;

  return {
    create: (input: CreateExecutionInput) =>
      Effect.sync(() => {
        const id = ExecutionId.make(`exec_${Date.now()}_${Math.random().toString(36).slice(2)}`);
        const execution = new Execution({ id, ...input });
        executions.set(id, execution);
        return execution;
      }),

    update: (id: ExecutionId, patch: UpdateExecutionInput) =>
      Effect.sync(() => {
        const current = executions.get(id);
        if (!current) {
          throw new Error(`Execution not found: ${id}`);
        }
        const execution = new Execution({
          ...current,
          ...patch,
          id: current.id,
          scopeId: current.scopeId,
        });
        executions.set(id, execution);
        return execution;
      }),

    list: (scopeId: ScopeId, options: ExecutionListOptions) =>
      Effect.sync(() => {
        const inScope = [...executions.values()].filter(
          (execution) => execution.scopeId === scopeId,
        );
        const filtered = inScope
          .filter((execution) => matchesFilters(execution, options))
          .sort(compareExecutionOrder);

        const cursor = options.cursor ? decodeCursor(options.cursor) : null;
        const startIndex = cursor
          ? filtered.findIndex(
              (execution) =>
                execution.createdAt === cursor.createdAt && execution.id === cursor.id,
            ) + 1
          : 0;
        const page = filtered.slice(
          Math.max(0, startIndex),
          Math.max(0, startIndex) + options.limit,
        );

        const executionsPage: ExecutionListItem[] = page.map((execution) => ({
          ...execution,
          pendingInteraction: getPendingInteraction(execution.id),
        }));

        const last = page.at(-1);
        const hasMore = startIndex + page.length < filtered.length;
        const meta = options.includeMeta
          ? buildExecutionListMeta(filtered, options.timeRange, inScope.length)
          : undefined;

        return {
          executions: executionsPage,
          nextCursor: hasMore && last ? encodeCursor(last) : undefined,
          meta,
        };
      }),

    get: (id: ExecutionId) =>
      Effect.sync(() => {
        const execution = executions.get(id);
        if (!execution) {
          return null;
        }
        return {
          execution,
          pendingInteraction: getPendingInteraction(id),
        };
      }),

    recordInteraction: (_executionId: ExecutionId, interaction: CreateExecutionInteractionInput) =>
      Effect.sync(() => {
        const id = ExecutionInteractionId.make(
          `interaction_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        );
        const stored = new ExecutionInteraction({ id, ...interaction });
        interactions.set(id, stored);
        return stored;
      }),

    resolveInteraction: (interactionId: ExecutionInteractionId, patch: UpdateExecutionInteractionInput) =>
      Effect.sync(() => {
        const current = interactions.get(interactionId);
        if (!current) {
          throw new Error(`Execution interaction not found: ${interactionId}`);
        }
        const interaction = new ExecutionInteraction({
          ...current,
          ...patch,
          id: current.id,
          executionId: current.executionId,
        });
        interactions.set(interactionId, interaction);
        return interaction;
      }),

    sweep: () =>
      Effect.sync(() => {
        const cutoff = Date.now() - RETENTION_MS;
        const expiredIds = [...executions.values()]
          .filter((execution) => execution.createdAt < cutoff)
          .map((execution) => execution.id);

        for (const executionId of expiredIds) {
          executions.delete(executionId);
          for (const [interactionId, interaction] of interactions) {
            if (interaction.executionId === executionId) {
              interactions.delete(interactionId);
            }
          }
        }
      }),
  };
};
