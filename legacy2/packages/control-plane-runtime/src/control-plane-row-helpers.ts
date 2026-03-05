import { SourceStoreError } from "@executor-v2/persistence-ports";

type RowStoreLikeError = {
  message: string;
  details: string | null;
  reason: string | null;
};

type SourceStoreErrorMapper = {
  fromMessage: (
    operation: string,
    message: string,
    details: string | null,
  ) => SourceStoreError;
  fromRowStore: (
    operation: string,
    error: RowStoreLikeError,
  ) => SourceStoreError;
  fromCause: (
    operation: string,
    cause: unknown,
    details?: string,
  ) => SourceStoreError;
};

export const createSqlSourceStoreErrorMapper = (
  location: string,
): SourceStoreErrorMapper => {
  const fromMessage = (
    operation: string,
    message: string,
    details: string | null,
  ): SourceStoreError =>
    new SourceStoreError({
      operation,
      backend: "sql",
      location,
      message,
      reason: null,
      details,
    });

  return {
    fromMessage,
    fromRowStore: (operation, error) =>
      fromMessage(operation, error.message, error.details ?? error.reason ?? null),
    fromCause: (operation, cause, details) =>
      fromMessage(
        operation,
        cause instanceof Error ? cause.message : String(cause),
        details ?? null,
      ),
  };
};
