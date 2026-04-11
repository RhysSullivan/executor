import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ExecutionStatus } from "@executor/sdk";

import { listExecutions, type ExecutionListItem } from "../api/executions";
import { useHotkeys } from "react-hotkeys-hook";
import { useLiveMode } from "../hooks/use-live-mode";
import { useLocalStorage } from "../hooks/use-local-storage";
import { RunsShell } from "../components/runs/shell";
import { RunRow } from "../components/runs/row";
import {
  RunsColumnHeader,
  type SortField,
  type SortState,
} from "../components/runs/column-header";
import {
  RunsFilterRail,
  resolveTimeRange,
  type TimeRangePreset,
} from "../components/runs/filter-rail";
import { TimelineChart } from "../components/runs/timeline-chart";
import { RunsDetailDrawer } from "../components/runs/detail-drawer";
import { LiveButton } from "../components/runs/live-button";
import { RefreshButton } from "../components/runs/refresh-button";
import { KeyboardHelpButton } from "../components/runs/keyboard-help";
import {
  ViewOptionsButton,
  DEFAULT_FIELD_VISIBILITY,
  type RunFieldKey,
} from "../components/runs/view-options-button";
import { RunsFilterCommand } from "../components/runs/filter-command";
import type { RunsFilterTokens } from "../components/runs/filter-command-parser";
import { STATUS_ORDER } from "../components/runs/status";

// ---------------------------------------------------------------------------
// /runs — observability-style execution history
// ---------------------------------------------------------------------------
//
// Layout from openstatus-data-table's /infinite example. Row aesthetic,
// drawer, and status vocabulary from v1.3's execution-history plugin.
// URL state is the single source of truth — TanStack Router search params
// drive every filter, and the drawer open state is just `?executionId=`.

export type RunsSearch = {
  readonly executionId?: string;
  readonly status?: string;
  readonly trigger?: string;
  readonly tool?: string;
  readonly range?: string;
  readonly from?: string;
  readonly to?: string;
  readonly code?: string;
  readonly live?: string;
  /** Sort expression `"<field>,<direction>"` e.g. `"createdAt,desc"`. */
  readonly sort?: string;
  /** `"true"` | `"false"` — elicitation filter. Absent → no filter. */
  readonly elicitation?: string;
};

const DEFAULT_RANGE: TimeRangePreset = "24h";
const VALID_RANGES: readonly TimeRangePreset[] = ["15m", "1h", "24h", "7d", "30d", "all"];
const PAGE_SIZE = 50;
const LIVE_REFRESH_INTERVAL_MS = 5_000;

const parseStatuses = (value: string | undefined): ExecutionStatus[] =>
  value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry): entry is ExecutionStatus =>
          STATUS_ORDER.includes(entry as ExecutionStatus),
        )
    : [];

const parseCsv = (value: string | undefined): string[] =>
  value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

const parseRange = (value: string | undefined): TimeRangePreset => {
  if (!value) return DEFAULT_RANGE;
  return VALID_RANGES.includes(value as TimeRangePreset)
    ? (value as TimeRangePreset)
    : DEFAULT_RANGE;
};

const toggleCsv = (values: readonly string[], value: string): string[] =>
  values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value].sort();

const VALID_SORT_FIELDS: readonly SortField[] = ["createdAt", "durationMs"];

const parseSortSearch = (value: string | undefined): SortState => {
  if (!value) return null;
  const [field, direction] = value.split(",");
  if (!field || !direction) return null;
  if (!VALID_SORT_FIELDS.includes(field as SortField)) return null;
  if (direction !== "asc" && direction !== "desc") return null;
  return { field: field as SortField, direction };
};

/**
 * Cycle sort state for a given field: `none → desc → asc → none`.
 * If the clicked field is different from the currently active field,
 * start at `desc` for that field.
 */
const cycleSort = (current: SortState, field: SortField): SortState => {
  if (current?.field !== field) return { field, direction: "desc" };
  if (current.direction === "desc") return { field, direction: "asc" };
  return null;
};

