import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import * as PlatformError from "@effect/platform/Error";
import * as PlatformPath from "@effect/platform/Path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  canonicalDaemonHost,
  isPidAlive,
  readDaemonRecord,
  removeDaemonRecord,
  writeDaemonRecord,
} from "../apps/cli/src/daemon-state";

const fileSystemError = (method: string, cause: unknown) =>
  new PlatformError.SystemError({
    module: "FileSystem",
    method,
    reason: "Unknown",
    description: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const fileSystemLayer = FileSystem.layerNoop({
  makeDirectory: (path, options) =>
    Effect.tryPromise({
      try: () => mkdir(path, { recursive: options?.recursive, mode: options?.mode }),
      catch: (cause) => fileSystemError("makeDirectory", cause),
    }),
  writeFileString: (path, data, _options) =>
    Effect.tryPromise({
      try: () => writeFile(path, data, "utf8"),
      catch: (cause) => fileSystemError("writeFileString", cause),
    }),
  readFileString: (path, encoding = "utf8") =>
    Effect.tryPromise({
      try: () => readFile(path, { encoding: encoding as BufferEncoding }),
      catch: (cause) => fileSystemError("readFileString", cause),
    }),
  remove: (path, options) =>
    Effect.tryPromise({
      try: () => rm(path, { recursive: options?.recursive ?? false, force: options?.force ?? false }),
      catch: (cause) => fileSystemError("remove", cause),
    }),
});

const daemonStateLayer = Layer.merge(fileSystemLayer, PlatformPath.layer);

const withDaemonDataDir = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | PlatformPath.Path>) =>
  Effect.gen(function* () {
    const prev = process.env.EXECUTOR_DATA_DIR;
    const dir = mkdtempSync(join(tmpdir(), "executor-daemon-state-test-"));
    process.env.EXECUTOR_DATA_DIR = dir;

    try {
      return yield* effect;
    } finally {
      if (prev === undefined) {
        delete process.env.EXECUTOR_DATA_DIR;
      } else {
        process.env.EXECUTOR_DATA_DIR = prev;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(daemonStateLayer));

describe("daemon state", () => {
  it("normalizes local host aliases", () => {
    expect(canonicalDaemonHost("localhost")).toBe("localhost");
    expect(canonicalDaemonHost("127.0.0.1")).toBe("localhost");
    expect(canonicalDaemonHost("::1")).toBe("localhost");
    expect(canonicalDaemonHost("0.0.0.0")).toBe("localhost");
    expect(canonicalDaemonHost("api.example.com")).toBe("api.example.com");
  });

  it.effect("writes, reads, and removes daemon records", () =>
    withDaemonDataDir(
      Effect.gen(function* () {
        yield* writeDaemonRecord({
          hostname: "127.0.0.1",
          port: 4788,
          pid: 12345,
          scopeDir: "/tmp/scope",
        });

        const stored = yield* readDaemonRecord({ hostname: "localhost", port: 4788 });
        expect(stored).toEqual({
          version: 1,
          hostname: "localhost",
          port: 4788,
          pid: 12345,
          startedAt: expect.any(String),
          scopeDir: "/tmp/scope",
        });

        yield* removeDaemonRecord({ hostname: "localhost", port: 4788 });
        const after = yield* readDaemonRecord({ hostname: "localhost", port: 4788 });
        expect(after).toBeNull();
      }),
    ),
  );

  it("detects live and invalid pids", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(-1)).toBe(false);
  });
});
