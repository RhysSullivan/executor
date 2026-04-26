import * as React from "react";
import type { ExecutionListMeta, ExecutionStatus } from "../../api/executions";

import { cn } from "../../lib/utils";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../accordion";
import { Input } from "../input";
import { STATUS_ORDER, STATUS_LABELS, TRIGGER_ORDER, statusTone, triggerTone } from "./status";

export interface RunsFilterRailProps {
  readonly selectedStatuses: readonly ExecutionStatus[];
  readonly onToggleStatus: (status: ExecutionStatus) => void;
  readonly onOnlyStatus: (status: ExecutionStatus) => void;
  readonly selectedTriggers: readonly string[];
  readonly onToggleTrigger: (trigger: string) => void;
  readonly onOnlyTrigger: (trigger: string) => void;
  /**
   * Tri-state interactions filter: `"true"` → runs that elicited,
   * `"false"` → runs that didn't, `null` → no filter. Only one of
   * the two rows can be checked at a time.
   */
  readonly selectedElicitation: "true" | "false" | null;
  readonly onToggleElicitation: (value: "true" | "false") => void;
  readonly selectedTools: readonly string[];
  readonly onToggleTool: (toolPath: string) => void;
  readonly onOnlyTool: (toolPath: string) => void;
  readonly range: TimeRangePreset;
  readonly onRangeChange: (range: TimeRangePreset) => void;
  readonly codeQuery: string;
  readonly onCodeQueryChange: (value: string) => void;
  readonly onReset: () => void;
  readonly meta?: ExecutionListMeta;
  readonly totalsLine?: string;
}

export type TimeRangePreset = "15m" | "1h" | "24h" | "7d" | "30d" | "all";

