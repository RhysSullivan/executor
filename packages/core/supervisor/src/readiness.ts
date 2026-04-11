import { Effect } from "effect";

import { ReadinessTimeout } from "./errors.js";

export interface ReachabilityOptions {
  readonly probeTimeoutMs?: number;
  readonly headers?: Record<string, string>;
}

export interface ReadinessOptions extends ReachabilityOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

const sleep = (ms: number): Effect.Effect<void> =>
  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));

export const isReachable = (
  url: string,
  opts: ReachabilityOptions = {},
): Effect.Effect<boolean, never> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        headers: opts.headers,
        signal: AbortSignal.timeout(opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
      });
      return response.ok;
    },
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false));

export const pollReadiness = (
  url: string,
  opts: ReadinessOptions = {},
): Effect.Effect<void, ReadinessTimeout> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const start = Date.now();

  const loop = (attempts: number): Effect.Effect<void, ReadinessTimeout> =>
    Effect.gen(function* () {
      const reachable = yield* isReachable(url, opts);
      const nextAttempts = attempts + 1;
      if (reachable) return;

      const elapsedMs = Date.now() - start;
      if (elapsedMs >= timeoutMs) {
        return yield* new ReadinessTimeout({
          url,
          elapsedMs,
          attempts: nextAttempts,
        });
      }

      yield* sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
      return yield* loop(nextAttempts);
    });

  return loop(0);
};
