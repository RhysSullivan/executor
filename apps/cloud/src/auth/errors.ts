import { HttpApiSchema } from "@effect/platform";
import { Effect, Schema } from "effect";

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

/**
 * Service-boundary error wrapper. Logs the full Cause chain (drizzle
 * query/params, pg error codes, nested Error.cause, etc.) via Effect's
 * structured logger, then maps to a tagged error so the HTTP wire
 * response contains only safe fields.
 *
 * Use this whenever a Promise-based API gets lifted into an Effect and
 * its failure needs both debuggable server-side logging and a safe
 * public shape.
 */
export const withServiceLogging = <A, E, R>(
  name: string,
  publicError: () => E,
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.tapErrorCause((cause) =>
      Effect.logError(`${name} failed`, cause),
    ),
    Effect.mapError(publicError),
    Effect.withSpan(name),
  );
