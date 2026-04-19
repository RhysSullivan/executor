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
  acquireDaemonStartLock,
  canonicalDaemonHost,
  currentDaemonScopeId,
  isPidAlive,
  readDaemonPointer,
  readDaemonRecord,
  releaseDaemonStartLock,
  removeDaemonPointer,
  removeDaemonRecord,
  writeDaemonPointer,
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
  writeFileString: (path, data, options) =>
    Effect.tryPromise({
      try: () => writeFile(path, data, { encoding: "utf8", flag: options?.flag }),
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

  it.effect("writes, reads, and removes daemon pointers", () =>
    withDaemonDataDir(
      Effect.gen(function* () {
        yield* writeDaemonPointer({
          hostname: "127.0.0.1",
          port: 5799,
          pid: 24680,
          scopeId: "scope:/tmp/project",
          scopeDir: "/tmp/project",
          token: "tok_123",
        });

        const stored = yield* readDaemonPointer({
          hostname: "localhost",
          scopeId: "scope:/tmp/project",
        });
        expect(stored).toEqual({
          version: 1,
          hostname: "localhost",
          port: 5799,
          pid: 24680,
          startedAt: expect.any(String),
          scopeId: "scope:/tmp/project",
          scopeDir: "/tmp/project",
          token: "tok_123",
        });

        yield* removeDaemonPointer({
          hostname: "localhost",
          scopeId: "scope:/tmp/project",
        });
        const after = yield* readDaemonPointer({
          hostname: "localhost",
          scopeId: "scope:/tmp/project",
        });
        expect(after).toBeNull();
      }),
    ),
  );

  it.effect("serializes daemon startup with lock files", () =>
    withDaemonDataDir(
      Effect.gen(function* () {
        const lock = yield* acquireDaemonStartLock({
          hostname: "localhost",
          scopeId: "scope:/tmp/project",
        });

        const second = yield* acquireDaemonStartLock({
          hostname: "localhost",
          scopeId: "scope:/tmp/project",
        }).pipe(Effect.flip);

        expect(second.message).toContain("already in progress");

        yield* releaseDaemonStartLock(lock);

        const third = yield* acquireDaemonStartLock({
          hostname: "localhost",
          scopeId: "scope:/tmp/project",
        });
        yield* releaseDaemonStartLock(third);
      }),
    ),
  );

  it("derives scope id from EXECUTOR_SCOPE_DIR or cwd", () => {
    const prev = process.env.EXECUTOR_SCOPE_DIR;
    process.env.EXECUTOR_SCOPE_DIR = "/tmp/explicit-scope";
    expect(currentDaemonScopeId()).toBe("scope:/tmp/explicit-scope");

    if (prev === undefined) {
      delete process.env.EXECUTOR_SCOPE_DIR;
    } else {
      process.env.EXECUTOR_SCOPE_DIR = prev;
    }

    expect(currentDaemonScopeId()).toContain("cwd:");
  });

  it("detects live and invalid pids", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(-1)).toBe(false);
  });
});
