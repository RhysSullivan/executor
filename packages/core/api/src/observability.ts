// ---------------------------------------------------------------------------
// HTTP-edge observability — singular translation + capture layer.
//
// The SDK (`@executor/sdk`) stays storage-typed: plugin code and
// executor surface methods return `StorageError` in their typed error
// channel. Non-HTTP consumers (CLI, Promise SDK, tests) see those raw
// and can decide what to do. Here, at the HTTP edge, we define:
//
//   1. `InternalError` — public opaque 500 schema, narrow by design
//      (only `traceId`), so no internal cause/message/stack ever
//      crosses the wire.
//   2. `ErrorCapture` — pluggable service the host wires up (Sentry in
//      the cloud Worker, console in the CLI, in-memory in tests) to
//      record causes and return correlation ids. Optional; absent →
//      empty trace ids, nothing breaks.
//   3. `capture(eff)` — the one translator. Catches `StorageError` and
//      `UniqueViolationError` in the typed channel: the former is
//      captured via `ErrorCapture` and re-failed as `InternalError({
//      traceId })`; the latter dies as a defect (plugins that want to
//      surface it as a typed domain error should `Effect.catchTag`
//      inside their own method first). Every handler wraps its
//      generator body with `capture(...)` — one line, explicit,
//      self-enforcing (TypeScript rejects the handler if it forgets).
//   4. `observabilityMiddleware` — defect safety net. Wraps the HttpApp
//      once; catches any cause that slipped past the typed channel and
//      produces the same `InternalError({ traceId })` shape.
//
// Distinct from `apps/cloud/src/services/telemetry.ts` — that's the
// OTEL bridge wiring spans to Axiom; this is exception capture in the
// Sentry sense.
// ---------------------------------------------------------------------------

import { Cause, Context, Effect, Layer, Option, Schema } from "effect";
import {
  HttpApiBuilder,
  HttpApiSchema,
  HttpServerResponse,
  type HttpApi,
  type HttpApiGroup,
} from "@effect/platform";
import type { StorageFailure } from "@executor/storage-core";

/** Public 500 surface. Opaque by schema. */
export class InternalError extends Schema.TaggedError<InternalError>()(
  "InternalError",
  {
    /** Opaque correlation id for backend lookup (Sentry event id, log line, etc.). */
    traceId: Schema.String,
  },
  HttpApiSchema.annotations({ status: 500 }),
) {}

export interface ErrorCaptureShape {
  /**
   * Record an unexpected cause and return a correlation id the operator
   * can later look up. Implementations (Sentry, console, etc.) decide
   * how to persist it.
   */
  readonly captureException: (
    cause: Cause.Cause<unknown>,
  ) => Effect.Effect<string>;
}

export class ErrorCapture extends Context.Tag("@executor/api/ErrorCapture")<
  ErrorCapture,
  ErrorCaptureShape
>() {
  /** No-op — used where capture isn't wired. Traces back as empty string. */
  static readonly NoOp: Layer.Layer<ErrorCapture> = Layer.succeed(
    ErrorCapture,
    ErrorCapture.of({ captureException: () => Effect.succeed("") }),
  );
}

// Resolve ErrorCapture with a no-op fallback. Keeps the caller's R channel
// unencumbered: no host has to provide ErrorCapture for the wrapper to
// typecheck; if it's there, we use it; if not, trace ids are empty.
const resolveCapture = Effect.serviceOption(ErrorCapture).pipe(
  Effect.map((opt) =>
    Option.isSome(opt)
      ? opt.value
      : ({ captureException: () => Effect.succeed("") } as const),
  ),
);

/**
 * HTTP-edge translator for `StorageFailure` on a single Effect. Two
 * cases:
 *
 *   - `StorageError` — known backend failure. Capture the cause via
 *     `ErrorCapture`, fail with `InternalError({ traceId })`.
 *   - `UniqueViolationError` — invariant violation at the HTTP edge:
 *     if a plugin wanted to surface a unique-conflict as a typed
 *     domain error (e.g. "source already exists") it should
 *     `Effect.catchTag` inside its own method and translate. Anything
 *     that reaches here is unexpected, so we `Effect.die` and let the
 *     observability middleware capture it as a defect.
 *
 * Every other typed failure (plugin-domain errors, etc.) passes
 * through unchanged.
 */
export const capture = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, StorageFailure> | InternalError, R> =>
  (eff as Effect.Effect<A, E | StorageFailure, R>).pipe(
    Effect.catchTag("UniqueViolationError", (err) => Effect.die(err)),
    Effect.catchTag("StorageError", (err) =>
      resolveCapture.pipe(
        Effect.flatMap((c) => c.captureException(Cause.fail(err))),
        Effect.flatMap((traceId) =>
          Effect.fail(new InternalError({ traceId })),
        ),
      ),
    ),
  ) as Effect.Effect<A, Exclude<E, StorageFailure> | InternalError, R>;

/**
 * Translate an engine/runtime-level `YieldableError` (CodeExecutionError,
 * QuickJsExecutionError, DynamicWorkerExecutionError, ...) into the
 * public `InternalError({ traceId })` — same pattern as `capture` does
 * for `StorageError`. The cause is captured via `ErrorCapture` so Sentry
 * / the trace-id lookup retains the full typed cause; the wire contract
 * stays opaque.
 *
 * Use at a single call site per engine invocation: the handler wraps
 * `engine.executeWithPause(...)` with `captureEngineError(...)` so the
 * widened `YieldableError` channel on `ExecutionEngineService` is
 * narrowed to `InternalError` before leaving the handler body.
 */
export const captureEngineError = <A, R>(
  eff: Effect.Effect<A, Cause.YieldableError, R>,
): Effect.Effect<A, InternalError, R> =>
  eff.pipe(
    Effect.catchAll((err) =>
      err instanceof InternalError
        ? Effect.fail(err)
        : resolveCapture.pipe(
            Effect.flatMap((c) => c.captureException(Cause.fail(err))),
            Effect.flatMap((traceId) =>
              Effect.fail(new InternalError({ traceId })),
            ),
          ),
    ),
  );

/**
 * Edge defect catchall. Builds an `HttpApiBuilder.middleware` layer
 * that wraps the HttpApp once. Captures any cause (defects, interrupts,
 * unmapped failures the framework couldn't encode) via `ErrorCapture`
 * and returns a typed `InternalError({ traceId })` body.
 *
 * `ErrorCapture` is OPTIONAL — if the host hasn't wired one up the
 * middleware still fires but the trace id will be empty.
 *
 * Should rarely fire when the edge is well-wired — storage failures
 * are already translated by `withCapture` at service construction;
 * plugin-domain errors flow through their schemas. This is the net
 * for anything that slipped through.
 */
export const observabilityMiddleware = <
  Id extends string,
  Groups extends HttpApiGroup.HttpApiGroup.Any,
  E,
  R,
>(
  api: HttpApi.HttpApi<Id, Groups, E, R>,
): Layer.Layer<never> =>
  HttpApiBuilder.middleware(
    api,
    Effect.gen(function* () {
      const c = yield* resolveCapture;
      return (httpApp) =>
        Effect.catchAllCause(httpApp, (cause) =>
          Effect.gen(function* () {
            const traceId = yield* c.captureException(cause);
            return HttpServerResponse.unsafeJson(
              new InternalError({ traceId }),
              { status: 500 },
            );
          }),
        );
    }),
    { withContext: true },
  );
