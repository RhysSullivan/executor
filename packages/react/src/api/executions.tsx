import { endOfDay, parseISO, startOfDay } from "date-fns";

import { getBaseUrl } from "./base-url";

// ---------------------------------------------------------------------------
// Wire-format row projections. The server returns epoch-ms numbers for
// every timestamp (handlers stringify/unwrap Effect Schema `Date`s at
// the edge), so the UI works with plain numbers throughout instead of
// reusing the SDK's Schema classes that decode to `Date`.
// ---------------------------------------------------------------------------

export type ExecutionStatus =
  | "pending"
  | "running"
  | "waiting_for_interaction"
  | "completed"
  | "failed"
  | "cancelled";

export type Execution = {
  readonly id: string;
  readonly scopeId: string;
  readonly status: ExecutionStatus;
  readonly code: string;
  readonly resultJson: string | null;
  readonly errorText: string | null;
  readonly logsJson: string | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly triggerKind: string | null;
  readonly triggerMetaJson: string | null;
  readonly toolCallCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ExecutionInteraction = {
  readonly id: string;
  readonly executionId: string;
  readonly status: "pending" | "resolved" | "cancelled";
  readonly kind: string;
  readonly purpose: string | null;
  readonly payloadJson: string | null;
  readonly responseJson: string | null;
  readonly responsePrivateJson: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ExecutionToolCall = {
  readonly id: string;
  readonly executionId: string;
  readonly status: "running" | "completed" | "failed";
  readonly toolPath: string;
  readonly namespace: string | null;
  readonly argsJson: string | null;
  readonly resultJson: string | null;
  readonly errorText: string | null;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly durationMs: number | null;
};

export type ExecutionChartBucket = {
  readonly bucketStart: number;
  readonly counts: Readonly<Record<string, number>>;
};

export type ExecutionListMeta = {
  readonly totalRowCount: number;
  readonly filterRowCount: number;
  readonly statusCounts: ReadonlyArray<{
    readonly status: ExecutionStatus;
    readonly count: number;
  }>;
  readonly triggerCounts: ReadonlyArray<{
    readonly triggerKind: string | null;
    readonly count: number;
  }>;
  readonly toolFacets: ReadonlyArray<{
    readonly toolPath: string;
    readonly count: number;
  }>;
  readonly interactionCounts: {
    readonly withElicitation: number;
    readonly withoutElicitation: number;
  };
  readonly chartBucketMs: number;
  readonly chartData: ReadonlyArray<ExecutionChartBucket>;
};

/**
 * Flat list item shape consumed by the runs UI. The server returns
 * `{ execution, pendingInteraction }` nested; we flatten here so every
 * component can read `row.id` / `row.createdAt` / `row.pendingInteraction`
 * without going through `.execution`.
 */
export type ExecutionListItem = Execution & {
  readonly pendingInteraction: ExecutionInteraction | null;
};

export type ListExecutionsResponse = {
  readonly executions: readonly ExecutionListItem[];
  readonly nextCursor?: string;
  readonly meta?: ExecutionListMeta;
};

export type GetExecutionResponse = {
  readonly execution: Execution;
  readonly pendingInteraction: ExecutionInteraction | null;
};

export type ListToolCallsResponse = {
  readonly toolCalls: readonly ExecutionToolCall[];
};

type ServerListItem = {
  readonly execution: Execution;
  readonly pendingInteraction: ExecutionInteraction | null;
};

type ServerListResponse = {
  readonly executions: readonly ServerListItem[];
  readonly nextCursor?: string;
  readonly meta?: ExecutionListMeta;
};

export type RunsQueryInput = {
  readonly limit: number;
  readonly cursor?: string;
  readonly status?: string;
  readonly trigger?: string;
  readonly tool?: string;
  readonly from?: string;
  readonly to?: string;
  /** Live-mode floor: epoch-ms. Rows strictly newer than this. */
  readonly after?: string;
  readonly code?: string;
  /** Sort expression `"<field>,<direction>"` e.g. `"createdAt,desc"`. */
  readonly sort?: string;
  /**
   * Interactions filter: `"true"` → only runs that recorded an
   * elicitation, `"false"` → only runs that didn't, omitted → no
   * filter. Maps to `hadElicitation` on the server side.
   */
  readonly elicitation?: string;
};

const toEpochRange = (date: string | undefined, mode: "start" | "end"): number | undefined => {
  if (!date) return undefined;

  try {
    const parsed = parseISO(date);
    return mode === "start" ? startOfDay(parsed).getTime() : endOfDay(parsed).getTime();
  } catch {
    return undefined;
  }
};

const readJson = async <T,>(response: Response): Promise<T> => {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
};

export const listExecutions = async (input: RunsQueryInput): Promise<ListExecutionsResponse> => {
  const params = new URLSearchParams();
  params.set("limit", String(input.limit));

  if (input.cursor) params.set("cursor", input.cursor);
  if (input.status) params.set("status", input.status);
  if (input.trigger) params.set("trigger", input.trigger);
  if (input.tool) params.set("tool", input.tool);
  if (input.after) params.set("after", input.after);
  if (input.sort) params.set("sort", input.sort);
  if (input.elicitation) params.set("elicitation", input.elicitation);

  const from = toEpochRange(input.from, "start");
  const to = toEpochRange(input.to, "end");
  if (from !== undefined) params.set("from", String(from));
  if (to !== undefined) params.set("to", String(to));
  if (input.code?.trim()) params.set("code", input.code.trim());

  const response = await fetch(`${getBaseUrl()}/executions?${params.toString()}`, {
    credentials: "include",
  });

  const payload = await readJson<ServerListResponse>(response);
  return {
    executions: payload.executions.map(
      (item): ExecutionListItem => ({
        ...item.execution,
        pendingInteraction: item.pendingInteraction,
      }),
    ),
    ...(payload.nextCursor ? { nextCursor: payload.nextCursor } : {}),
    ...(payload.meta ? { meta: payload.meta } : {}),
  };
};

export const getExecution = async (executionId: string): Promise<GetExecutionResponse> => {
  const response = await fetch(`${getBaseUrl()}/executions/${executionId}`, {
    credentials: "include",
  });

  return readJson<GetExecutionResponse>(response);
};

export const listExecutionToolCalls = async (
  executionId: string,
): Promise<ListToolCallsResponse> => {
  const response = await fetch(`${getBaseUrl()}/executions/${executionId}/tool-calls`, {
    credentials: "include",
  });

  return readJson<ListToolCallsResponse>(response);
};