export function RunsPage({ search }: { search: RunsSearch }) {
  const navigate = useNavigate();

  const selectedStatuses = React.useMemo(() => parseStatuses(search.status), [search.status]);
  const selectedTriggers = React.useMemo(() => parseCsv(search.trigger), [search.trigger]);
  const selectedTools = React.useMemo(() => parseCsv(search.tool), [search.tool]);
  const range = React.useMemo(() => parseRange(search.range), [search.range]);
  const sort = React.useMemo(() => parseSortSearch(search.sort), [search.sort]);
  const selectedElicitation: "true" | "false" | null =
    search.elicitation === "true" || search.elicitation === "false"
      ? search.elicitation
      : null;
  const live = search.live === "1";

  const [codeInput, setCodeInput] = React.useState(search.code ?? "");

  React.useEffect(() => {
    setCodeInput(search.code ?? "");
  }, [search.code]);

  const updateSearch = React.useCallback(
    (patch: Partial<RunsSearch>) => {
      void navigate({
        to: "/runs",
        replace: true,
        search: (current: RunsSearch) => {
          const next = { ...current, ...patch };
          const cleaned: Record<string, string | undefined> = {};
          for (const [key, value] of Object.entries(next)) {
            if (value && String(value).length > 0) {
              cleaned[key] = String(value);
            }
          }
          return cleaned as RunsSearch;
        },
      });
    },
    [navigate],
  );

  // Debounce code input → URL state
  React.useEffect(() => {
    const trimmed = codeInput.trim();
    const current = search.code ?? "";
    if (trimmed === current) return;

    const timeout = window.setTimeout(() => {
      updateSearch({ code: trimmed || undefined, executionId: undefined });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [codeInput, search.code, updateSearch]);

  // Resolve time range — custom from/to takes precedence over preset
  const resolvedTimeRange = React.useMemo(() => {
    if (search.from || search.to) {
      return {
        from: search.from ? Number(search.from) : undefined,
        to: search.to ? Number(search.to) : undefined,
      };
    }
    return resolveTimeRange(range);
  }, [range, search.from, search.to]);

  const listQuery = useInfiniteQuery({
    queryKey: [
      "executions",
      selectedStatuses.join(","),
      selectedTriggers.join(","),
      selectedTools.join(","),
      resolvedTimeRange.from ?? "",
      resolvedTimeRange.to ?? "",
      search.code ?? "",
      search.sort ?? "",
      search.elicitation ?? "",
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      listExecutions({
        limit: PAGE_SIZE,
        cursor: pageParam,
        status: selectedStatuses.length > 0 ? selectedStatuses.join(",") : undefined,
        trigger: selectedTriggers.length > 0 ? selectedTriggers.join(",") : undefined,
        tool: selectedTools.length > 0 ? selectedTools.join(",") : undefined,
        from: resolvedTimeRange.from ? String(resolvedTimeRange.from) : undefined,
        to: resolvedTimeRange.to ? String(resolvedTimeRange.to) : undefined,
        code: search.code,
        sort: search.sort,
        elicitation: search.elicitation,
      }),
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 10_000,
    // In live mode, re-poll the first page every 5s. React Query
    // refetches all already-loaded pages on interval, so new rows
    // naturally arrive at the top (order is newest-first). We don't
    // need `fetchPreviousPage` + `after` because the list is already
    // rebuilt from scratch on each tick.
    refetchInterval: live ? LIVE_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });

  const rows = React.useMemo(
    () => listQuery.data?.pages.flatMap((page) => page.executions) ?? [],
    [listQuery.data],
  );

  const liveMode = useLiveMode(rows, live);

  // Compute prev/next row ids for drawer navigation. Used by both
  // the header chevron buttons and the arrow-key hotkeys.
  const selectedIndex = React.useMemo(
    () => (search.executionId ? rows.findIndex((r) => r.id === search.executionId) : -1),
    [rows, search.executionId],
  );
  const prevRowId =
    selectedIndex > 0 ? rows[selectedIndex - 1]?.id : undefined;
  const nextRowId =
    selectedIndex >= 0 && selectedIndex < rows.length - 1
      ? rows[selectedIndex + 1]?.id
      : undefined;

  // Meta is only returned on the first page request — pin it
  const meta = listQuery.data?.pages[0]?.meta;

  const totalsLine = meta
    ? `${meta.filterRowCount.toLocaleString()} of ${meta.totalRowCount.toLocaleString()} runs`
    : undefined;

  const handleToggleStatus = React.useCallback(
    (status: ExecutionStatus) => {
      const next = toggleCsv(selectedStatuses, status) as ExecutionStatus[];
      updateSearch({
        status: next.length > 0 ? next.join(",") : undefined,
        executionId: undefined,
      });
    },
    [selectedStatuses, updateSearch],
  );

  const handleToggleTrigger = React.useCallback(
    (trigger: string) => {
      const next = toggleCsv(selectedTriggers, trigger);
      updateSearch({
        trigger: next.length > 0 ? next.join(",") : undefined,
        executionId: undefined,
      });
    },
    [selectedTriggers, updateSearch],
  );

  const handleToggleTool = React.useCallback(
    (toolPath: string) => {
      const next = toggleCsv(selectedTools, toolPath);
      updateSearch({
        tool: next.length > 0 ? next.join(",") : undefined,
        executionId: undefined,
      });
    },
    [selectedTools, updateSearch],
  );

  // Tri-state: clicking a checked row clears to `null`, clicking the
  // other row switches. Two separate toggles would allow "show neither"
  // which is incoherent.
  const handleToggleElicitation = React.useCallback(
    (value: "true" | "false") => {
      updateSearch({
        elicitation: selectedElicitation === value ? undefined : value,
        executionId: undefined,
      });
    },
    [selectedElicitation, updateSearch],
  );

  // Sort handler — cycles none → desc → asc → none and updates URL.
  const handleSort = React.useCallback(
    (field: SortField) => {
      const next = cycleSort(sort, field);
      updateSearch({
        sort: next ? `${next.field},${next.direction}` : undefined,
        executionId: undefined,
      });
    },
    [sort, updateSearch],
  );

  // `only` quick-filter handlers — replace the facet's current selection
  // with just the clicked value.
  const handleOnlyStatus = React.useCallback(
    (status: ExecutionStatus) =>
      updateSearch({ status, executionId: undefined }),
    [updateSearch],
  );
  const handleOnlyTrigger = React.useCallback(
    (trigger: string) => updateSearch({ trigger, executionId: undefined }),
    [updateSearch],
  );
  const handleOnlyTool = React.useCallback(
    (tool: string) => updateSearch({ tool, executionId: undefined }),
    [updateSearch],
  );

  const handleRangeChange = React.useCallback(
    (nextRange: TimeRangePreset) => {
      updateSearch({
        range: nextRange,
        from: undefined,
        to: undefined,
        executionId: undefined,
      });
    },
    [updateSearch],
  );

  const handleCodeQueryChange = React.useCallback((value: string) => {
    setCodeInput(value);
  }, []);

  const handleReset = React.useCallback(() => {
    setCodeInput("");
    updateSearch({
      status: undefined,
      trigger: undefined,
      tool: undefined,
      range: DEFAULT_RANGE,
      from: undefined,
      to: undefined,
      code: undefined,
      elicitation: undefined,
      executionId: undefined,
    });
  }, [updateSearch]);

  const handleChartRangeSelect = React.useCallback(
    ({ from, to }: { from: number; to: number }) => {
      updateSearch({
        range: undefined,
        from: String(from),
        to: String(to),
        executionId: undefined,
      });
    },
    [updateSearch],
  );

  const handleRowSelect = React.useCallback(
    (execution: ExecutionListItem) => {
      updateSearch({
        executionId: search.executionId === execution.id ? undefined : execution.id,
      });
    },
    [search.executionId, updateSearch],
  );

  const handleDrawerOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open) {
        updateSearch({ executionId: undefined });
      }
    },
    [updateSearch],
  );

  const toggleLive = React.useCallback(() => {
    updateSearch({ live: live ? undefined : "1" });
  }, [live, updateSearch]);

  const filterCommandInputRef = React.useRef<HTMLInputElement>(null);
  const [filterCommandValue, setFilterCommandValue] = React.useState("");
  const [filterCommandOpen, setFilterCommandOpen] = React.useState(false);
  const [keyboardHelpOpen, setKeyboardHelpOpen] = React.useState(false);
  const [railCollapsed, setRailCollapsed] = React.useState(false);

  // Row field visibility — persisted so users keep their preferences
  // across reloads. The ViewOptionsButton in the top bar drives this.
  const [fieldVisibility, setFieldVisibility] = useLocalStorage<
    Record<RunFieldKey, boolean>
  >("runs.fieldVisibility", DEFAULT_FIELD_VISIBILITY);

  const toggleFieldVisibility = React.useCallback(
    (key: RunFieldKey) => {
      setFieldVisibility((prev) => ({ ...prev, [key]: !prev[key] }));
    },
    [setFieldVisibility],
  );

  // Serialize the current URL filters into a single filter expression
  // string. The inline palette's input stays in sync with this so that
  // rail-driven filter changes show up in the input, and user edits
  // apply back to the URL on Enter.
  const currentFilterExpression = React.useMemo(() => {
    const parts: string[] = [];
    if (selectedStatuses.length > 0) parts.push(`status:${selectedStatuses.join(",")}`);
    if (selectedTriggers.length > 0) parts.push(`trigger:${selectedTriggers.join(",")}`);
    if (selectedTools.length > 0) parts.push(`tool:${selectedTools.join(",")}`);
    if (search.code) parts.push(`code:${search.code}`);
    return parts.join(" ");
  }, [selectedStatuses, selectedTriggers, selectedTools, search.code]);

  // Sync the palette input with external URL changes. If the user edits
  // the input locally, `filterCommandValue` diverges until they submit
  // or refocus. Re-sync on any URL change that's not their own recent
  // apply.
  React.useEffect(() => {
    setFilterCommandValue(currentFilterExpression);
  }, [currentFilterExpression]);

  const handleApplyFilterCommand = React.useCallback(
    (tokens: RunsFilterTokens) => {
      // Merge tokens into URL state. Missing sections clear their key.
      const statusValue = (tokens.status as ExecutionStatus[]).filter((s) =>
        STATUS_ORDER.includes(s),
      );

      updateSearch({
        status: statusValue.length > 0 ? statusValue.join(",") : undefined,
        trigger: tokens.trigger.length > 0 ? [...tokens.trigger].join(",") : undefined,
        tool: tokens.tool.length > 0 ? [...tokens.tool].join(",") : undefined,
        code: tokens.code ?? undefined,
        from: tokens.from ? String(tokens.from) : undefined,
        to: tokens.to ? String(tokens.to) : undefined,
        range: tokens.from || tokens.to ? undefined : undefined,
        executionId: undefined,
      });
    },
    [updateSearch],
  );

  // Keyboard shortcuts. `/` and `?` need preventDefault to suppress the
  // browser find bar / help shortcut. Default behavior (skip inputs /
  // textareas / contentEditable) is built into react-hotkeys-hook.
  useHotkeys("j", toggleLive, { enabled: !filterCommandOpen });
  useHotkeys("r", () => void listQuery.refetch(), { enabled: !filterCommandOpen });
  useHotkeys(
    "/",
    () => filterCommandInputRef.current?.focus(),
    { preventDefault: true },
  );
  useHotkeys("shift+/", () => setKeyboardHelpOpen(true), { preventDefault: true });
  useHotkeys("b", () => setRailCollapsed((prev) => !prev), {
    enabled: !filterCommandOpen,
  });

  return (
    <>
      <RunsShell
        filterRail={
          <RunsFilterRail
            selectedStatuses={selectedStatuses}
            onToggleStatus={handleToggleStatus}
            onOnlyStatus={handleOnlyStatus}
            selectedTriggers={selectedTriggers}
            onToggleTrigger={handleToggleTrigger}
            onOnlyTrigger={handleOnlyTrigger}
            selectedElicitation={selectedElicitation}
            onToggleElicitation={handleToggleElicitation}
            selectedTools={selectedTools}
            onToggleTool={handleToggleTool}
            onOnlyTool={handleOnlyTool}
            range={range}
            onRangeChange={handleRangeChange}
            codeQuery={codeInput}
            onCodeQueryChange={handleCodeQueryChange}
            onReset={handleReset}
            meta={meta}
            totalsLine={totalsLine}
          />
        }
        topBar={
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-baseline gap-3 font-mono text-[11px] text-muted-foreground/60">
                <span className="uppercase tracking-wider">
                  {rows.length.toLocaleString()} loaded
                </span>
                {meta ? (
                  <span className="uppercase tracking-wider">
                    · {meta.filterRowCount.toLocaleString()} total
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <RefreshButton
                  onClick={() => void listQuery.refetch()}
                  isLoading={listQuery.isRefetching}
                />
                <LiveButton active={live} onClick={toggleLive} />
                <ViewOptionsButton visible={fieldVisibility} onToggle={toggleFieldVisibility} />
                <KeyboardHelpButton
                  open={keyboardHelpOpen}
                  onOpenChange={setKeyboardHelpOpen}
                />
              </div>
            </div>
            <RunsFilterCommand
              ref={filterCommandInputRef}
              meta={meta}
              onApply={handleApplyFilterCommand}
              value={filterCommandValue}
              onValueChange={setFilterCommandValue}
              onOpenChange={setFilterCommandOpen}
            />
          </div>
        }
        chartSlot={
          meta ? (
            <TimelineChart
              data={meta.chartData}
              bucketMs={meta.chartBucketMs}
              onRangeSelect={handleChartRangeSelect}
            />
          ) : null
        }
        columnHeader={
          <RunsColumnHeader
            sort={sort}
            onSort={handleSort}
            visibleFields={fieldVisibility}
          />
        }
        isLoading={listQuery.isLoading}
        isFetchingNextPage={listQuery.isFetchingNextPage}
        hasNextPage={listQuery.hasNextPage}
        fetchNextPage={() => void listQuery.fetchNextPage()}
        totalRowsFetched={rows.length}
        filterRowCount={meta?.filterRowCount}
        rows={rows}
        getRowId={(row) => row.id}
        collapseRail={railCollapsed}
        renderRow={(row) => (
          <RunRow
            execution={row}
            isSelected={search.executionId === row.id}
            isPast={liveMode.isPast(row.createdAt)}
            visibleFields={fieldVisibility}
            onSelect={() => handleRowSelect(row)}
          />
        )}
        liveMarkerBeforeRowId={liveMode.cutoffRow?.id}
        emptyState={
          <div className="text-center">
            <p className="font-mono text-xs text-foreground/80">No runs match the current filters.</p>
            <p className="mt-1 font-mono text-[10px] text-muted-foreground/60">
              Try widening the time range or removing the status filter.
            </p>
          </div>
        }
      />

      <RunsDetailDrawer
        executionId={search.executionId}
        onOpenChange={handleDrawerOpenChange}
        prevRowId={prevRowId}
        nextRowId={nextRowId}
        onPrev={() => prevRowId && updateSearch({ executionId: prevRowId })}
        onNext={() => nextRowId && updateSearch({ executionId: nextRowId })}
      />
    </>
  );
}
