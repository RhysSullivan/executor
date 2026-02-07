"use client";

import { useEffect, useState, useCallback, useRef } from "react";

interface UsePollOptions<T> {
  fetcher: () => Promise<T>;
  interval?: number;
  enabled?: boolean;
}

interface UsePollResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function usePoll<T>({
  fetcher,
  interval = 4000,
  enabled = true,
}: UsePollOptions<T>): UsePollResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fetch failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    refresh();
    const timer = setInterval(refresh, interval);
    return () => clearInterval(timer);
  }, [enabled, interval, refresh]);

  return { data, loading, error, refresh };
}
