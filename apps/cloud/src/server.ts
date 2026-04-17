import * as Sentry from "@sentry/cloudflare";
import handler from "@tanstack/react-start/server-entry";
import { instrument, type TraceConfig } from "@microlabs/otel-cf-workers";

import { McpSessionDO as McpSessionDOBase } from "./mcp-session";
import { server } from "./env";

// ---------------------------------------------------------------------------
// OTEL config for the main fetch handler — `otel-cf-workers` owns the global
// TracerProvider and flushes via `ctx.waitUntil` at the end of each request.
// The DO runs in a separate isolate and uses its own self-contained WebSdk
// (see `services/telemetry.ts#DoTelemetryLive`); `instrumentDO` from
// otel-cf-workers is NOT used because it breaks `this` binding on
// `WorkerTransport`'s stream primitives and crashes every MCP request with
// DOMException "Illegal invocation".
// ---------------------------------------------------------------------------

const otelConfig: TraceConfig = {
  service: { name: "executor-cloud", version: "1.0.0" },
  exporter: {
    url: "https://api.axiom.co/v1/traces",
    headers: {
      Authorization: `Bearer ${server.AXIOM_TOKEN}`,
      "X-Axiom-Dataset": server.AXIOM_DATASET,
    },
  },
};

// otel-cf-workers owns the global TracerProvider. Sentry's OTEL compat shim
// registers a ProxyTracerProvider of its own, which prevents otel-cf-workers
// from finding its WorkerTracer and breaks the whole request path with
// "global tracer is not of type WorkerTracer".
//
// The `_env` parameter is unused — `server` from `./env` already gives us
// typed access to every secret. It's only in the signature so Sentry's
// generics infer the DO's `Env` type correctly.
const sentryOptions = (_env: Env) => ({
  dsn: server.SENTRY_DSN,
  tracesSampleRate: 0,
  enableLogs: true,
  sendDefaultPii: true,
  skipOpenTelemetrySetup: true,
  // Our DO methods (init/handleRequest/alarm) live on the prototype, not on
  // the instance. Sentry's default DO auto-wrap only visits own properties,
  // which misses prototype methods — so errors thrown inside init() never
  // reach Sentry. This flag opts into prototype-method instrumentation.
  instrumentPrototypeMethods: true,
});

// ---------------------------------------------------------------------------
// Durable Object — wrapped with Sentry so DO errors land in Sentry (inits the
// client inside the DO isolate, which plain `Sentry.captureException` cannot
// do on its own). We deliberately do NOT wrap with otel-cf-workers'
// `instrumentDO` (see note above).
// ---------------------------------------------------------------------------

export const McpSessionDO = Sentry.instrumentDurableObjectWithSentry(
  sentryOptions,
  McpSessionDOBase,
);

// ---------------------------------------------------------------------------
// Worker fetch handler
// ---------------------------------------------------------------------------

const instrumentedHandler = instrument({ fetch: handler.fetch }, otelConfig);

export default Sentry.withSentry(sentryOptions, instrumentedHandler);
