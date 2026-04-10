import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { Effect } from "effect";

const launchdMocks = vi.hoisted(() => ({
  getGuiDomain: vi.fn(() => "gui/501"),
  launchctl: vi.fn(),
  parseLaunchdPid: vi.fn((output: string) => {
    const match = output.match(/\bpid\s*=\s*(\d+)\b/);
    return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
  }),
}));

vi.mock("./launchctl.js", () => launchdMocks);

import { installAgent, printAgent, startAgent, stopAgent } from "./supervisor";

const originalPlatform = process.platform;

const setPlatform = (platform: NodeJS.Platform) => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
};

beforeEach(() => {
  setPlatform("darwin");
  launchdMocks.getGuiDomain.mockReturnValue("gui/501");
  launchdMocks.launchctl.mockReset();
  launchdMocks.launchctl.mockReturnValue(Effect.succeed({ stdout: "", stderr: "", code: 0 }));
  launchdMocks.parseLaunchdPid.mockClear();
  vi.unstubAllGlobals();
});

afterEach(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: originalPlatform,
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const makeTempPaths = async () => {
  const dir = await mkdtemp(join(tmpdir(), "executor-launchd-test-"));
  return {
    dir,
    plistPath: join(dir, "test.executor.daemon.plist"),
    logPath: join(dir, "daemon.log"),
  };
};

describe("installAgent", () => {
  it.effect("writes a plist, bootstraps, kickstarts, and waits for readiness", () =>
    Effect.gen(function* () {
      const paths = yield* Effect.promise(makeTempPaths);
      let fetchCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          fetchCalls += 1;
          return Promise.resolve(new Response(null, { status: fetchCalls === 1 ? 503 : 204 }));
        }),
      );

      const result = yield* installAgent({
        label: "test.executor.daemon",
        plistPath: paths.plistPath,
        logPath: paths.logPath,
        port: 4999,
        readinessTimeoutMs: 50,
        programArgs: ["web", "--port", "4999"],
      });

      const plist = yield* Effect.promise(() => readFile(paths.plistPath, "utf8"));

      expect(result.url).toBe("http://127.0.0.1:4999/api/scope");
      expect(plist).toContain("<string>test.executor.daemon</string>");
      expect(plist).toContain("<string>web</string>");
      expect(plist).toContain("<string>4999</string>");
      expect(launchdMocks.launchctl).toHaveBeenCalledWith(["bootout", "gui/501", paths.plistPath]);
      expect(launchdMocks.launchctl).toHaveBeenCalledWith([
        "bootstrap",
        "gui/501",
        paths.plistPath,
      ]);
      expect(launchdMocks.launchctl).toHaveBeenCalledWith([
        "kickstart",
        "-k",
        "gui/501/test.executor.daemon",
      ]);

      yield* Effect.promise(() => rm(paths.dir, { recursive: true, force: true }));
    }),
  );

  it.effect("skips kickstart when the target URL is already reachable", () =>
    Effect.gen(function* () {
      const paths = yield* Effect.promise(makeTempPaths);
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
      );

      yield* installAgent({
        label: "test.executor.daemon",
        plistPath: paths.plistPath,
        logPath: paths.logPath,
        readinessTimeoutMs: 50,
        programArgs: ["web"],
      });

      expect(launchdMocks.launchctl).not.toHaveBeenCalledWith([
        "kickstart",
        "-k",
        "gui/501/test.executor.daemon",
      ]);

      yield* Effect.promise(() => rm(paths.dir, { recursive: true, force: true }));
    }),
  );

  it.effect("rolls back bootstrapped service on readiness timeout", () =>
    Effect.gen(function* () {
      const paths = yield* Effect.promise(makeTempPaths);
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))),
      );

      const error = yield* Effect.flip(
        installAgent({
          label: "test.executor.daemon",
          plistPath: paths.plistPath,
          logPath: paths.logPath,
          readinessTimeoutMs: 3,
          programArgs: ["web"],
        }),
      );

      expect(error._tag).toBe("LaunchdReadinessTimeout");
      expect(
        launchdMocks.launchctl.mock.calls.filter(
          ([args]) => Array.isArray(args) && args[0] === "bootout",
        ),
      ).toHaveLength(2);

      yield* Effect.promise(() => rm(paths.dir, { recursive: true, force: true }));
    }),
  );

  it.effect("fails when bootstrap fails", () =>
    Effect.gen(function* () {
      const paths = yield* Effect.promise(makeTempPaths);
      launchdMocks.launchctl.mockImplementation((args: readonly string[]) =>
        Effect.succeed(
          args[0] === "bootstrap"
            ? { stdout: "", stderr: "bootstrap failed", code: 5 }
            : { stdout: "", stderr: "", code: 0 },
        ),
      );

      const error = yield* Effect.flip(
        installAgent({
          label: "test.executor.daemon",
          plistPath: paths.plistPath,
          logPath: paths.logPath,
          programArgs: ["web"],
        }),
      );

      expect(error._tag).toBe("LaunchdBootstrapFailed");
      if (error._tag === "LaunchdBootstrapFailed") {
        expect(error.stderr).toBe("bootstrap failed");
      }

      yield* Effect.promise(() => rm(paths.dir, { recursive: true, force: true }));
    }),
  );
});

