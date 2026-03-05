import * as Data from "effect/Data";

export class RowStoreError extends Data.TaggedError("RowStoreError")<{
  operation: string;
  backend: string;
  location: string;
  message: string;
  reason: string | null;
  details: string | null;
}> {}