export const TIME_RANGE_PRESETS: readonly {
  readonly value: TimeRangePreset;
  readonly label: string;
}[] = [
  { value: "15m", label: "Last 15m" },
  { value: "1h", label: "Last 1h" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
  { value: "all", label: "All time" },
];

/** Resolve a preset to an epoch-ms [from, to] pair. `to` is always "now". */
export const resolveTimeRange = (
  preset: TimeRangePreset,
): { readonly from?: number; readonly to?: number } => {
  if (preset === "all") return {};
  const now = Date.now();
  const deltaMs: Record<Exclude<TimeRangePreset, "all">, number> = {
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };
  return { from: now - deltaMs[preset], to: now };
};

export function RunsFilterRail({
  selectedStatuses,
  onToggleStatus,
  onOnlyStatus,
  selectedTriggers,
  onToggleTrigger,
  onOnlyTrigger,
  selectedElicitation,
  onToggleElicitation,
  selectedTools,
  onToggleTool,
  onOnlyTool,
  range,
  onRangeChange,
  codeQuery,
  onCodeQueryChange,
  onReset,
  meta,
  totalsLine,
}: RunsFilterRailProps) {
  const filtersActive =
    selectedStatuses.length > 0 ||
    selectedTriggers.length > 0 ||
    selectedTools.length > 0 ||
    selectedElicitation !== null ||
    codeQuery.trim().length > 0 ||
    range !== "24h";

  const triggerKeys = React.useMemo(() => {
    const set = new Set<string>(TRIGGER_ORDER);
    if (meta?.triggerCounts) {
      for (const key of Object.keys(meta.triggerCounts)) set.add(key);
    }
    return [...set].sort();
  }, [meta?.triggerCounts]);

  const toolFacets = meta?.toolFacets ?? [];

  return (
    <div className="flex h-full flex-col">
      {/* Title block */}
      <div className="border-border border-b px-4 py-5">
        <h1 className="font-display text-xl tracking-tight text-foreground">Execution history</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Every execution recorded for this scope, newest first.
        </p>
        {totalsLine ? (
          <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
            {totalsLine}
          </p>
        ) : null}
      </div>

      {/* Filters header + reset */}
      <div className="flex items-center justify-between border-border/60 border-b px-4 py-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Filters
        </p>
        {filtersActive ? (
          // oxlint-disable-next-line react/forbid-elements -- inline text button matches the header's uppercase-tracked-wider styling; <Button> is oversized for this slot.
          <button
            type="button"
            onClick={onReset}
            className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 hover:text-foreground"
          >
            Reset
          </button>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        <Accordion
          type="multiple"
          defaultValue={["status", "trigger", "interactions", "time-range", "tools"]}
          className="w-full"
        >
          <FacetSection value="status" label="Status">
            <ul className="space-y-0">
              {STATUS_ORDER.map((status) => {
                const tone = statusTone(status);
                const checked = selectedStatuses.includes(status);
                const count = meta?.statusCounts.find(
                  (c) => c.status === status,
                )?.count;
                return (
                  <li key={status}>
                    <FacetRow
                      checked={checked}
                      onToggle={() => onToggleStatus(status)}
                      onOnly={() => onOnlyStatus(status)}
                      dotClass={cn(tone.dot, tone.pulse && "animate-pulse")}
                      label={STATUS_LABELS[status]}
                      count={count}
                    />
                  </li>
                );
              })}
            </ul>
          </FacetSection>

          <FacetSection value="trigger" label="Trigger">
            <ul className="space-y-0">
              {triggerKeys.map((key) => {
                const tone = triggerTone(key);
                const checked = selectedTriggers.includes(key);
                const count = meta?.triggerCounts.find(
                  (c) => (c.triggerKind ?? "unknown") === key,
                )?.count;
                return (
                  <li key={key}>
                    <FacetRow
                      checked={checked}
                      onToggle={() => onToggleTrigger(key)}
                      onOnly={() => onOnlyTrigger(key)}
                      dotClass={tone.dot}
                      label={tone.label}
                      count={count}
                      monoLabel
                    />
                  </li>
                );
              })}
            </ul>
          </FacetSection>

          <FacetSection value="interactions" label="Interactions">
            <ul className="space-y-0">
              <li>
                <FacetRow
                  checked={selectedElicitation === "true"}
                  onToggle={() => onToggleElicitation("true")}
                  dotClass="bg-[color:var(--color-warning)]"
                  label="Used elicitation"
                  count={meta?.interactionCounts.withElicitation}
                />
              </li>
              <li>
                <FacetRow
                  checked={selectedElicitation === "false"}
                  onToggle={() => onToggleElicitation("false")}
                  dotClass="bg-muted-foreground/40"
                  label="No elicitation"
                  count={meta?.interactionCounts.withoutElicitation}
                />
              </li>
            </ul>
          </FacetSection>

          {toolFacets.length > 0 ? (
            <FacetSection value="tools" label="Tools">
              <ul className="space-y-0">
                {toolFacets.map((facet) => {
                  const checked = selectedTools.includes(facet.toolPath);
                  return (
                    <li key={facet.toolPath}>
                      <FacetRow
                        checked={checked}
                        onToggle={() => onToggleTool(facet.toolPath)}
                        onOnly={() => onOnlyTool(facet.toolPath)}
                        dotClass="bg-foreground/40"
                        label={facet.toolPath}
                        count={facet.count}
                        monoLabel
                      />
                    </li>
                  );
                })}
              </ul>
            </FacetSection>
          ) : null}

          <FacetSection value="time-range" label="Time range">
            <ul className="space-y-0">
              {TIME_RANGE_PRESETS.map((preset) => {
                const active = preset.value === range;
                return (
                  <li key={preset.value}>
                    {/* oxlint-disable-next-line react/forbid-elements -- radio-like list item in a compact filter rail; <Button> would introduce centered alignment + default padding we don't want in a vertical list. */}
                    <button
                      type="button"
                      onClick={() => onRangeChange(preset.value)}
                      className={cn(
                        "flex w-full items-center gap-2.5 py-1 text-left text-xs",
                        "text-muted-foreground hover:text-foreground",
                        active && "text-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-border",
                          active && "border-foreground",
                        )}
                        aria-hidden
                      >
                        {active ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
                      </span>
                      <span className="flex-1">{preset.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </FacetSection>

          <FacetSection value="code" label="Code contains">
            <Input
              type="text"
              value={codeQuery}
              onChange={(event) => onCodeQueryChange(event.currentTarget.value)}
              placeholder="tools.github.list"
              className="h-8 font-mono text-[11px]"
            />
          </FacetSection>
        </Accordion>
      </div>
    </div>
  );
}

function FacetSection({
  value,
  label,
  children,
}: {
  readonly value: string;
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <AccordionItem value={value} className="border-b border-border/40 last:border-b-0">
      <AccordionTrigger className="py-2 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 hover:no-underline hover:text-foreground">
        {label}
      </AccordionTrigger>
      <AccordionContent className="pb-2 pt-0 px-2">{children}</AccordionContent>
    </AccordionItem>
  );
}

function FacetRow({
  checked,
  onToggle,
  onOnly,
  dotClass,
  label,
  count,
  monoLabel,
}: {
  readonly checked: boolean;
  readonly onToggle: () => void;
  readonly onOnly?: () => void;
  readonly dotClass: string;
  readonly label: string;
  readonly count: number | undefined;
  readonly monoLabel?: boolean;
}) {
  return (
    <div className="group relative flex items-center">
      {/* oxlint-disable-next-line react/forbid-elements -- facet row acts as a checkbox + dot + label + count composite; replacing with <Button> would fight the multi-slot flex layout. */}
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex flex-1 items-center gap-2.5 py-1 text-left text-xs",
          "text-muted-foreground hover:text-foreground",
          checked && "text-foreground",
        )}
      >
        <span
          className={cn(
            "inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-border",
            checked && "border-foreground bg-foreground/10",
          )}
          aria-hidden
        >
          {checked ? (
            <svg viewBox="0 0 12 12" className="size-2.5 text-foreground">
              <path
                d="M2 6l3 3 5-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : null}
        </span>

        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dotClass)} />

        <span className={cn("flex-1 truncate", monoLabel && "font-mono text-[11px]")}>{label}</span>

        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/50">
          {count ?? ""}
        </span>
      </button>

      {onOnly ? (
        // oxlint-disable-next-line react/forbid-elements -- tiny "only" affordance overlays the facet row on hover; <Button>'s defaults would push the row height.
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOnly();
          }}
          className={cn(
            "absolute right-0 hidden h-full items-center rounded-sm bg-background px-1.5",
            "font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70",
            "hover:text-foreground group-hover:flex",
          )}
          title="Filter to only this value"
        >
          only
        </button>
      ) : null}
    </div>
  );
}
