import { Schema } from "effect";

export class UserStoreError extends Schema.TaggedError<UserStoreError>()(
  "UserStoreError",
  { cause: Schema.Unknown },
) {}

export class WorkOSError extends Schema.TaggedError<WorkOSError>()(
  "WorkOSError",
  { cause: Schema.Unknown },
) {}
