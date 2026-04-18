import { homedir } from "node:os";
import { FileSystem, Path } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import * as Effect from "effect/Effect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonRecord {
  readonly version: 1;
  readonly hostname: string;
  readonly port: number;
  readonly pid: number;
  readonly startedAt: string;
  readonly scopeDir: string | null;
}

// ---------------------------------------------------------------------------
// Host normalization
// ---------------------------------------------------------------------------

const LOCAL_HOST_ALIASES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export const canonicalDaemonHost = (hostname: string): string => {
  const normalized = hostname.trim().toLowerCase();
  return LOCAL_HOST_ALIASES.has(normalized) ? "localhost" : normalized;
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const resolveDaemonDataDir = (path: Path.Path): string =>
  process.env.EXECUTOR_DATA_DIR ?? path.join(homedir(), ".executor");

const sanitizeHostForPath = (hostname: string): string => hostname.replaceAll(/[^a-z0-9.-]+/gi, "_");

const daemonRecordPath = (path: Path.Path, input: { hostname: string; port: number }): string => {
  const host = sanitizeHostForPath(canonicalDaemonHost(input.hostname));
  return path.join(resolveDaemonDataDir(path), `daemon-${host}-${input.port}.json`);
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const writeDaemonRecord = (input: {
  hostname: string;
  port: number;
  pid: number;
  scopeDir: string | null;
}): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dataDir = resolveDaemonDataDir(path);

    yield* fs.makeDirectory(dataDir, { recursive: true });

    const payload: DaemonRecord = {
      version: 1,
      hostname: canonicalDaemonHost(input.hostname),
      port: input.port,
      pid: input.pid,
      startedAt: new Date().toISOString(),
      scopeDir: input.scopeDir,
    };

    yield* fs.writeFileString(
      daemonRecordPath(path, { hostname: input.hostname, port: input.port }),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  });

const parseRecord = (raw: string): DaemonRecord | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    (parsed as { version?: unknown }).version !== 1
  ) {
    return null;
  }

  const r = parsed as Record<string, unknown>;
  if (
    typeof r.hostname !== "string" ||
    typeof r.port !== "number" ||
    typeof r.pid !== "number" ||
    typeof r.startedAt !== "string" ||
    !(typeof r.scopeDir === "string" || r.scopeDir === null)
  ) {
    return null;
  }

  return {
    version: 1,
    hostname: canonicalDaemonHost(r.hostname),
    port: r.port,
    pid: r.pid,
    startedAt: r.startedAt,
    scopeDir: r.scopeDir,
  };
};

export const readDaemonRecord = (input: {
  hostname: string;
  port: number;
}): Effect.Effect<DaemonRecord | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs.readFileString(daemonRecordPath(path, input)).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );
    if (raw === null) return null;
    return parseRecord(raw);
  });

export const removeDaemonRecord = (input: {
  hostname: string;
  port: number;
}): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.remove(daemonRecordPath(path, input), { force: true });
  });

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

export const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const terminatePid = (pid: number): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => {
      process.kill(pid, "SIGTERM");
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(`Failed to terminate pid ${pid}: ${String(cause)}`),
  });
