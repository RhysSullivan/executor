import * as Data from "effect/Data";

export type PersistenceErrorKind =
  | "unique_violation"
  | "not_null_violation"
  | "check_violation"
  | "foreign_key_violation"
  | "serialization_failure"
  | "unknown";

type ErrorMetadata = {
  code: string | null;
  constraint: string | null;
  table: string | null;
  details: string | null;
  message: string;
  kind: PersistenceErrorKind;
};

export class ControlPlanePersistenceError extends Data.TaggedError(
  "ControlPlanePersistenceError",
)<{
  operation: string;
  message: string;
  details: string | null;
  code: string | null;
  constraint: string | null;
  table: string | null;
  kind: PersistenceErrorKind;
  cause: unknown;
}> {}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const classifyKind = (code: string | null): PersistenceErrorKind => {
  switch (code) {
    case "23505":
      return "unique_violation";
    case "23502":
      return "not_null_violation";
    case "23514":
      return "check_violation";
    case "23503":
      return "foreign_key_violation";
    case "40001":
      return "serialization_failure";
    default:
      return "unknown";
  }
};

const toErrorMetadata = (cause: unknown): ErrorMetadata => {
  const record = asRecord(cause);
  const code = readString(record?.code);
  const constraint =
    readString(record?.constraint)
    ?? readString(record?.constraint_name)
    ?? readString(record?.constraintName);
  const table = readString(record?.table) ?? readString(record?.table_name);
  const details = readString(record?.detail) ?? readString(record?.details);
  const message = cause instanceof Error ? cause.message : String(cause);

  return {
    code,
    constraint,
    table,
    details,
    message,
    kind: classifyKind(code),
  };
};

export const toPersistenceError = (
  operation: string,
  cause: unknown,
): ControlPlanePersistenceError => {
  const metadata = toErrorMetadata(cause);
  return new ControlPlanePersistenceError({
    operation,
    message: `Control-plane persistence failed during ${operation}`,
    details: metadata.details ?? metadata.message,
    code: metadata.code,
    constraint: metadata.constraint,
    table: metadata.table,
    kind: metadata.kind,
    cause,
  });
};
