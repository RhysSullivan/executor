// This CommonJS entry is a deliberate SUBSET of the package surface.
// Electron's main process `require()`s it for the readiness + process
// primitives only (gracefulStopPid, pollReadiness, isReachable, isPidAlive,
// ReadinessTimeout). The higher-level `PlatformSupervisor` interface,
// `makeServiceCommand`, and `makeServiceToolsPlugin` are ESM-only: they are
// only consumed by `apps/cli` and `apps/local`, both of which use ES modules.
// If a future Electron consumer needs them, add them here — but until then
// the subset keeps the handwritten CJS file minimal.

const { Effect, Data } = require("effect");

class ReadinessTimeout extends Data.TaggedError("ReadinessTimeout") {}

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const DEFAULT_SIGNAL_DELAY_MS = 500;
const DEFAULT_KILL_AFTER_MS = 5000;
const DEFAULT_SIGNALS = ["SIGTERM", "SIGINT"];

const sleepEffect = (ms) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));

const isReachable = (url, opts = {}) =>
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

const pollReadiness = (url, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const start = Date.now();

  const loop = (attempts) =>
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

      yield* sleepEffect(Math.min(intervalMs, timeoutMs - elapsedMs));
      return yield* loop(nextAttempts);
    });

  return loop(0);
};

const isPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sendSignal = (pid, signal) => {
  try {
    process.kill(pid, signal);
  } catch {
    // Best-effort shutdown.
  }
};

const gracefulStopPid = (pid, opts = {}) =>
  Effect.promise(async () => {
    if (!isPidAlive(pid)) return;

    const signals = opts.signals ?? DEFAULT_SIGNALS;
    const signalDelayMs = opts.signalDelayMs ?? DEFAULT_SIGNAL_DELAY_MS;
    const killAfterMs = opts.killAfterMs ?? DEFAULT_KILL_AFTER_MS;
    const startedAt = Date.now();

    for (const signal of signals) {
      sendSignal(pid, signal);
      await sleep(signalDelayMs);
      if (!isPidAlive(pid)) return;
      if (Date.now() - startedAt >= killAfterMs) break;
    }

    const remainingMs = killAfterMs - (Date.now() - startedAt);
    if (remainingMs > 0) {
      await sleep(remainingMs);
    }

    if (isPidAlive(pid)) {
      sendSignal(pid, "SIGKILL");
    }
  }).pipe(Effect.orElseSucceed(() => undefined));

module.exports = {
  ReadinessTimeout,
  gracefulStopPid,
  isPidAlive,
  isReachable,
  pollReadiness,
};
