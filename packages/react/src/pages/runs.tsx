import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ExecutionStatus } from "../api/executions";

import { listExecutions, type ExecutionListItem } from "../api/executions";
import { useHotkeys } from "react-hotkeys-hook";
import { useLiveMode } from "../hooks/use-live-mode";
import { useLocalStorage } from "../hooks/use-local-storage";
import { RunsShell } from "../components/runs/shell";
import { RunRow } from "../components/runs/row";
import { RunsColumnHeader, type SortField, type SortState } from "../components/runs/column-header";
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
  readonly sort?: string;
  readonly elicitation?: string;
};

const DEFAULT_RANGE: TimeRangePreset = "24h";
const VALID_RANGES: readonly TimeRangePreset[] = ["15m", "1h", "24h", "7d", "30d", "all"];
const PAGE_SIZE = 50;
const LIVE_REFRESH_INTERVAL_MS = 5_000;

const splitCsv = (value: string | undefined): string[] =>
  value ? value.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : [];

const parseStatuses = (value: string | undefined): ExecutionStatus[] =>
  splitCsv(value).filter((s): s is ExecutionStatus => STATUS_ORDER.includes(s as ExecutionStatus));

const toggleCsv = (values: readonly string[], value: string): string[] =>
  values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value].sort();

const VALID_SORT_FIELDS: readonly SortField[] = ["createdAt", "durationMs"];

const parseSortSearch = (value: string | undefined): SortState => {
  if (!value) return null;
  const [field, direction] = value.split(",");
  if (!field || !direction) return null;
  if (!VALID_SORT_FIELDS.includes(field as SortField)) return null;
  if (direction !== "asc" && direction !== "desc") return null;
  return { field: field as SortField, direction };
};


export function RunsPage({ search }: { search: RunsSearch }) {
  const navigate = useNavigate();

  const selectedStatuses = React.useMemo(() => parseStatuses(search.status), [search.status]);
  const selectedTriggers = React.useMemo(() => splitCsv(search.trigger), [search.trigger]);
  const selectedTools = React.useMemo(() => splitCsv(search.tool), [search.tool]);
  const range = React.useMemo(
    (): TimeRangePreset =>
      search.range && VALID_RANGES.includes(search.range as TimeRangePreset)
        ? (search.range as TimeRangePreset)
        : DEFAULT_RANGE,
    [search.range],
  );
  const sort = React.useMemo(() => parseSortSearch(search.sort), [search.sort]);
  const selectedElicitation: "true" | "false" | null =
    search.elicitation === "true" || search.elicitation === "false" ? search.elicitation : null;
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

  React.useEffect(() => {
    const trimmed = codeInput.trim();
    const current = search.code ?? "";
    if (trimmed === current) return;

    const timeout = window.setTimeout(() => {
      updateSearch({ code: trimmed || undefined, executionId: undefined });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [codeInput, search.code, updateSearch]);

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
    refetchInterval: live ? LIVE_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });

  const rows = React.useMemo(
    () => listQuery.data?.pages.flatMap((page) => page.executions) ?? [],
    [listQuery.data],
  );

  const liveMode = useLiveMode(rows, live);

  const selectedIndex = React.useMemo(
    () => (search.executionId ? rows.findIndex((r) => r.id === search.executionId) : -1),
    [rows, search.executionId],
  );
  const prevRowId = selectedIndex > 0 ? rows[selectedIndex - 1]?.id : undefined;
  const nextRowId =
    selectedIndex >= 0 && selectedIndex < rows.length - 1 ? rows[selectedIndex + 1]?.id : undefined;

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

  const handleToggleElicitation = React.useCallback(
    (value: "true" | "false") => {
      updateSearch({
        elicitation: selectedElicitation === value ? undefined : value,
        executionId: undefined,
      });
    },
    [selectedElicitation, updateSearch],
  );

  const handleSort = React.useCallback(
    (field: SortField) => {
      const next: SortState =
        sort?.field !== field
          ? { field, direction: "desc" }
          : sort.direction === "desc"
            ? { field, direction: "asc" }
            : null;
      updateSearch({
        sort: next ? `${next.field},${next.direction}` : undefined,
        executionId: undefined,
      });
    },
    [sort, updateSearch],
  );

  const handleOnlyStatus = React.useCallback(
    (status: ExecutionStatus) => updateSearch({ status, executionId: undefined }),
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

  const [fieldVisibility, setFieldVisibility] = useLocalStorage<Record<RunFieldKey, boolean>>(
    "runs.fieldVisibility",
    DEFAULT_FIELD_VISIBILITY,
  );

  const toggleFieldVisibility = React.useCallback(
    (key: RunFieldKey) => {
      setFieldVisibility((prev) => ({ ...prev, [key]: !prev[key] }));
    },
    [setFieldVisibility],
  );

  const currentFilterExpression = React.useMemo(() => {
    const parts: string[] = [];
    if (selectedStatuses.length > 0) parts.push(`status:${selectedStatuses.join(",")}`);
    if (selectedTriggers.length > 0) parts.push(`trigger:${selectedTriggers.join(",")}`);
    if (selectedTools.length > 0) parts.push(`tool:${selectedTools.join(",")}`);
    if (search.code) parts.push(`code:${search.code}`);
    return parts.join(" ");
  }, [selectedStatuses, selectedTriggers, selectedTools, search.code]);

  React.useEffect(() => {
    setFilterCommandValue(currentFilterExpression);
  }, [currentFilterExpression]);

  const handleApplyFilterCommand = React.useCallback(
    (tokens: RunsFilterTokens) => {
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

  useHotkeys("j", toggleLive, { enabled: !filterCommandOpen });
  useHotkeys("r", () => void listQuery.refetch(), { enabled: !filterCommandOpen });
  useHotkeys("/", () => filterCommandInputRef.current?.focus(), { preventDefault: true });
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
                <KeyboardHelpButton open={keyboardHelpOpen} onOpenChange={setKeyboardHelpOpen} />
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
          <RunsColumnHeader sort={sort} onSort={handleSort} visibleFields={fieldVisibility} />
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
            <p className="font-mono text-xs text-foreground/80">
              No runs match the current filters.
            </p>
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
