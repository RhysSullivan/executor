import * as PlatformError from "@effect/platform/Error";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as ParseResult from "effect/ParseResult";

export type PersistenceErrorData = {
  operation: string;
  filePath: string;
  message: string;
  reason: string | null;
  details: string | null;
};

type PersistenceErrorFactory<E> = (data: PersistenceErrorData) => E;

export const withPlatformPersistenceError =
  <E>(makeError: PersistenceErrorFactory<E>) =>
  <A>(operation: string, filePath: string) =>
  (
    self: Effect.Effect<A, PlatformError.PlatformError>,
  ): Effect.Effect<A, E> =>
    pipe(
      self,
      Effect.catchTags({
        SystemError: (cause) =>
          Effect.fail(
            makeError({
              operation,
              filePath,
              message: cause.message,
              reason: cause.reason,
              details: cause.description ?? null,
            }),
          ),
        BadArgument: (cause) =>
          Effect.fail(
            makeError({
              operation,
              filePath,
              message: cause.message,
              reason: null,
              details: cause.description ?? null,
            }),
          ),
      }),
    );

export const withNotFoundFallback =
  <A>(fallback: A) =>
  (
    self: Effect.Effect<A, PlatformError.PlatformError>,
  ): Effect.Effect<A, PlatformError.PlatformError> =>
    pipe(
      self,
      Effect.catchTag("SystemError", (cause) =>
        cause.reason === "NotFound" ? Effect.succeed(fallback) : Effect.fail(cause),
      ),
    );

export const toSchemaPersistenceError = <E>(
  makeError: PersistenceErrorFactory<E>,
  operation: string,
  filePath: string,
  message: string,
  cause: ParseResult.ParseError,
  details?: string,
): E =>
  makeError({
    operation,
    filePath,
    message,
    reason: "InvalidData",
    details:
      details === undefined
        ? ParseResult.TreeFormatter.formatErrorSync(cause)
        : `${details}\n${ParseResult.TreeFormatter.formatErrorSync(cause)}`,
  });

export const toInvalidDataError = <E>(
  makeError: PersistenceErrorFactory<E>,
  operation: string,
  filePath: string,
  message: string,
  details: string,
): E =>
  makeError({
    operation,
    filePath,
    message,
    reason: "InvalidData",
    details,
  });
