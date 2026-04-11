import * as React from "react";

import { cn } from "../../lib/utils";
import { LiveRow } from "./live-row";

// ---------------------------------------------------------------------------
// RunsShell — split-screen observability layout
// ---------------------------------------------------------------------------
//
// Shape borrowed from openstatus-data-table's `DataTableInfinite` and trimmed
// to what /runs actually needs:
//   ┌────────────┬────────────────────────────────────────────┐
//   │ filterRail │ topBar (toolbar + chartSlot)                │
//   │            ├────────────────────────────────────────────┤
//   │            │ columnHeader (_time | Raw Data)             │
//   │            ├────────────────────────────────────────────┤
//   │            │ body (scrollable, fetchNextPage on bottom)  │
//   │            │                                             │
//   │            │                                             │
//   │            │                                             │
//   │            └────────────────────────────────────────────┘
//
// No TanStack Table, no BYOS store, no column model — the body is a
// vertical list rendered via `renderRow(row)`. Pagination is driven by an
// onScroll hook, matching openstatus's approach. Live mode injects a
// `<LiveRow>` divider above `liveMarkerBeforeRowId`.
//
// v1.3 aesthetic: no outer card/border radius around the list, no alternating
// row background, dense mono typography.

export interface RunsShellProps<T> {
  readonly filterRail: React.ReactNode;
  readonly topBar?: React.ReactNode;
  readonly chartSlot?: React.ReactNode;
  readonly columnHeader?: React.ReactNode;
  readonly emptyState?: React.ReactNode;
  readonly rows: readonly T[];
  readonly getRowId: (row: T) => string;
  readonly renderRow: (row: T) => React.ReactNode;
  /**
   * If set, render a `<LiveRow>` divider immediately before the row
   * whose id equals this value. Used by live mode to mark the boundary
   * between "new since you went live" and "already there" rows.
   */
  readonly liveMarkerBeforeRowId?: string;
  readonly isLoading?: boolean;
  readonly isFetchingNextPage?: boolean;
  readonly hasNextPage?: boolean;
  readonly fetchNextPage?: () => void;
  readonly totalRowsFetched?: number;
  readonly filterRowCount?: number;
  /** When true, hide the filter rail and let the main pane fill the width. */
  readonly collapseRail?: boolean;
  readonly className?: string;
}

export function RunsShell<T>({
  filterRail,
  topBar,
  chartSlot,
  columnHeader,
  emptyState,
  rows,
  getRowId,
  renderRow,
  liveMarkerBeforeRowId,
  isLoading,
  isFetchingNextPage,
  hasNextPage,
  fetchNextPage,
  totalRowsFetched = 0,
  filterRowCount,
  collapseRail,
  className,
}: RunsShellProps<T>) {
  const topBarRef = React.useRef<HTMLDivElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const [topBarHeight, setTopBarHeight] = React.useState(0);

  React.useEffect(() => {
    const topBar = topBarRef.current;
    if (!topBar) return;

    const observer = new ResizeObserver(() => {
      const rect = topBar.getBoundingClientRect();
      setTopBarHeight(rect.height);
    });

    observer.observe(topBar);
    return () => observer.disconnect();
  }, []);

  const onScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (!fetchNextPage || !hasNextPage || isFetchingNextPage) return;

      const target = event.currentTarget;
      const onPageBottom =
        Math.ceil(target.scrollTop + target.clientHeight) >= target.scrollHeight - 64;

      if (onPageBottom) {
        const hitFilterCeiling =
          typeof filterRowCount === "number" && totalRowsFetched >= filterRowCount;
        if (!hitFilterCeiling) {
          fetchNextPage();
        }
      }
    },
    [fetchNextPage, hasNextPage, isFetchingNextPage, totalRowsFetched, filterRowCount],
  );

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col sm:flex-row",
        "bg-background text-foreground",
        className,
      )}
      style={
        {
          "--runs-top-bar-height": `${topBarHeight}px`,
        } as React.CSSProperties
      }
    >
      {/* Left rail */}
      <aside
        className={cn(
          "sticky top-0 z-10 flex h-screen w-full shrink-0 flex-col self-start",
          "sm:max-w-60 sm:min-w-60 md:max-w-72 md:min-w-72",
          "border-border sm:border-r",
          "hidden sm:flex",
          collapseRail && "sm:hidden",
        )}
      >
        <div className="min-h-0 flex-1 overflow-y-auto">{filterRail}</div>
      </aside>

      {/* Main pane */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Sticky top bar */}
        <div
          ref={topBarRef}
          className={cn(
            "sticky top-0 z-10 flex flex-col gap-3",
            "border-border border-b bg-background px-4 pt-3 pb-3",
          )}
        >
          {topBar}
          {chartSlot}
        </div>

        {/* Column header */}
        {columnHeader ? (
          <div className="sticky top-[var(--runs-top-bar-height)] z-10 border-border/60 border-b bg-background">
            {columnHeader}
          </div>
        ) : null}

        {/* Scrollable body */}
        <div ref={bodyRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex h-48 items-center justify-center text-xs font-mono text-muted-foreground">
              Loading runs…
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-full min-h-48 items-center justify-center px-4 py-8">
              {emptyState ?? (
                <p className="text-xs font-mono text-muted-foreground">No runs.</p>
              )}
            </div>
          ) : (
            <>
              {rows.map((row) => {
                const id = getRowId(row);
                return (
                  <React.Fragment key={id}>
                    {id === liveMarkerBeforeRowId ? <LiveRow /> : null}
                    {renderRow(row)}
                  </React.Fragment>
                );
              })}
              {isFetchingNextPage ? (
                <div className="flex items-center justify-center border-border/50 border-b py-3 text-[11px] font-mono uppercase tracking-wider text-muted-foreground/60">
                  Loading more…
                </div>
              ) : null}
              {!hasNextPage && totalRowsFetched > 0 ? (
                <div className="flex items-center justify-center py-4 text-[10px] font-mono uppercase tracking-wider text-muted-foreground/40">
                  End of history
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
