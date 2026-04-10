// ---------------------------------------------------------------------------
// OpenTelemetry setup — pipes Effect spans + logs to Axiom via OTLP
// ---------------------------------------------------------------------------

import { Layer } from "effect";
import { WebSdk, Tracer as OtelTracer } from "@effect/opentelemetry";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { server } from "../env";

const makeResourceLayer = () =>
  WebSdk.layer(() => ({
    resource: {
      serviceName: "executor-cloud",
      serviceVersion: "1.0.0",
    },
    spanProcessor: new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: "https://api.axiom.co/v1/traces",
        headers: {
          Authorization: `Bearer ${server.AXIOM_TOKEN}`,
          "X-Axiom-Dataset": server.AXIOM_DATASET,
        },
      }),
    ),
  }));

/**
 * Full telemetry layer — provides Effect Tracer backed by OTEL → Axiom.
 * All existing `Effect.withSpan` calls automatically become distributed traces.
 * No-op when AXIOM_TOKEN is not set.
 */
export const TelemetryLive: Layer.Layer<never> = server.AXIOM_TOKEN
  ? OtelTracer.layerGlobal.pipe(Layer.provide(makeResourceLayer()))
  : Layer.empty;
