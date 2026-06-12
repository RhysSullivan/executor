import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_FULL,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
} from "@opentelemetry/semantic-conventions";
import * as Sentry from "@sentry/cloudflare";
import handler from "@tanstack/react-start/server-entry";

import { McpSessionDO as McpSessionDOBase } from "./mcp/session-durable-object";
import { browserTracesResponse } from "./observability/browser-traces";
import { flushTracerProvider, installTracerProvider } from "./observability/telemetry";

// ---------------------------------------------------------------------------
// Sentry config
// ---------------------------------------------------------------------------

const sentryOptions = (env: Env) => ({
  dsn: env.SENTRY_DSN,
  tracesSampleRate: 0,
  enableLogs: true,
  sendDefaultPii: true,
  skipOpenTelemetrySetup: true,
  // NOTE: do NOT enable `instrumentPrototypeMethods`. It walks the DO prototype
  // and reads every property — including accessors — to find methods to wrap,
  // which invokes the `sessionId` getter with `this` bound to the prototype
  // (where `ctx` is undefined) and throws during construction, 500ing every
  // session create / cold restore. The DO captures its own errors via the
  // `captureCause` seam (→ Sentry) instead.
});

// ---------------------------------------------------------------------------
// Durable Object — wrapped with Sentry so DO errors land in Sentry (inits the
// client inside the DO isolate, which plain `Sentry.captureException` cannot
// do on its own). OTEL is installed through Effect layers (observability/telemetry),
// not a global fetch wrapper.
// ---------------------------------------------------------------------------

export const McpSessionDO = Sentry.instrumentDurableObjectWithSentry(
  sentryOptions,
  McpSessionDOBase,
);

// ---------------------------------------------------------------------------
// Worker fetch handler
//
// We open a single `http.server <METHOD>` span at the worker boundary using
// the same WebTracerProvider that `observability/telemetry.ts` already installs for
// Effect-driven spans. This restores the per-request envelope span that was
// previously emitted by `@microlabs/otel-cf-workers` and lost in the alchemy
// migration — without the OTel-SDK version-conflict that package would now
// drag in (it pins `@opentelemetry/otlp-* ^0.200.0`, we ship ^0.214.0).
//
// SimpleSpanProcessor exports synchronously at span end but the underlying
// `fetch()` to Axiom is fire-and-forget; the Worker may terminate before it
// completes. `ctx.waitUntil(flushTracerProvider())` keeps the isolate alive
// until the in-flight export resolves.
// ---------------------------------------------------------------------------

const fetchHandler = handler.fetch as (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

const tracer = trace.getTracer("executor-cloud-worker");

const cloudflareHandler: ExportedHandler<Env> = {
  fetch: async (request, env, ctx) => {
    // Browser OTLP ingress — before the server span opens: exporter traffic
    // must never trace itself (the browser already excludes /v1/traces from
    // its own tracing for the same reason).
    const browserTraces = browserTracesResponse(request, env);
    if (browserTraces) return browserTraces;
    if (!installTracerProvider()) {
      return fetchHandler(request, env, ctx);
    }
    const url = new URL(request.url);
    // Join the caller's W3C trace when the request carries one — the web UI
    // sends traceparent on every API fetch, so the browser's spans and this
    // request share one trace id end to end. Same parsing the DO path does
    // in session-durable-object.ts.
    const traceparentMatch = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(
      request.headers.get("traceparent") ?? "",
    );
    const parentContext = traceparentMatch
      ? trace.setSpanContext(context.active(), {
          traceId: traceparentMatch[1]!,
          spanId: traceparentMatch[2]!,
          traceFlags: parseInt(traceparentMatch[3]!, 16),
          isRemote: true,
        })
      : context.active();
    return tracer.startActiveSpan(
      `http.server ${request.method}`,
      { kind: SpanKind.SERVER },
      parentContext,
      async (span) => {
        span.setAttribute(ATTR_HTTP_REQUEST_METHOD, request.method);
        span.setAttribute(ATTR_URL_FULL, request.url);
        span.setAttribute(ATTR_URL_PATH, url.pathname);
        span.setAttribute(ATTR_URL_SCHEME, url.protocol.replace(/:$/, ""));
        // Adapter boundary: Cloudflare's fetch handler is a Promise-based
        // callback and the OTel span lifecycle needs to observe both the
        // resolved response and any thrown error before `span.end()`. Sentry's
        // outer wrapper still captures the exception; we only mark span status.
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary
        try {
          const response = await fetchHandler(request, env, ctx);
          span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);
          if (response.status >= 500) {
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
          return response;
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary; preserve original error to Cloudflare runtime
          throw err;
        } finally {
          span.end();
          ctx.waitUntil(flushTracerProvider());
        }
      },
    );
  },
};

export default Sentry.withSentry(sentryOptions, cloudflareHandler);
