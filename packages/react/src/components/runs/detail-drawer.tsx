"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useHotkeys } from "react-hotkeys-hook";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { Execution, ExecutionInteraction, ExecutionToolCall } from "../../api/executions";

import { cn } from "../../lib/utils";
import { Button } from "../button";
import { CodeBlock } from "../code-block";
import { HoverCardTimestamp } from "./hover-card-timestamp";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../sheet";
import {
  getExecution,
  listExecutionToolCalls,
  type GetExecutionResponse,
} from "../../api/executions";
import { STATUS_LABELS, statusTone, triggerTone } from "./status";

type DetailTab = "properties" | "logs" | "toolCalls";

const formatDuration = (execution: Execution): string => {
  if (execution.startedAt === null || execution.completedAt === null) return "—";
  const ms = Math.max(0, execution.completedAt - execution.startedAt);
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
};

/** Recursively parse up to 4 layers of JSON-in-JSON — QuickJS double-serializes tool results. */
const unwrapJson = (
  raw: string | null,
): { readonly formatted: string | null; readonly lang: "json" | "text" } => {
  if (raw === null) return { formatted: null, lang: "json" };

  let value: unknown = raw;
  for (let i = 0; i < 4; i += 1) {
    if (typeof value !== "string") break;
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }

  if (typeof value === "string") {
    return { formatted: value, lang: "text" };
  }
  try {
    return { formatted: JSON.stringify(value, null, 2), lang: "json" };
  } catch {
    return { formatted: String(value), lang: "text" };
  }
};

export interface RunsDetailDrawerProps {
  readonly executionId?: string;
  readonly onOpenChange: (open: boolean) => void;
  /** Id of the previous row in the current filter set, or undefined if none. */
  readonly prevRowId?: string;
  /** Id of the next row in the current filter set, or undefined if none. */
  readonly nextRowId?: string;
  readonly onPrev?: () => void;
  readonly onNext?: () => void;
}

export function RunsDetailDrawer({
  executionId,
  onOpenChange,
  prevRowId,
  nextRowId,
  onPrev,
  onNext,
}: RunsDetailDrawerProps) {
  const open = Boolean(executionId);
  const query = useQuery({
    queryKey: ["execution", executionId],
    queryFn: () => getExecution(executionId!),
    enabled: open,
    staleTime: 10_000,
  });

  useHotkeys("ArrowUp", () => onPrev?.(), { enabled: open && !!prevRowId, preventDefault: true }, [
    open,
    prevRowId,
    onPrev,
  ]);
  useHotkeys(
    "ArrowDown",
    () => onNext?.(),
    { enabled: open && !!nextRowId, preventDefault: true },
    [open, nextRowId, onNext],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className={cn(
          "w-full gap-0 p-0 sm:max-w-3xl",
          "bg-popover text-popover-foreground",
          "border-l border-border/70",
        )}
      >
        <DrawerBody
          executionId={executionId}
          query={query}
          onClose={() => onOpenChange(false)}
          prevRowId={prevRowId}
          nextRowId={nextRowId}
          onPrev={onPrev}
          onNext={onNext}
        />
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({
  executionId,
  query,
  onClose,
  prevRowId,
  nextRowId,
  onPrev,
  onNext,
}: {
  readonly executionId?: string;
  readonly query: ReturnType<typeof useQuery<GetExecutionResponse>>;
  readonly onClose: () => void;
  readonly prevRowId?: string;
  readonly nextRowId?: string;
  readonly onPrev?: () => void;
  readonly onNext?: () => void;
}) {
  const [tab, setTab] = React.useState<DetailTab>("properties");
  const [copied, setCopied] = React.useState(false);

  const envelope = query.data;

  const handleCopyJson = React.useCallback(() => {
    if (!envelope) return;
    const tryParse = (value: string | null): unknown => {
      if (value === null) return null;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    };

    const cleaned = {
      ...envelope,
      execution: {
        ...envelope.execution,
        resultJson: tryParse(envelope.execution.resultJson),
        logsJson: tryParse(envelope.execution.logsJson),
      },
    };
    void navigator.clipboard.writeText(JSON.stringify(cleaned, null, 2)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [envelope]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader className="sr-only">
        <SheetTitle>Execution details</SheetTitle>
        <SheetDescription>{executionId ?? "No execution selected"}</SheetDescription>
      </SheetHeader>

      <div className="flex items-center justify-between border-border/60 border-b px-5 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm text-foreground">{executionId ?? "—"}</div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onPrev}
            disabled={!prevRowId}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
            title="Previous run (↑)"
            aria-label="Previous run"
          >
            <ChevronUp className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onNext}
            disabled={!nextRowId}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
            title="Next run (↓)"
            aria-label="Next run"
          >
            <ChevronDown className="size-3.5" />
          </Button>
          <div className="mx-1 h-4 w-px bg-border/60" aria-hidden />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCopyJson}
            disabled={!envelope}
            className="h-7 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            {copied ? "Copied" : "Copy JSON"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <svg viewBox="0 0 16 16" className="size-3.5">
              <path
                d="M4 4l8 8M12 4l-8 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </Button>
        </div>
      </div>

      <div className="flex gap-0 border-border/60 border-b px-5">
        <TabButton
          label="Properties"
          active={tab === "properties"}
          onClick={() => setTab("properties")}
        />
        <TabButton
          label={
            envelope && envelope.execution.toolCallCount > 0
              ? `Tool calls · ${envelope.execution.toolCallCount}`
              : "Tool calls"
          }
          active={tab === "toolCalls"}
          onClick={() => setTab("toolCalls")}
        />
        <TabButton label="Logs" active={tab === "logs"} onClick={() => setTab("logs")} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {query.isLoading ? (
          <p className="font-mono text-xs text-muted-foreground">Loading execution…</p>
        ) : query.isError ? (
          <p className="font-mono text-xs text-destructive">Failed to load execution details.</p>
        ) : envelope ? (
          tab === "properties" ? (
            <PropertiesTab envelope={envelope} />
          ) : tab === "toolCalls" ? (
            <ToolCallsTab execution={envelope.execution} />
          ) : (
            <LogsTab logsJson={envelope.execution.logsJson} />
          )
        ) : (
          <p className="font-mono text-xs text-muted-foreground">Execution not found.</p>
        )}
      </div>
    </div>
  );
}

function TabButton(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    // oxlint-disable-next-line react/forbid-elements -- tab buttons carry a tab-shaped bottom border that <Button>'s variants don't expose.
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "px-3 py-2 text-xs font-medium transition-colors",
        props.active
          ? "border-b-2 border-primary text-foreground"
          : "border-b-2 border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {props.label}
    </button>
  );
}

