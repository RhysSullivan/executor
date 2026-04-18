// ---------------------------------------------------------------------------
// Effect → OTEL → Axiom bridge
// ---------------------------------------------------------------------------
//
// Two callers, two setups:
//
// - `TelemetryLive` (fetch path): reads the global `TracerProvider` that
//   `@microlabs/otel-cf-workers`' `instrument(...)` installs in `server.ts`.
//   Flushing is handled by `instrument()` via `ctx.waitUntil` at request end.
//
// - `DoTelemetryLive` (Durable Object path): provisions its own
//   `WebSdk`-backed tracer via `Effect`. The DO runs in a separate isolate
//   and we deliberately avoid `instrumentDO` (it wraps DO methods in a way
//   that breaks `this` binding on `WorkerTransport`'s stream primitives —
//   every MCP request 500s with "Illegal invocation"). The DO uses a
//   `SimpleSpanProcessor` so spans export immediately; there's no
//   `ctx.waitUntil` to rely on for batching.
// ---------------------------------------------------------------------------

// Subpath imports — the barrel `@effect/opentelemetry` re-exports `NodeSdk`,
// which eagerly imports `@opentelemetry/sdk-trace-node` and its
// `context-async-hooks` dep. Under vitest-pool-workers that crashes module
// load (no `async_hooks` in workerd). Production bundles tree-shake the
// unused NodeSdk; vitest does not.
import * as Resource from "@effect/opentelemetry/Resource";
import * as OtelTracer from "@effect/opentelemetry/Tracer";
import * as WebSdk from "@effect/opentelemetry/WebSdk";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Layer } from "effect";

import { server } from "../env";

export const TelemetryLive: Layer.Layer<never> = OtelTracer.layerGlobal.pipe(
  Layer.provide(Resource.layer({ serviceName: "executor-cloud", serviceVersion: "1.0.0" })),
);

const makeDoOtelExporter = () =>
  new OTLPTraceExporter({
    url: "https://api.axiom.co/v1/traces",
    headers: {
      Authorization: `Bearer ${server.AXIOM_TOKEN}`,
      "X-Axiom-Dataset": server.AXIOM_DATASET,
    },
  });

export const DoTelemetryLive: Layer.Layer<never> = server.AXIOM_TOKEN
  ? WebSdk.layer(() => ({
      resource: { serviceName: "executor-cloud", serviceVersion: "1.0.0" },
      spanProcessor: new SimpleSpanProcessor(makeDoOtelExporter()),
    }))
  : Layer.empty;
