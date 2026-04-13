import * as React from "react";

export interface LiveModeState<T> {
  readonly cutoffTimestamp: number | null;
  readonly cutoffRow: T | null;
  readonly isPast: (createdAt: number) => boolean;
}

export function useLiveMode<T extends { readonly id: string; readonly createdAt: number }>(
  rows: readonly T[],
  live: boolean,
): LiveModeState<T> {
  const [cutoffTimestamp, setCutoffTimestamp] = React.useState<number | null>(null);

  const onLiveChange = React.useEffectEvent((isLive: boolean) => {
    if (!isLive) {
      setCutoffTimestamp(null);
      return;
    }
    const newest = rows[0];
    setCutoffTimestamp(newest ? newest.createdAt : Date.now());
  });

  React.useEffect(() => {
    onLiveChange(live);
  }, [live]);

  const cutoffRow = React.useMemo(() => {
    if (cutoffTimestamp === null) return null;
    return rows.find((row) => row.createdAt <= cutoffTimestamp) ?? null;
  }, [rows, cutoffTimestamp]);

  const isPast = React.useCallback(
    (createdAt: number): boolean => {
      if (cutoffTimestamp === null) return false;
      return createdAt <= cutoffTimestamp;
    },
    [cutoffTimestamp],
  );

  return { cutoffTimestamp, cutoffRow, isPast };
}
