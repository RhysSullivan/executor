import * as React from "react";
import type { Execution, ExecutionStatus } from "@executor/sdk";

import { cn } from "../../lib/utils";
import { HoverCardTimestamp } from "./hover-card-timestamp";
import { statusTone, triggerTone } from "./status";

// ---------------------------------------------------------------------------
// RunRow — v1.3 log-line aesthetic
// ---------------------------------------------------------------------------
//
// Single row of the /runs list. Every run renders as a dense, monospace
// key-value log line — muted labels, color-coded values, a single status
// dot, no cells in a grid. v1.3 used a plain <button>; we do the same so
// the entire row is one click target and keyboard-focusable.
//
// Layout (left to right):
//   [dot] [timestamp]  status:<…>  via:<…>  tools:N  log:NE MW  duration_ms:<…>  code:"…"
//
// Responsive visibility (after Round 4 retightening):
//   - `via` and `log` hide below 2xl (1536px) so the code snippet has
//     room on 1280-1440px laptop viewports.
//   - `tools` hides below lg (1024px).
//   - `status` abbreviates `waiting_for_interaction` → `waiting` so the
//     140px column fits; the full label still shows in the drawer.

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

const formatDurationMs = (execution: Execution): string | null => {
  if (execution.startedAt === null || execution.completedAt === null) return null;
  const ms = Math.max(0, execution.completedAt - execution.startedAt);
  return ms.toLocaleString();
};

const truncateCode = (code: string, max: number): string =>
  code.trim().replace(/\s+/g, " ").slice(0, max);

/**
 * Row label for a status. `waiting_for_interaction` gets abbreviated to
 * `waiting` so the status column can fit in 140px — the full label
 * still appears in the drawer's Status meta card.
 */
const statusWord = (status: ExecutionStatus): string => {
  if (status === "waiting_for_interaction") return "waiting";
  return status.replaceAll("_", " ");
};

/**
 * Count `[error]` and `[warn]` lines in the serialized logsJson array.
 * Runtime format is case-sensitive `[level] line` — see
 * `packages/kernel/runtime-quickjs/src/index.ts:127-132`.
 */
const parseLogCounts = (logsJson: string | null): { errors: number; warns: number } => {
  if (!logsJson) return { errors: 0, warns: 0 };
  try {
    const parsed = JSON.parse(logsJson);
    if (!Array.isArray(parsed)) return { errors: 0, warns: 0 };
    let errors = 0;
    let warns = 0;
    for (const line of parsed) {
      if (typeof line !== "string") continue;
      if (line.startsWith("[error]")) errors += 1;
      else if (line.startsWith("[warn]")) warns += 1;
    }
    return { errors, warns };
  } catch {
    return { errors: 0, warns: 0 };
  }
};

export interface RunRowProps {
  readonly execution: Execution;
  readonly isSelected?: boolean;
  /**
   * True when the row is "past" the live cutoff — i.e., it already
   * existed at the moment live mode was turned on. Rendered at half
   * opacity so new arrivals stand out.
   */
  readonly isPast?: boolean;
  /**
   * Per-field visibility from the ViewOptionsButton. Missing keys
   * default to visible. `status` and `code` are always shown.
   */
  readonly visibleFields?: {
    readonly via?: boolean;
    readonly tools?: boolean;
    readonly log?: boolean;
    readonly duration_ms?: boolean;
  };
  readonly onSelect?: () => void;
}

export function RunRow({
  execution,
  isSelected,
  isPast,
  visibleFields,
  onSelect,
}: RunRowProps) {
  const showVia = visibleFields?.via !== false;
  const showTools = visibleFields?.tools !== false;
  const showLog = visibleFields?.log !== false;
  const showDuration = visibleFields?.duration_ms !== false;

  const durationMs = formatDurationMs(execution);
  const durationNumeric = durationMs ? Number(durationMs.replace(/,/g, "")) : null;
  const isSlow = durationNumeric !== null && durationNumeric > 5_000;
  const tone = statusTone(execution.status);
  const trigger = triggerTone(execution.triggerKind);
  const logs = React.useMemo(() => parseLogCounts(execution.logsJson), [execution.logsJson]);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex w-full min-w-0 items-start gap-2 overflow-hidden border-border/40 border-b px-4 py-2",
        "text-left font-mono text-xs transition-colors",
        "hover:bg-foreground/[0.03]",
        isSelected && "bg-foreground/[0.05] hover:bg-foreground/[0.05]",
        isPast && "opacity-50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          tone.dot,
          tone.pulse && "animate-pulse",
        )}
      />

      <HoverCardTimestamp
        date={new Date(execution.createdAt)}
        side="right"
        className="w-[190px] shrink-0 tabular-nums text-muted-foreground"
      />

      <span className="inline-flex w-[140px] shrink-0 gap-1">
        <span className="text-muted-foreground/60">status:</span>
        <span className={tone.text}>{statusWord(execution.status)}</span>
      </span>

      {showVia ? (
        <span className="hidden w-[120px] shrink-0 2xl:inline-flex 2xl:gap-1">
          <span className="text-muted-foreground/60">via:</span>
          <span className={trigger.text}>{trigger.label}</span>
        </span>
      ) : null}

      {showTools ? (
        <span className="hidden w-[88px] shrink-0 gap-1 tabular-nums lg:inline-flex">
          <span className="text-muted-foreground/60">tools:</span>
          <span
            className={cn(
              execution.toolCallCount > 0 ? "text-foreground/80" : "text-muted-foreground/60",
            )}
          >
            {execution.toolCallCount}
          </span>
        </span>
      ) : null}

      {showLog ? (
        <span className="hidden w-[100px] shrink-0 gap-1 tabular-nums 2xl:inline-flex">
          <span className="text-muted-foreground/60">log:</span>
          {logs.errors === 0 && logs.warns === 0 ? (
            <span className="text-muted-foreground/60">—</span>
          ) : (
            <span>
              {logs.errors > 0 ? (
                <span className="text-red-400">{logs.errors}E</span>
              ) : (
                <span className="text-muted-foreground/50">0E</span>
              )}
              <span className="text-muted-foreground/60"> </span>
              {logs.warns > 0 ? (
                <span className="text-amber-400">{logs.warns}W</span>
              ) : (
                <span className="text-muted-foreground/50">0W</span>
              )}
            </span>
          )}
        </span>
      ) : null}

      {showDuration ? (
        <span className="inline-flex w-[130px] shrink-0 gap-1">
          <span className="text-muted-foreground/60">duration_ms:</span>
          <span
            className={cn(
              durationMs === null && "text-muted-foreground/60",
              durationMs !== null && isSlow && "text-destructive",
              durationMs !== null && !isSlow && "text-primary",
            )}
          >
            {durationMs ?? "—"}
          </span>
        </span>
      ) : null}

      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground/60">code: </span>
        <span className="text-foreground/80">
          &quot;{truncateCode(execution.code, 160)}&quot;
        </span>
      </span>
    </button>
  );
}

// `RunRowHeader` used to live here but has been replaced by the
// per-field sortable `RunsColumnHeader` in `./column-header.tsx`.
