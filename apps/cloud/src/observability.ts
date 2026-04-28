// ---------------------------------------------------------------------------
// Cloud-app implementation of the shared `ErrorCapture` service. This is the
// only file in the cloud-app that imports `@sentry/cloudflare` for error
// capture — handlers, plugin SDKs, and storage code all stay
// Sentry-agnostic and request the `ErrorCapture` tag instead.
//
// `withObservability` (in @executor/api) wraps every handler effect; when
// it sees an unmapped cause it asks `ErrorCapture.captureException` for a
// trace id and fails with `InternalError({ traceId })`. The client gets
// the opaque id, we get the full cause + stack in Sentry.
// ---------------------------------------------------------------------------

import * as Sentry from "@sentry/cloudflare";
import { Cause, Effect, Layer } from "effect";

import { ErrorCapture } from "@executor/api";

// Drizzle/postgres-js include the failing SQL (params + bound values) in
// their error message. For OpenAPI source inserts that's 1MB+ of spec
// text which blows past terminal scrollback and hides the actual pg
// error. Sentry still receives the full, untruncated cause via
// `setExtra`; only the dev-console mirror is capped.
const MAX_CONSOLE_CAUSE_CHARS = 4_000;

const truncate = (s: string): string =>
  s.length <= MAX_CONSOLE_CAUSE_CHARS
    ? s
    : `${s.slice(0, MAX_CONSOLE_CAUSE_CHARS)}\n…[truncated ${s.length - MAX_CONSOLE_CAUSE_CHARS} chars]`;

export const ErrorCaptureLive: Layer.Layer<ErrorCapture> = Layer.succeed(
  ErrorCapture,
  ErrorCapture.of({
    captureException: (cause) =>
      Effect.sync(() => {
        const squashed = Cause.squash(cause);
        const pretty = Cause.pretty(cause);
        console.error("[api] unhandled cause:", truncate(pretty));
        const eventId = Sentry.captureException(squashed, (scope) => {
          scope.setExtra("cause", pretty);
          return scope;
        });
        return eventId ?? "";
      }),
  }),
);
