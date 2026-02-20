const DEFAULT_STORAGE_USAGE_REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_STALE_MULTIPLIER = 10;
const DEFAULT_SWEEP_EVERY_CHECKS = 200;

const usageRefreshByInstanceId = new Map<string, number>();
let checksSinceSweep = 0;

type StorageUsageRefreshStats = {
  checks: number;
  refreshed: number;
  throttled: number;
  evicted: number;
};

const usageRefreshStats: StorageUsageRefreshStats = {
  checks: 0,
  refreshed: 0,
  throttled: 0,
  evicted: 0,
};

function sweepStaleEntries(now: number, intervalMs: number, staleMultiplier: number): void {
  const maxAgeMs = intervalMs * staleMultiplier;
  for (const [instanceId, lastRefreshedAt] of usageRefreshByInstanceId.entries()) {
    if (now - lastRefreshedAt >= maxAgeMs) {
      usageRefreshByInstanceId.delete(instanceId);
      usageRefreshStats.evicted += 1;
    }
  }
}

export function shouldRefreshStorageUsage(
  instanceId: string,
  args?: {
    now?: number;
    intervalMs?: number;
    staleMultiplier?: number;
    sweepEveryChecks?: number;
  },
): boolean {
  usageRefreshStats.checks += 1;
  checksSinceSweep += 1;

  const now = args?.now ?? Date.now();
  const intervalMs = Math.max(1_000, Math.floor(args?.intervalMs ?? DEFAULT_STORAGE_USAGE_REFRESH_INTERVAL_MS));
  const staleMultiplier = Math.max(2, Math.floor(args?.staleMultiplier ?? DEFAULT_STALE_MULTIPLIER));
  const sweepEveryChecks = Math.max(1, Math.floor(args?.sweepEveryChecks ?? DEFAULT_SWEEP_EVERY_CHECKS));
  if (checksSinceSweep >= sweepEveryChecks) {
    sweepStaleEntries(now, intervalMs, staleMultiplier);
    checksSinceSweep = 0;
  }

  const lastRefreshedAt = usageRefreshByInstanceId.get(instanceId);

  if (typeof lastRefreshedAt === "number" && now - lastRefreshedAt < intervalMs) {
    usageRefreshStats.throttled += 1;
    return false;
  }

  usageRefreshByInstanceId.set(instanceId, now);
  usageRefreshStats.refreshed += 1;
  return true;
}

export function getStorageUsageRefreshStats(): StorageUsageRefreshStats & { trackedInstances: number } {
  return {
    checks: usageRefreshStats.checks,
    refreshed: usageRefreshStats.refreshed,
    throttled: usageRefreshStats.throttled,
    evicted: usageRefreshStats.evicted,
    trackedInstances: usageRefreshByInstanceId.size,
  };
}

export function resetStorageUsageRefreshForTests() {
  usageRefreshByInstanceId.clear();
  checksSinceSweep = 0;
  usageRefreshStats.checks = 0;
  usageRefreshStats.refreshed = 0;
  usageRefreshStats.throttled = 0;
  usageRefreshStats.evicted = 0;
}
