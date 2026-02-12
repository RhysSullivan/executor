const DEFAULT_DTS_CACHE_TTL_MS = 5 * 60_000;

interface DtsCacheEntry {
  expiresAt: number;
  promise: Promise<string | null>;
}

const dtsUrlCache = new Map<string, DtsCacheEntry>();

async function fetchDtsText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[executor] failed to fetch source .d.ts from ${url}: HTTP ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (error) {
    console.warn(
      `[executor] failed to fetch source .d.ts from ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function getCachedDtsPromise(url: string, ttlMs: number): Promise<string | null> {
  const now = Date.now();
  const cached = dtsUrlCache.get(url);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = fetchDtsText(url).catch(() => null);
  dtsUrlCache.set(url, {
    expiresAt: now + Math.max(1, ttlMs),
    promise,
  });
  return promise;
}

export async function loadSourceDtsByUrlCached(
  dtsUrls: Record<string, string>,
  options?: { ttlMs?: number },
): Promise<Record<string, string>> {
  const entries = Object.entries(dtsUrls);
  if (entries.length === 0) {
    return {};
  }

  const ttlMs = options?.ttlMs ?? DEFAULT_DTS_CACHE_TTL_MS;
  const results = await Promise.all(entries.map(async ([sourceKey, url]) => {
    if (!url) return [sourceKey, null] as const;
    return [sourceKey, await getCachedDtsPromise(url, ttlMs)] as const;
  }));

  const sourceDtsBySource: Record<string, string> = {};
  for (const [sourceKey, dts] of results) {
    if (dts) {
      sourceDtsBySource[sourceKey] = dts;
    }
  }
  return sourceDtsBySource;
}

export function clearDtsUrlCache(): void {
  dtsUrlCache.clear();
}
