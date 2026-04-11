import { endOfDay, parseISO, startOfDay } from "date-fns";
import type {
  Execution,
  ExecutionChartBucket,
  ExecutionInteraction,
  ExecutionListMeta,
  ExecutionToolCall,
} from "@executor/sdk";

import { getBaseUrl } from "./base-url";

export type ExecutionListItem = Execution & {
  readonly pendingInteraction: ExecutionInteraction | null;
};

export type ListExecutionsResponse = {
  readonly executions: readonly ExecutionListItem[];
  readonly nextCursor?: string;
  readonly meta?: ExecutionListMeta;
};

export type { ExecutionChartBucket, ExecutionListMeta, ExecutionToolCall };

export type GetExecutionResponse = {
  readonly execution: Execution;
  readonly pendingInteraction: ExecutionInteraction | null;
};

export type ListToolCallsResponse = {
  readonly toolCalls: readonly ExecutionToolCall[];
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

  return readJson<ListExecutionsResponse>(response);
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
