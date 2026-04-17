import * as Sentry from "@sentry/cloudflare";
import handler from "@tanstack/react-start/server-entry";
import { instrument, type ResolveConfigFn } from "@microlabs/otel-cf-workers";

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

type OtelEnv = {
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
};

const resolveOtelConfig: ResolveConfigFn<OtelEnv> = (env) => ({
  service: { name: "executor-cloud", version: "1.0.0" },
  exporter: {
    url: "https://api.axiom.co/v1/traces",
    headers: {
      Authorization: `Bearer ${env.AXIOM_TOKEN ?? ""}`,
      "X-Axiom-Dataset": env.AXIOM_DATASET ?? "executor-cloud",
    },
  },
});

// otel-cf-workers owns the global TracerProvider. Sentry's OTEL compat shim
// registers a ProxyTracerProvider of its own, which prevents otel-cf-workers
// from finding its WorkerTracer and breaks the whole request path with
// "global tracer is not of type WorkerTracer".
const sentryOptions = (env: Env) => ({
  dsn: (env as unknown as { SENTRY_DSN?: string }).SENTRY_DSN,
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

const instrumentedHandler = instrument({ fetch: handler.fetch }, resolveOtelConfig);

export default Sentry.withSentry(sentryOptions, instrumentedHandler);
