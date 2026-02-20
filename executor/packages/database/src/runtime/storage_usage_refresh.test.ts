import { afterEach, describe, expect, test } from "bun:test";
import {
  getStorageUsageRefreshStats,
  resetStorageUsageRefreshForTests,
  shouldRefreshStorageUsage,
} from "./storage_usage_refresh";

describe("storage usage refresh throttling", () => {
  afterEach(() => {
    resetStorageUsageRefreshForTests();
  });

  test("refreshes first touch then throttles within interval", () => {
    const first = shouldRefreshStorageUsage("inst_1", { now: 1_000, intervalMs: 5_000 });
    const second = shouldRefreshStorageUsage("inst_1", { now: 2_000, intervalMs: 5_000 });
    const third = shouldRefreshStorageUsage("inst_1", { now: 6_500, intervalMs: 5_000 });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(true);
  });

  test("reset clears in-memory refresh history", () => {
    expect(shouldRefreshStorageUsage("inst_2", { now: 100 })).toBe(true);
    expect(shouldRefreshStorageUsage("inst_2", { now: 200, intervalMs: 10_000 })).toBe(false);

    resetStorageUsageRefreshForTests();

    expect(shouldRefreshStorageUsage("inst_2", { now: 300, intervalMs: 10_000 })).toBe(true);
  });

  test("tracks refresh and throttle stats", () => {
    expect(shouldRefreshStorageUsage("inst_a", { now: 10, intervalMs: 5_000 })).toBe(true);
    expect(shouldRefreshStorageUsage("inst_a", { now: 20, intervalMs: 5_000 })).toBe(false);
    expect(shouldRefreshStorageUsage("inst_b", { now: 30, intervalMs: 5_000 })).toBe(true);

    expect(getStorageUsageRefreshStats()).toEqual({
      checks: 3,
      refreshed: 2,
      throttled: 1,
      evicted: 0,
      trackedInstances: 2,
    });
  });

  test("evicts stale instance refresh records during periodic sweeps", () => {
    expect(shouldRefreshStorageUsage("inst_old", {
      now: 1_000,
      intervalMs: 1_000,
      staleMultiplier: 2,
      sweepEveryChecks: 2,
    })).toBe(true);

    expect(shouldRefreshStorageUsage("inst_new", {
      now: 1_500,
      intervalMs: 1_000,
      staleMultiplier: 2,
      sweepEveryChecks: 2,
    })).toBe(true);

    expect(shouldRefreshStorageUsage("inst_trigger", {
      now: 3_200,
      intervalMs: 1_000,
      staleMultiplier: 2,
      sweepEveryChecks: 2,
    })).toBe(true);

    expect(shouldRefreshStorageUsage("inst_trigger", {
      now: 3_201,
      intervalMs: 1_000,
      staleMultiplier: 2,
      sweepEveryChecks: 2,
    })).toBe(false);

    expect(getStorageUsageRefreshStats()).toEqual({
      checks: 4,
      refreshed: 3,
      throttled: 1,
      evicted: 1,
      trackedInstances: 2,
    });
  });
});
