// ---------------------------------------------------------------------------
// Metrics export for the local daemon.
//
// Gated on `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (OTel standard env var).
// When set, wires `@effect/opentelemetry/OtlpMetrics` into a module-scope
// `ManagedRuntime` so the exporter's timer fiber keeps ticking across
// requests — per-request scoping would shut down the exporter before the
// first batch leaves.
//
// When unset, `MetricsRuntime` is `null` and nothing pushes; the
// in-process registry keeps accumulating counters + histograms so
// `GET /api/metrics` still serves a complete snapshot on demand.
//
// Auth: `OTEL_EXPORTER_OTLP_METRICS_HEADERS` follows the OTel spec
// format — comma-separated `key=value` pairs. For Axiom specifically,
// that's `Authorization=Bearer xxx,X-Axiom-Dataset=executor-local`.
// ---------------------------------------------------------------------------

import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as OtlpMetrics from "@effect/opentelemetry/OtlpMetrics";
import * as OtlpSerialization from "@effect/opentelemetry/OtlpSerialization";
import { Effect, Layer, ManagedRuntime } from "effect";

const SERVICE_NAME = "executor-local";
const SERVICE_VERSION = "1.0.0";

const parseHeaders = (raw: string | undefined): Record<string, string> => {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const idx = entry.indexOf("=");
    if (idx === -1) continue;
    const key = entry.slice(0, idx).trim();
    const value = entry.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
};

const endpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
const headers = parseHeaders(process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS);

/**
 * Module-scope runtime holding the OTLP exporter. Never disposed for the
 * daemon's lifetime — the exporter's fiber ticks every `exportInterval`
 * (10s default) regardless of per-request activity. Set to `null` when
 * no push endpoint is configured, making every `useMetrics` call a no-op.
 */
export const MetricsRuntime = endpoint
  ? ManagedRuntime.make(
      OtlpMetrics.layer({
        url: endpoint,
        resource: { serviceName: SERVICE_NAME, serviceVersion: SERVICE_VERSION },
        headers,
      }).pipe(
        Layer.provide(OtlpSerialization.layerJson),
        Layer.provide(FetchHttpClient.layer),
      ),
    )
  : null;

/**
 * Idempotent startup hook. Call once from the daemon's main() to force
 * the module-scope runtime to boot (which starts the exporter's push
 * timer). No-op when OTLP is not configured.
 */
export const startMetricsExport = (): Effect.Effect<void> =>
  MetricsRuntime
    ? Effect.promise(() => MetricsRuntime!.runPromise(Effect.void))
    : Effect.void;
