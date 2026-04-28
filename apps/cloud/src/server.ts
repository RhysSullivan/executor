import * as Sentry from "@sentry/cloudflare";
import handler from "@tanstack/react-start/server-entry";
import { instrument, type TraceConfig } from "@microlabs/otel-cf-workers";

import { McpSessionDO as McpSessionDOBase } from "./mcp-session";

// ---------------------------------------------------------------------------
// OTEL config for the main fetch handler — `otel-cf-workers` owns the global
// TracerProvider and flushes via `ctx.waitUntil` at the end of each request.
// The DO runs in a separate isolate and uses its own self-contained WebSdk
// (see `services/telemetry.ts#DoTelemetryLive`); `instrumentDO` from
// otel-cf-workers is NOT used because it breaks `this` binding on
// `WorkerTransport`'s stream primitives and crashes every MCP request with
// DOMException "Illegal invocation".
// ---------------------------------------------------------------------------

const parseSampleRatio = (value: string | undefined): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
};

const otelConfig = (env: Env): TraceConfig => ({
  service: { name: "executor-cloud", version: "1.0.0" },
  exporter: {
    url: env.AXIOM_TRACES_URL ?? "https://api.axiom.co/v1/traces",
    headers: {
      Authorization: `Bearer ${env.AXIOM_TOKEN ?? ""}`,
      "X-Axiom-Dataset": env.AXIOM_DATASET ?? "executor-cloud",
    },
  },
  sampling: {
    headSampler: {
      // Keep remote parent decisions and make local sampling policy explicit.
      acceptRemote: true,
      ratio: parseSampleRatio(env.AXIOM_TRACES_SAMPLE_RATIO),
    },
  },
});

// otel-cf-workers owns the global TracerProvider. Sentry's OTEL compat shim
// registers a ProxyTracerProvider of its own, which prevents otel-cf-workers
// from finding its WorkerTracer and breaks the whole request path with
// "global tracer is not of type WorkerTracer".
const sentryOptions = (env: Env) => ({
  dsn: env.SENTRY_DSN,
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

// Skip OTLP wiring when no Axiom token is configured (dev without secrets).
// Otherwise the exporter ships every span with `Bearer ` (empty), which
// returns 401 on every batch and eventually drops the keep-alive socket —
// the Node http agent's unhandled `'error'` then crashes the process with
// ECONNRESET. It also registers otel-cf-workers' `WorkerTracer` as the
// global tracer; spans started outside its config ALS then die with
// "Config is undefined". Matches the gate in `DoTelemetryLive`.
// `instrument()` mutates the handler it's given (replaces `.fetch` with the
// proxied version), so capture the raw fetch first and then build the
// instrumented handler from a separate object.
const rawFetch = handler.fetch;
const instrumentedHandler = instrument({ fetch: rawFetch }, otelConfig);

const dispatchHandler = {
  fetch: (request: Request, env: Env, ctx: unknown) => {
    const fn = env.AXIOM_TOKEN ? instrumentedHandler.fetch! : rawFetch;
    return (fn as (req: Request, env: Env, ctx: unknown) => Response | Promise<Response>)(
      request,
      env,
      ctx,
    );
  },
};

export default Sentry.withSentry(sentryOptions, dispatchHandler);
