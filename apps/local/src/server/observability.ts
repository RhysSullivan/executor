// ---------------------------------------------------------------------------
// Local-app `ErrorCapture` — console implementation.
//
// Unlike the cloud app (Sentry-backed), the CLI just prints the squashed
// cause + pretty-printed structured cause to stderr and returns a short
// correlation id. Operators can grep for the id in their terminal
// scrollback when a user reports an opaque 500 traceId.
// ---------------------------------------------------------------------------

import { Cause, Effect, Layer } from "effect";

import { ErrorCapture } from "@executor/api";

const nextTraceId = () =>
  `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const ErrorCaptureLive: Layer.Layer<ErrorCapture> = Layer.succeed(
  ErrorCapture,
  ErrorCapture.of({
    captureException: (cause) =>
      Effect.sync(() => {
        const traceId = nextTraceId();
        const squashed = Cause.squash(cause);
        console.error(
          `[executor ${traceId}]`,
          squashed instanceof Error ? squashed.stack ?? squashed : squashed,
        );
        console.error(`[executor ${traceId}] cause:`, Cause.pretty(cause));
        return traceId;
      }),
  }),
);
