// ---------------------------------------------------------------------------
// Effect-native OTLP telemetry
// ---------------------------------------------------------------------------

import * as Cloudflare from "alchemy/Cloudflare/Workers/Runtime";
import { Effect, Layer } from "effect";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as OtlpSerialization from "effect/unstable/observability/OtlpSerialization";
import * as OtlpTracer from "effect/unstable/observability/OtlpTracer";

const SERVICE_NAME = "executor-cloud";
const SERVICE_VERSION = "1.0.0";
const DEFAULT_TRACES_URL = "https://api.axiom.co/v1/traces";
const DEFAULT_DATASET = "executor-cloud";

const tracers = new Map<string, Tracer.Tracer>();

const telemetryKey = (env: Env): string =>
  [
    env.AXIOM_TRACES_URL ?? DEFAULT_TRACES_URL,
    env.AXIOM_DATASET ?? DEFAULT_DATASET,
    env.AXIOM_TRACES_SAMPLE_RATIO ?? "",
    env.AXIOM_TOKEN ?? "",
  ].join("\n");

const sampleRatio = (value: string | undefined): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
};

const makeTracer = (env: Env): Tracer.Tracer =>
  Effect.runSync(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const ratio = sampleRatio(env.AXIOM_TRACES_SAMPLE_RATIO);
      const tracer = yield* OtlpTracer.make({
        url: env.AXIOM_TRACES_URL ?? DEFAULT_TRACES_URL,
        headers: {
          Authorization: `Bearer ${env.AXIOM_TOKEN}`,
          "X-Axiom-Dataset": env.AXIOM_DATASET ?? DEFAULT_DATASET,
        },
        resource: {
          serviceName: SERVICE_NAME,
          serviceVersion: SERVICE_VERSION,
        },
        exportInterval: "1 second",
        shutdownTimeout: "3 seconds",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Scope.Scope, scope),
            FetchHttpClient.layer,
            OtlpSerialization.layerJson,
          ),
        ),
      );
      return Tracer.make({
        ...tracer,
        span: (options) => {
          const parent = Option.getOrUndefined(options.parent);
          const sampled = parent ? parent.sampled : Math.random() < ratio;
          return tracer.span({
            ...options,
            sampled: options.sampled && sampled,
          });
        },
      });
    }),
  );

const getTracer = (env: Env): Tracer.Tracer => {
  const key = telemetryKey(env);
  const existing = tracers.get(key);
  if (existing) return existing;
  const tracer = makeTracer(env);
  tracers.set(key, tracer);
  return tracer;
};

export const TelemetryLive: Layer.Layer<never, never, Cloudflare.WorkerEnvironment> = Layer.unwrap(
  Effect.gen(function* () {
    const env = yield* Cloudflare.WorkerEnvironment.typed<Env>();
    if (!env.AXIOM_TOKEN || sampleRatio(env.AXIOM_TRACES_SAMPLE_RATIO) <= 0) {
      return Layer.empty;
    }
    return Layer.succeed(Tracer.Tracer, getTracer(env));
  }),
);

export const DoTelemetryLive = TelemetryLive;
