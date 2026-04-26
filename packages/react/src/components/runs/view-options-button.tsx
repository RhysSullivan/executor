import * as React from "react";
import { Settings2 } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../button";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";

// ---------------------------------------------------------------------------
// ViewOptionsButton — row field visibility toggle
// ---------------------------------------------------------------------------
//
// Adapted from openstatus `data-table-view-options.tsx` (which toggles column
// visibility). We're flat-row so there are no columns — instead, this toggles
// which inline key-value fields the row renders. Persisted to localStorage via
// the `useLocalStorage` hook so the user's preferences survive reloads.

export type RunFieldKey = "via" | "tools" | "log" | "duration_ms";

export const RUN_FIELD_LABELS: Record<RunFieldKey, string> = {
  via: "Trigger (via:)",
  tools: "Tool calls (tools:)",
  log: "Log levels (log:)",
  duration_ms: "Duration (duration_ms:)",
};

export const DEFAULT_FIELD_VISIBILITY: Record<RunFieldKey, boolean> = {
  via: true,
  tools: true,
  log: true,
  duration_ms: true,
};

const FIELD_ORDER: readonly RunFieldKey[] = ["via", "tools", "log", "duration_ms"];

export interface ViewOptionsButtonProps {
  readonly visible: Record<RunFieldKey, boolean>;
  readonly onToggle: (key: RunFieldKey) => void;
}

export function ViewOptionsButton({ visible, onToggle }: ViewOptionsButtonProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shadow-none"
          title="View options"
          aria-label="View options"
        >
          <Settings2 className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2">
        <div className="mb-1 px-2 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Row fields
        </div>
        {FIELD_ORDER.map((field) => {
          const checked = visible[field] !== false;
          return (
            // oxlint-disable-next-line react/forbid-elements -- dropdown menu row with a leading checkbox span; <Button> doesn't fit this left-aligned multi-part layout.
            <button
              key={field}
              type="button"
              onClick={() => onToggle(field)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/50"
            >
              <span
                aria-hidden
                className={cn(
                  "inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-border",
                  checked && "border-foreground bg-foreground/10",
                )}
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
              <span className="text-foreground">{RUN_FIELD_LABELS[field]}</span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
