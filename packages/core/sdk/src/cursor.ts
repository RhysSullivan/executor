import type { Execution } from "./executions";
import { ExecutionId } from "./ids";

export const encodeCursor = (execution: Execution): string =>
  encodeURIComponent(JSON.stringify({ createdAt: execution.createdAt, id: execution.id }));

export const decodeCursor = (
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
