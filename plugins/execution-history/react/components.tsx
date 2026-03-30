import { useState, useMemo, useCallback } from "react";
import type {
  Execution,
  ExecutionEnvelope,
} from "@executor/react";
import {
  useExecution,
  useExecutions,
} from "@executor/react";
import {
  Button,
  cn,
  Dialog,
  DialogOverlay,
  DialogPopup,
  DialogPortal,
  DocumentPanel,
  EmptyState,
  IconClose,
  Input,
  LoadableBlock,
  Select,
  useExecutorPluginNavigation,
  useExecutorPluginRouteParams,
  useExecutorPluginSearch,
} from "@executor/react/plugins";

// ── Helpers ──────────────────────────────────────────────────────────────

type ExecutionStatus = Execution["status"];

const formatTimestamp = (value: number | null): string => {
  if (value === null) return "—";
  const d = new Date(value);
  const month = d.toLocaleString(undefined, { month: "short" });
  const day = d.getDate();
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${month} ${day}, ${h}:${m}:${s}`;
};

const formatDuration = (execution: Execution): string | null => {
  if (execution.startedAt === null || execution.completedAt === null) return null;
  const ms = Math.max(0, execution.completedAt - execution.startedAt);
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
};

const truncateCode = (code: string, max = 80): string =>
  code.trim().replace(/\s+/g, " ").slice(0, max);

const formatJsonDocument = (value: string | null): string | null => {
  if (value === null) return null;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};

const STATUS_STYLES = {
  completed: { dot: "bg-primary", text: "text-primary" },
  failed: { dot: "bg-destructive", text: "text-destructive" },
  running: { dot: "bg-blue-400 animate-pulse", text: "text-blue-400" },
  waiting_for_interaction: { dot: "bg-amber-400 animate-pulse", text: "text-amber-400" },
  pending: { dot: "bg-muted", text: "text-muted-foreground" },
  cancelled: { dot: "bg-muted", text: "text-muted-foreground" },
} as const satisfies Record<ExecutionStatus, { dot: string; text: string }>;

const statusDot = (status: ExecutionStatus): string => STATUS_STYLES[status].dot;
const statusText = (status: ExecutionStatus): string => STATUS_STYLES[status].text;

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "running", label: "Running" },
  { value: "waiting_for_interaction", label: "Waiting" },
  { value: "pending", label: "Pending" },
  { value: "cancelled", label: "Cancelled" },
];

const formatDurationMs = (execution: Execution): string | null => {
  if (execution.startedAt === null || execution.completedAt === null) return null;
  const ms = Math.max(0, execution.completedAt - execution.startedAt);
  return ms.toLocaleString();
};

// ── Execution Row ────────────────────────────────────────────────────────

const ExecutionRow = (props: {
  execution: Execution;
  isSelected: boolean;
  onSelect: () => void;
}) => {
  const { execution, isSelected } = props;
  const durationMs = formatDurationMs(execution);

  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={cn(
        "group flex w-full items-start gap-3 border-b border-border/50 px-4 py-2 text-left font-mono text-xs transition-colors hover:bg-white/[0.04]",
        isSelected && "bg-white/[0.06]",
      )}
    >
      <span
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          statusDot(execution.status),
        )}
      />
      <span className="w-[120px] shrink-0 tabular-nums text-muted-foreground">
        {formatTimestamp(execution.createdAt)}
      </span>
      <span className="inline-flex w-[130px] shrink-0">
        <span className="text-muted-foreground/60">status:</span>
        <span className={statusText(execution.status)}>{execution.status.replaceAll("_", " ")}</span>
      </span>
      <span className="inline-flex w-[110px] shrink-0">
        <span className="text-muted-foreground/60">duration_ms:</span>{" "}
        <span className={durationMs && Number(durationMs.replace(/,/g, "")) > 5000 ? "text-destructive" : "text-primary"}>{durationMs ?? "—"}</span>
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground/60">code:</span>{" "}
        <span className="text-muted-foreground">&quot;{truncateCode(execution.code, 120)}…&quot;</span>
      </span>
    </button>
  );
};

// ── Detail Drawer ────────────────────────────────────────────────────────

type DetailTab = "properties" | "logs";

const DetailTabButton = (props: {
  label: string;
  active: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={props.onClick}
    className={cn(
      "px-3 py-1.5 text-sm font-medium transition-colors",
      props.active
        ? "border-b-2 border-primary text-foreground"
        : "text-muted-foreground hover:text-foreground",
    )}
  >
    {props.label}
  </button>
);

const PropertiesTab = (props: { envelope: ExecutionEnvelope }) => {
  const { execution, pendingInteraction } = props.envelope;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border/50 px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Status
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className={cn("size-2 rounded-full", statusDot(execution.status))} />
            <span className="text-sm">{execution.status.replaceAll("_", " ")}</span>
          </div>
        </div>
        <div className="rounded-lg border border-border/50 px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Duration
          </div>
          <div className="mt-1 text-sm">{formatDuration(execution) ?? "—"}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
        <div>
          <span className="text-muted-foreground/60">Created </span>
          {formatTimestamp(execution.createdAt)}
        </div>
        <div>
          <span className="text-muted-foreground/60">Started </span>
          {formatTimestamp(execution.startedAt)}
        </div>
      </div>

      <DocumentPanel
        title="Code"
        body={execution.code}
        lang="ts"
        empty="No code captured."
      />

      <DocumentPanel
        title="Result"
        body={formatJsonDocument(execution.resultJson)}
        lang="json"
        empty="No result recorded."
      />

      {execution.errorText && (
        <DocumentPanel
          title="Error"
          body={execution.errorText}
          lang="text"
          empty="No error recorded."
        />
      )}

      {pendingInteraction && (
        <div className="space-y-3">
          <div className="text-sm font-medium text-foreground">
            Pending interaction
            <span className="ml-2 text-xs text-muted-foreground">
              {pendingInteraction.kind} — {pendingInteraction.purpose}
            </span>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            <DocumentPanel
              title="Request"
              body={formatJsonDocument(pendingInteraction.payloadJson)}
              lang="json"
              empty="No interaction request recorded."
            />
            <DocumentPanel
              title="Response"
              body={formatJsonDocument(pendingInteraction.responseJson)}
              lang="json"
              empty="No interaction response recorded."
            />
          </div>
        </div>
      )}
    </div>
  );
};

const LogsTab = (props: { logsJson: string | null }) => {
  const parsed = useMemo(() => {
    if (!props.logsJson) return null;
    try {
      const arr = JSON.parse(props.logsJson);
      if (!Array.isArray(arr)) return null;
      return arr as string[];
    } catch {
      return null;
    }
  }, [props.logsJson]);

  if (!parsed) {
    return (
      <DocumentPanel
        title="Logs"
        body={formatJsonDocument(props.logsJson)}
        lang="json"
        empty="No logs recorded."
      />
    );
  }

  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-3">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
        Logs
      </div>
      <div className="space-y-0.5 font-mono text-xs">
        {parsed.map((line, i) => {
          const isError = typeof line === "string" && /\[error]/i.test(line);
          const isWarn = typeof line === "string" && /\[warn]/i.test(line);
          const lineKey = typeof line === "string"
            ? `line-${i}-${line.slice(0, 50).replace(/\s+/g, "-")}`
            : `line-${i}-${JSON.stringify(line).slice(0, 50)}`;
          return (
            <div
              key={lineKey}
              className={cn(
                "whitespace-pre-wrap break-all",
                isError && "text-red-400",
                isWarn && "text-amber-400",
                !isError && !isWarn && "text-foreground/80",
              )}
            >
              {typeof line === "string" ? line : JSON.stringify(line)}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const ExecutionDetailDrawer = (props: {
  executionId: string;
  onClose: () => void;
}) => {
  const [tab, setTab] = useState<DetailTab>("properties");
  const execution = useExecution(props.executionId);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (envelope: ExecutionEnvelope) => {
      const tryParse = (v: string | null) => {
        if (v === null) return null;
        try { return JSON.parse(v); } catch { return v; }
      };
      const cleaned = {
        ...envelope,
        execution: {
          ...envelope.execution,
          resultJson: tryParse(envelope.execution.resultJson),
          logsJson: tryParse(envelope.execution.logsJson),
          errorText: envelope.execution.errorText,
        },
      };
      void navigator.clipboard
        .writeText(JSON.stringify(cleaned, null, 2))
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
    },
    [],
  );

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPopup
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-3xl flex-col bg-popover text-popover-foreground ring-1 ring-foreground/10 outline-none duration-150 data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right"
        >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/50 px-5 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {props.executionId}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LoadableBlock loadable={execution} loading="">
              {(envelope) => (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCopy(envelope)}
                  className="text-xs text-muted-foreground"
                >
                  {copied ? "Copied" : "Copy JSON"}
                </Button>
              )}
            </LoadableBlock>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={props.onClose}
            >
              <IconClose className="size-3.5" />
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-border/50 px-5">
          <DetailTabButton
            label="Properties"
            active={tab === "properties"}
            onClick={() => setTab("properties")}
          />
          <DetailTabButton
            label="Logs"
            active={tab === "logs"}
            onClick={() => setTab("logs")}
          />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <LoadableBlock loadable={execution} loading="Loading execution...">
            {(envelope) =>
              tab === "properties" ? (
                <PropertiesTab envelope={envelope} />
              ) : (
                <LogsTab logsJson={envelope.execution.logsJson} />
              )
            }
          </LoadableBlock>
        </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
};

// ── List Page ────────────────────────────────────────────────────────────

type ExecutionHistorySearch = {
  executionId?: string;
};

export function ExecutionHistoryPage() {
  const executions = useExecutions();
  const navigation = useExecutorPluginNavigation();
  const searchState = useExecutorPluginSearch<ExecutionHistorySearch>();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const selectedId =
    typeof searchState.executionId === "string"
      ? searchState.executionId
      : null;

  const setSelectedId = useCallback(
    (executionId: string | null) => {
      if (executionId === null) {
        const { executionId: _, ...nextSearch } = searchState;
        void navigation.updateSearch(nextSearch);
        return;
      }

      void navigation.updateSearch({
        ...searchState,
        executionId,
      });
    },
    [navigation, searchState],
  );

  const filtered = useMemo(() => {
    if (executions.status !== "ready") return [];
    let items = [...executions.data];
    if (statusFilter !== "all") {
      items = items.filter((e) => e.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(
        (e) =>
          e.code.toLowerCase().includes(q) ||
          (e.errorText && e.errorText.toLowerCase().includes(q)),
      );
    }
    return items;
  }, [executions, statusFilter, search]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border/50 px-6 py-5">
        <h1 className="font-display text-2xl tracking-tight text-foreground">
          Execution history
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every execution recorded for this workspace, newest first.
        </p>

        {/* Filter bar */}
        <div className="mt-4 flex items-center gap-3">
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="w-[140px]"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
          <Input
            type="text"
            placeholder="Search code or errors..."
            value={search}
            onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
            className="flex-1"
          />
        </div>
      </div>

      {/* Column headers */}
      <div className="flex items-center gap-3 border-b border-border/50 px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        <span className="size-2 shrink-0" />
        <span className="w-[120px] shrink-0">_time</span>
        <span>Raw Data</span>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        <LoadableBlock loadable={executions} loading="Loading executions...">
          {() =>
            filtered.length === 0 ? (
              <div className="py-20">
                <EmptyState
                  title={
                    statusFilter !== "all" || search.trim()
                      ? "No matching executions"
                      : "No executions yet"
                  }
                  description={
                    statusFilter !== "all" || search.trim()
                      ? "Try adjusting your filters."
                      : "Run something and it will show up here."
                  }
                />
              </div>
            ) : (
              <div>
                {filtered.map((execution) => (
                  <ExecutionRow
                    key={execution.id}
                    execution={execution}
                    isSelected={selectedId === execution.id}
                    onSelect={() =>
                      setSelectedId(
                        selectedId === execution.id ? null : execution.id,
                      )
                    }
                  />
                ))}
              </div>
            )
          }
        </LoadableBlock>
      </div>

      {/* Drawer */}
      {selectedId && (
        <ExecutionDetailDrawer
          executionId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

// ── Detail Page (deep-link) ──────────────────────────────────────────────

const ExecutionDetailInline = (props: { envelope: ExecutionEnvelope }) => {
  const [tab, setTab] = useState<DetailTab>("properties");

  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-border/50">
        <DetailTabButton
          label="Properties"
          active={tab === "properties"}
          onClick={() => setTab("properties")}
        />
        <DetailTabButton
          label="Logs"
          active={tab === "logs"}
          onClick={() => setTab("logs")}
        />
      </div>
      {tab === "properties" ? (
        <PropertiesTab envelope={props.envelope} />
      ) : (
        <LogsTab logsJson={props.envelope.execution.logsJson} />
      )}
    </div>
  );
};

export function ExecutionHistoryDetailPage() {
  const { executionId } = useExecutorPluginRouteParams<{
    executionId: string;
  }>();
  const navigation = useExecutorPluginNavigation();
  const execution = useExecution(executionId);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10 lg:px-10 lg:py-14">
        <div className="mb-8">
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              void navigation.route();
            }}
            className="mb-3 h-auto p-0 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
          >
            Back to history
          </Button>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl tracking-tight text-foreground lg:text-3xl">
              {executionId}
            </h1>
          </div>
        </div>

        <LoadableBlock loadable={execution} loading="Loading execution...">
          {(envelope) => (
            <ExecutionDetailInline envelope={envelope} />
          )}
        </LoadableBlock>
      </div>
    </div>
  );
}
