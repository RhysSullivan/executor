import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { Effect } from "effect";

import { gracefulStopPid, isPidAlive } from "./process";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isPidAlive", () => {
  it("returns true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false when signal 0 throws", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("not found");
    });

    expect(isPidAlive(999_999_999)).toBe(false);
  });
});

describe("gracefulStopPid", () => {
  it.effect("sends graceful signals before SIGKILL when process remains alive", () =>
    Effect.gen(function* () {
      const signals: Array<string | number | undefined> = [];
      vi.spyOn(process, "kill").mockImplementation(((_pid, signal) => {
        signals.push(signal);
        return true;
      }) as typeof process.kill);

      yield* gracefulStopPid(1234, {
        signals: ["SIGTERM", "SIGINT"],
        signalDelayMs: 1,
        killAfterMs: 3,
      });

      expect(signals.filter((signal) => signal !== 0)).toEqual(["SIGTERM", "SIGINT", "SIGKILL"]);
    }),
  );

  it.effect("returns after the process exits from a graceful signal", () =>
    Effect.gen(function* () {
      let alive = true;
      const signals: Array<string | number | undefined> = [];
      vi.spyOn(process, "kill").mockImplementation(((_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGTERM") alive = false;
        if (signal === 0 && !alive) throw new Error("not found");
        return true;
      }) as typeof process.kill);

      yield* gracefulStopPid(1234, {
        signals: ["SIGTERM", "SIGINT"],
        signalDelayMs: 1,
        killAfterMs: 10,
      });

      expect(signals.filter((signal) => signal !== 0)).toEqual(["SIGTERM"]);
    }),
  );

  it.effect("returns immediately if the process is already dead", () =>
    Effect.gen(function* () {
      const signals: Array<string | number | undefined> = [];
      vi.spyOn(process, "kill").mockImplementation(((_pid, signal) => {
        signals.push(signal);
        if (signal === 0) throw new Error("not found");
        return true;
      }) as typeof process.kill);

      yield* gracefulStopPid(1234, {
        signalDelayMs: 1,
        killAfterMs: 1,
      });

      expect(signals).toEqual([0]);
    }),
  );

  it.effect("never fails when signal delivery throws", () =>
    Effect.gen(function* () {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("permission denied");
      });

      yield* gracefulStopPid(1234, {
        signalDelayMs: 1,
        killAfterMs: 1,
      });
    }),
  );
});
