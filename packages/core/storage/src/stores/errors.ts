import { Data } from "effect";

// ---------------------------------------------------------------------------
// Store-layer tagged errors
//
// Used by store implementations to surface query failures, missing rows,
// and uniqueness violations. All three extend Data.TaggedError so they
// integrate cleanly with Effect's typed error channel.
// ---------------------------------------------------------------------------

export class StoreQueryError extends Data.TaggedError("StoreQueryError")<{
  readonly store: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class StoreNotFoundError extends Data.TaggedError("StoreNotFoundError")<{
  readonly store: string;
  readonly id: string;
}> {}

export class StoreConflictError extends Data.TaggedError("StoreConflictError")<{
  readonly store: string;
  readonly id: string;
  readonly message: string;
}> {}

export type StoreError = StoreQueryError | StoreNotFoundError | StoreConflictError;
