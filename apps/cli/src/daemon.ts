import { spawn } from "node:child_process";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedDaemonBaseUrl {
  readonly hostname: string;
  readonly port: number;
}

export interface DaemonSpawnSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Base URL parsing
// ---------------------------------------------------------------------------

export const parseDaemonBaseUrl = (baseUrl: string, defaultPort: number): ParsedDaemonBaseUrl => {
  const parsed = new URL(baseUrl);

  if (parsed.protocol !== "http:") {
    throw new Error(`Only http:// base URLs are supported for daemon auto-start: ${baseUrl}`);
  }

  const port = Number(parsed.port) || defaultPort;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid daemon port in base URL: ${baseUrl}`);
  }

  return {
    hostname: parsed.hostname || "localhost",
    port,
  };
};

// ---------------------------------------------------------------------------
// Local-host checks
// ---------------------------------------------------------------------------

const LOCAL_DAEMON_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export const canAutoStartLocalDaemonForHost = (hostname: string): boolean =>
  LOCAL_DAEMON_HOSTNAMES.has(hostname.toLowerCase());

// ---------------------------------------------------------------------------
// Process spec
// ---------------------------------------------------------------------------

export const buildDaemonSpawnSpec = (input: {
  readonly port: number;
  readonly hostname: string;
  readonly isDevMode: boolean;
  readonly scriptPath: string | undefined;
  readonly executablePath: string;
}): DaemonSpawnSpec => {
  const daemonArgs = ["daemon", "run", "--port", String(input.port), "--hostname", input.hostname];

  if (input.isDevMode) {
    if (!input.scriptPath) {
      throw new Error("Cannot auto-start daemon in dev mode without a CLI script path");
    }
    return {
      command: "bun",
      args: ["run", input.scriptPath, ...daemonArgs],
    };
  }

  return {
    command: input.executablePath,
    args: daemonArgs,
  };
};

// ---------------------------------------------------------------------------
// Spawn + wait
// ---------------------------------------------------------------------------

export const spawnDetached = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined>;
}): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => {
      const child = spawn(input.command, [...input.args], {
        detached: true,
        stdio: "ignore",
        env: input.env,
      });
      child.unref();
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`Failed to spawn daemon process: ${String(cause)}`),
  });

const waitForCondition = <E, R>(input: {
  readonly check: Effect.Effect<boolean, E, R>;
  readonly expected: boolean;
  readonly timeoutMs: number;
  readonly intervalMs: number;
}): Effect.Effect<boolean, E, R> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    while (true) {
      const reachable = yield* input.check;
      if (reachable === input.expected) return true;

      const now = yield* Clock.currentTimeMillis;
      if (now - startedAt >= input.timeoutMs) return false;

      yield* Effect.sleep(input.intervalMs);
    }
  });

export const waitForReachable = <E, R>(input: {
  readonly check: Effect.Effect<boolean, E, R>;
  readonly timeoutMs: number;
  readonly intervalMs: number;
}): Effect.Effect<boolean, E, R> =>
  waitForCondition({
    check: input.check,
    expected: true,
    timeoutMs: input.timeoutMs,
    intervalMs: input.intervalMs,
  });

export const waitForUnreachable = <E, R>(input: {
  readonly check: Effect.Effect<boolean, E, R>;
  readonly timeoutMs: number;
  readonly intervalMs: number;
}): Effect.Effect<boolean, E, R> =>
  waitForCondition({
    check: input.check,
    expected: false,
    timeoutMs: input.timeoutMs,
    intervalMs: input.intervalMs,
  });