describe("agent operations", () => {
  it.effect("prints status", () =>
    Effect.gen(function* () {
      const paths = yield* Effect.promise(makeTempPaths);
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
      );
      launchdMocks.launchctl.mockReturnValue(
        Effect.succeed({ stdout: "pid = 42", stderr: "", code: 0 }),
      );

      const status = yield* printAgent({
        label: "test.executor.daemon",
        plistPath: paths.plistPath,
        logPath: paths.logPath,
      });

      expect(status.running).toBe(true);
      expect(status.pid).toBe(42);
      expect(status.reachable).toBe(true);
      expect(status.installed).toBe(false);

      yield* Effect.promise(() => rm(paths.dir, { recursive: true, force: true }));
    }),
  );

  it.effect("startAgent reloads the plist and waits for readiness", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
      );

      yield* startAgent({
        label: "test.executor.daemon",
        plistPath: "/tmp/test.executor.daemon.plist",
        readinessTimeoutMs: 50,
      });

      expect(launchdMocks.launchctl).toHaveBeenCalledWith([
        "bootout",
        "gui/501",
        "/tmp/test.executor.daemon.plist",
      ]);
      expect(launchdMocks.launchctl).toHaveBeenCalledWith([
        "bootstrap",
        "gui/501",
        "/tmp/test.executor.daemon.plist",
      ]);
      expect(launchdMocks.launchctl).toHaveBeenCalledWith([
        "kickstart",
        "-k",
        "gui/501/test.executor.daemon",
      ]);
    }),
  );

  it.effect("stopAgent gracefully stops the pid before bootout", () =>
    Effect.gen(function* () {
      let alive = true;
      const signals: Array<string | number | undefined> = [];
      vi.spyOn(process, "kill").mockImplementation(((_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGTERM") alive = false;
        if (signal === 0 && !alive) throw new Error("not found");
        return true;
      }) as typeof process.kill);
      launchdMocks.launchctl.mockImplementation((args: readonly string[]) =>
        Effect.succeed(
          args[0] === "print"
            ? { stdout: "pid = 42", stderr: "", code: 0 }
            : { stdout: "", stderr: "", code: 0 },
        ),
      );

      yield* stopAgent({
        label: "test.executor.daemon",
        plistPath: "/tmp/test.executor.daemon.plist",
      });

      expect(signals.filter((signal) => signal !== 0)).toContain("SIGTERM");
      expect(launchdMocks.launchctl).toHaveBeenCalledWith([
        "bootout",
        "gui/501",
        "/tmp/test.executor.daemon.plist",
      ]);
    }),
  );
});
