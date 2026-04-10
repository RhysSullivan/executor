import { Effect } from "effect";

export interface GracefulStopOptions {
  readonly signalDelayMs?: number;
  readonly killAfterMs?: number;
  readonly signals?: readonly NodeJS.Signals[];
}

const DEFAULT_SIGNAL_DELAY_MS = 500;
const DEFAULT_KILL_AFTER_MS = 5_000;
const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sendSignal = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(pid, signal);
  } catch {
    // The process may have exited between checks. Stop attempts are best-effort.
  }
};

export const gracefulStopPid = (
  pid: number,
  opts: GracefulStopOptions = {},
): Effect.Effect<void, never> =>
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
