import { HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

// Tagged errors returned to HTTP clients. The response payload must NEVER
// include internal details (SQL, stack traces, WorkOS error bodies) — those
// can leak schema + secrets. Keep the schema empty and log the `cause`
// server-side via Effect's logger when the error is constructed.
export class UserStoreError extends Schema.TaggedError<UserStoreError>()(
  "UserStoreError",
  {},
  HttpApiSchema.annotations({ status: 500 }),
) {}

export class WorkOSError extends Schema.TaggedError<WorkOSError>()(
  "WorkOSError",
  {},
  HttpApiSchema.annotations({ status: 500 }),
) {}
