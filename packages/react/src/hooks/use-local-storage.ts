import * as React from "react";

// ---------------------------------------------------------------------------
// useLocalStorage — minimal JSON-backed persistent state hook
// ---------------------------------------------------------------------------
//
// SSR-safe (reads lazily from `window.localStorage` inside useEffect so it
// works with TanStack Start's hydration). Writes on every state change.
// Falls back to the initial value when parsing fails or localStorage is
// unavailable (private browsing, quota exceeded, etc.).

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
): readonly [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = React.useState<T>(initialValue);
  const [isHydrated, setIsHydrated] = React.useState(false);

  // Hydrate from localStorage on mount. Done in a one-shot effect so the
  // initial SSR render matches the client default, then swaps in the
  // stored value on the first client tick.
  React.useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored !== null) {
        setValue(JSON.parse(stored) as T);
      }
    } catch {
      // Parse error or localStorage unavailable — keep initial value.
    }
    setIsHydrated(true);
  }, [key]);

  const setPersistedValue = React.useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        if (isHydrated) {
          try {
            window.localStorage.setItem(key, JSON.stringify(resolved));
          } catch {
            // Quota exceeded or localStorage unavailable — state still
            // updates in memory.
          }
        }
        return resolved;
      });
    },
    [key, isHydrated],
  );

  return [value, setPersistedValue] as const;
}
