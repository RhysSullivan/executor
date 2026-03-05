import * as Data from "effect/Data";

export class ControlPlanePersistenceError extends Data.TaggedError(
  "ControlPlanePersistenceError",
)<{
  operation: string;
  message: string;
  details: string | null;
}> {}

export const toPersistenceError = (
  operation: string,
  cause: unknown,
): ControlPlanePersistenceError => {
  const details = cause instanceof Error ? cause.message : String(cause);
  return new ControlPlanePersistenceError({
    operation,
    message: `Control-plane persistence failed during ${operation}`,
    details,
  });
};