function PropertiesTab({ envelope }: { envelope: GetExecutionResponse }) {
  const { execution, pendingInteraction } = envelope;
  const tone = statusTone(execution.status);
  const trigger = triggerTone(execution.triggerKind);
  const result = unwrapJson(execution.resultJson);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <MetaCard label="Status">
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn("size-2 rounded-full", tone.dot, tone.pulse && "animate-pulse")}
            />
            <span className="text-sm">{STATUS_LABELS[execution.status]}</span>
          </span>
        </MetaCard>
        <MetaCard label="Duration">
          <span className="text-sm tabular-nums">{formatDuration(execution)}</span>
        </MetaCard>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
        <div className="flex items-baseline gap-1">
          <span className="text-muted-foreground/60">Created</span>
          {execution.createdAt ? (
            <HoverCardTimestamp date={new Date(execution.createdAt)} className="text-xs" />
          ) : (
            <span>—</span>
          )}
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-muted-foreground/60">Started</span>
          {execution.startedAt ? (
            <HoverCardTimestamp date={new Date(execution.startedAt)} className="text-xs" />
          ) : (
            <span>—</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/70">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn("size-1.5 rounded-full", trigger.dot)} />
          <span>via {trigger.label}</span>
        </span>
        <span className="text-muted-foreground/30">•</span>
        <span>tools {execution.toolCallCount}</span>
      </div>

      <CodeBlock title="Code" code={execution.code} lang="ts" />

      {result.formatted ? (
        <CodeBlock title="Result" code={result.formatted} lang={result.lang} />
      ) : (
        <EmptyPanel title="Result" message="No result recorded." />
      )}

      {execution.errorText ? (
        <div className="overflow-hidden rounded-lg border border-destructive/40 bg-[color:color-mix(in_srgb,var(--destructive)_7%,transparent)]">
          <div className="border-b border-destructive/40 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-destructive">
            Error
          </div>
          <pre className="overflow-x-auto px-3 py-3 font-mono text-[12px] leading-relaxed text-foreground whitespace-pre-wrap">
            {execution.errorText}
          </pre>
        </div>
      ) : null}

      {pendingInteraction ? <PendingInteractionBlock interaction={pendingInteraction} /> : null}
    </div>
  );
}

function MetaCard(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {props.label}
      </div>
      <div className="mt-1 text-foreground">{props.children}</div>
    </div>
  );
}

function EmptyPanel(props: { title: string; message: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-card/40">
      <div className="border-b border-border/60 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {props.title}
      </div>
      <div className="px-3 py-3 font-mono text-[11px] text-muted-foreground/60">
        {props.message}
      </div>
    </div>
  );
}

function PendingInteractionBlock({ interaction }: { interaction: ExecutionInteraction }) {
  const request = unwrapJson(interaction.payloadJson);
  const response = unwrapJson(interaction.responseJson);

  return (
    <div className="space-y-3 rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-foreground">Pending interaction</div>
          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {interaction.kind} — {interaction.purpose}
          </div>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {interaction.status}
        </span>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        {request.formatted ? (
          <CodeBlock title="Request" code={request.formatted} lang={request.lang} />
        ) : (
          <EmptyPanel title="Request" message="No request captured." />
        )}
        {response.formatted ? (
          <CodeBlock title="Response" code={response.formatted} lang={response.lang} />
        ) : (
          <EmptyPanel title="Response" message="No response captured." />
        )}
      </div>
    </div>
  );
}

