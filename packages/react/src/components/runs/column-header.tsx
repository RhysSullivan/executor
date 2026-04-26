import * as React from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { cn } from "../../lib/utils";

export type SortField = "createdAt" | "durationMs";
export type SortDirection = "asc" | "desc";
export type SortState = {
  readonly field: SortField;
  readonly direction: SortDirection;
} | null;

export interface RunsColumnHeaderProps {
  readonly sort: SortState;
  readonly onSort: (field: SortField) => void;
  readonly visibleFields?: {
    readonly via?: boolean;
    readonly tools?: boolean;
    readonly log?: boolean;
    readonly duration_ms?: boolean;
  };
}

export function RunsColumnHeader({ sort, onSort, visibleFields }: RunsColumnHeaderProps) {
  const showVia = visibleFields?.via !== false;
  const showTools = visibleFields?.tools !== false;
  const showLog = visibleFields?.log !== false;
  const showDuration = visibleFields?.duration_ms !== false;

  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
      {/* dot column (spacer to match row layout) */}
      <span aria-hidden className="size-2 shrink-0" />

      <SortHeader
        className="w-[150px] shrink-0 md:w-[190px]"
        label="_time"
        field="createdAt"
        currentSort={sort}
        onSort={onSort}
      />

      <span className="w-[120px] shrink-0 md:w-[140px]">status</span>

      {showVia ? <span className="hidden w-[120px] shrink-0 2xl:inline">via</span> : null}

      {showTools ? <span className="hidden w-[88px] shrink-0 xl:inline">tools</span> : null}

      {showLog ? <span className="hidden w-[100px] shrink-0 2xl:inline">log</span> : null}

      {showDuration ? (
        <SortHeader
          className="hidden w-[130px] shrink-0 md:inline-flex"
          label="duration_ms"
          field="durationMs"
          currentSort={sort}
          onSort={onSort}
        />
      ) : null}

      <span className="min-w-0 flex-1 truncate">code</span>
    </div>
  );
}

function SortHeader({
  label,
  field,
  currentSort,
  onSort,
  className,
}: {
  readonly label: string;
  readonly field: SortField;
  readonly currentSort: SortState;
  readonly onSort: (field: SortField) => void;
  readonly className?: string;
}) {
  const isActive = currentSort?.field === field;
  const direction = isActive ? currentSort.direction : null;
  const Icon = direction === "desc" ? ArrowDown : direction === "asc" ? ArrowUp : ArrowUpDown;

  return (
    // oxlint-disable-next-line react/forbid-elements -- column headers are dense table-level affordances; <Button>'s default padding/height breaks row alignment.
    <button
      type="button"
      onClick={() => onSort(field)}
      className={cn(
        "group inline-flex items-center gap-1 text-left",
        "text-[10px] font-medium uppercase tracking-wider",
        "text-muted-foreground/60 hover:text-foreground",
        isActive && "text-foreground",
        className,
      )}
    >
      <span>{label}</span>
      <Icon className={cn("size-3 shrink-0", !isActive && "opacity-40")} />
    </button>
  );
}
