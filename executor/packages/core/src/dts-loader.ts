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

export async function loadSourceDtsByUrl(
  dtsUrls: Record<string, string>,
): Promise<Record<string, string>> {
  const entries = Object.entries(dtsUrls);
  if (entries.length === 0) {
    return {};
  }

  const results = await Promise.all(entries.map(async ([sourceKey, url]) => {
    if (!url) return [sourceKey, null] as const;
    return [sourceKey, await fetchDtsText(url)] as const;
  }));

  const sourceDtsBySource: Record<string, string> = {};
  for (const [sourceKey, dts] of results) {
    if (dts) {
      sourceDtsBySource[sourceKey] = dts;
    }
  }
  return sourceDtsBySource;
}