function LogsTab({ logsJson }: { logsJson: string | null }) {
  const lines = React.useMemo(() => {
    if (logsJson === null) return null;
    try {
      const parsed = JSON.parse(logsJson);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return null;
    }
    return null;
  }, [logsJson]);

  if (!lines) {
    const fallback = unwrapJson(logsJson);
    if (!fallback.formatted) {
      return (
        <div className="rounded-lg border border-border/60 bg-card/40 px-4 py-12 text-center font-mono text-xs text-muted-foreground/60">
          No logs recorded.
        </div>
      );
    }
    return <CodeBlock title="Logs" code={fallback.formatted} lang={fallback.lang} />;
  }

  if (lines.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/40 px-4 py-12 text-center font-mono text-xs text-muted-foreground/60">
        No logs recorded.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-card/40">
      <div className="border-b border-border/60 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        Logs
      </div>
      <div className="divide-y divide-border/30">
        {lines.map((line, index) => {
          const isError = /\[error\]/i.test(line);
          const isWarn = /\[warn\]/i.test(line);
          return (
            <div
              key={`${index}-${line.slice(0, 32)}`}
              className={cn(
                "px-3 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all",
                isError && "text-red-400",
                isWarn && "text-amber-400",
                !isError && !isWarn && "text-foreground/80",
              )}
            >
              {line}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolCallsTab({ execution }: { execution: Execution }) {
  const query = useQuery({
    queryKey: ["execution", execution.id, "tool-calls"],
    queryFn: () => listExecutionToolCalls(execution.id),
    staleTime: 10_000,
  });

  if (query.isLoading) {
    return <p className="font-mono text-xs text-muted-foreground">Loading tool calls…</p>;
  }
  if (query.isError) {
    return <p className="font-mono text-xs text-destructive">Failed to load tool calls.</p>;
  }

  const calls = query.data?.toolCalls ?? [];
  if (calls.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/40 px-4 py-12 text-center font-mono text-xs text-muted-foreground/60">
        No tool calls recorded.
      </div>
    );
  }

  // Derive a time scale for the flame-graph bars.
  const windowStart = execution.startedAt ?? calls[0]!.startedAt;
  const windowEnd =
    execution.completedAt ??
    Math.max(...calls.map((call) => call.completedAt ?? call.startedAt + (call.durationMs ?? 0)));
  const windowWidth = Math.max(1, windowEnd - windowStart);

  return (
    <div className="space-y-1.5">
      {calls.map((call) => (
        <ToolCallRow
          key={call.id}
          call={call}
          windowStart={windowStart}
          windowWidth={windowWidth}
        />
      ))}
    </div>
  );
}

function ToolCallRow({
  call,
  windowStart,
  windowWidth,
}: {
  readonly call: ExecutionToolCall;
  readonly windowStart: number;
  readonly windowWidth: number;
}) {
  const [expanded, setExpanded] = React.useState(false);

  const offsetMs = Math.max(0, call.startedAt - windowStart);
  const durationMs = call.durationMs ?? Math.max(0, Date.now() - call.startedAt);
  const offsetPct = (offsetMs / windowWidth) * 100;
  const widthPct = Math.max(0.75, (durationMs / windowWidth) * 100);

  const args = unwrapJson(call.argsJson);
  const result = unwrapJson(call.resultJson);

  const statusColor =
    call.status === "failed"
      ? "bg-destructive"
      : call.status === "running"
        ? "bg-blue-400 animate-pulse"
        : "bg-primary";

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-card/40">
      {/* oxlint-disable-next-line react/forbid-elements -- full-width expandable card header; <Button> imposes centered content + padding that would break the timeline swimlane layout inside. */}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="group flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-foreground/[0.03]"
      >
        <div className="relative h-5 w-40 shrink-0 rounded-sm border border-border/40 bg-background">
          <div
            className={cn("absolute top-0 h-full rounded-sm", statusColor)}
            style={{
              left: `${offsetPct}%`,
              width: `${Math.min(100 - offsetPct, widthPct)}%`,
            }}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs text-foreground">{call.toolPath}</div>
        </div>

        <div className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {call.durationMs !== null ? `${call.durationMs}ms` : "—"}
        </div>
      </button>

      {expanded ? (
        <div className="grid gap-3 border-t border-border/40 px-3 py-3 xl:grid-cols-2">
          {args.formatted ? (
            <CodeBlock title="Args" code={args.formatted} lang={args.lang} />
          ) : (
            <EmptyPanel title="Args" message="No args recorded." />
          )}
          {call.status === "failed" && call.errorText ? (
            <div className="overflow-hidden rounded-lg border border-destructive/40 bg-[color:color-mix(in_srgb,var(--destructive)_7%,transparent)]">
              <div className="border-b border-destructive/40 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-destructive">
                Error
              </div>
              <pre className="overflow-x-auto px-3 py-3 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap">
                {call.errorText}
              </pre>
            </div>
          ) : result.formatted ? (
            <CodeBlock title="Result" code={result.formatted} lang={result.lang} />
          ) : (
            <EmptyPanel title="Result" message="No result recorded." />
          )}
        </div>
      ) : null}
    </div>
  );
}
