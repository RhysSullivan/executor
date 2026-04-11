"use client";

import * as React from "react";
import type { ExecutionListMeta } from "@executor/sdk";

import { cn } from "../../lib/utils";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "../command";
import {
  FILTER_COMMAND_KEYS,
  parseFilterCommand,
  type RunsFilterTokens,
} from "./filter-command-parser";

// ---------------------------------------------------------------------------
// RunsFilterCommand — inline cmdk palette (openstatus /infinite pattern)
// ---------------------------------------------------------------------------
//
// Always-visible search input in the top bar. Focus (or `/` hotkey via the
// forwarded ref) opens an absolutely-positioned dropdown below the input
// with suggestions + grammar footer. Enter applies, Escape or blur closes.
//
// Ported shape from `~/Developer/openstatus-data-table/src/components/data-table/
// data-table-filter-command/index.tsx:165-398`. We use a plain `div.relative`
// as the positioning context and toggle the dropdown via a local `open`
// state. No Radix Popover — openstatus keeps the dropdown inline in the
// same DOM subtree so it participates in the form's blur behavior.
//
// `/` hotkey in `runs.tsx` grabs the forwarded ref and calls `.focus()`,
// which triggers `onFocus → setOpen(true)`.

export interface RunsFilterCommandProps {
  readonly meta?: ExecutionListMeta;
  readonly onApply: (tokens: RunsFilterTokens) => void;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /**
   * Called whenever the dropdown's open state changes. Parent uses this
   * to guard conflicting hotkeys (e.g. `b` → rail collapse) while the
   * palette is active.
   */
  readonly onOpenChange?: (open: boolean) => void;
}

export const RunsFilterCommand = React.forwardRef<HTMLInputElement, RunsFilterCommandProps>(
  function RunsFilterCommand({ meta, onApply, value, onValueChange, onOpenChange }, forwardedRef) {
    const [open, setOpen] = React.useState(false);
    const containerRef = React.useRef<HTMLDivElement>(null);
    const inputRef = React.useRef<HTMLInputElement>(null);

    // Forward the input ref so the parent can focus from a `/` hotkey.
    React.useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement, []);

    // Notify parent when open state changes so it can guard conflicting
    // hotkeys like `b` (rail toggle) while the palette is active.
    React.useEffect(() => {
      onOpenChange?.(open);
    }, [open, onOpenChange]);

    // Close on click outside the container.
    React.useEffect(() => {
      if (!open) return;
      const handlePointer = (event: PointerEvent) => {
        const target = event.target as Node | null;
        if (!containerRef.current || !target) return;
        if (!containerRef.current.contains(target)) {
          setOpen(false);
        }
      };
      window.addEventListener("pointerdown", handlePointer);
      return () => window.removeEventListener("pointerdown", handlePointer);
    }, [open]);

    const currentKey = React.useMemo(() => detectActiveKey(value), [value]);

    const suggestions = React.useMemo(() => {
      if (!currentKey) return [];
      switch (currentKey) {
        case "status":
          return Object.entries(meta?.statusCounts ?? {}).map(([status, count]) => ({
            label: status,
            hint: `${count}`,
          }));
        case "trigger":
          return Object.entries(meta?.triggerCounts ?? {}).map(([trigger, count]) => ({
            label: trigger,
            hint: `${count}`,
          }));
        case "tool":
          return (meta?.toolFacets ?? []).map((facet) => ({
            label: facet.toolPath,
            hint: `${facet.count}`,
          }));
        default:
          return [];
      }
    }, [currentKey, meta]);

    const handleApply = () => {
      const tokens = parseFilterCommand(value);
      onApply(tokens);
      setOpen(false);
      inputRef.current?.blur();
    };

    const handleSuggestionSelect = (suggestion: string) => {
      const updated = replaceTrailingValue(value, suggestion);
      onValueChange(updated);
      inputRef.current?.focus();
    };

    const handleKeyInsert = (key: string) => {
      const trimmed = value.trimEnd();
      onValueChange(trimmed.length === 0 ? `${key}:` : `${trimmed} ${key}:`);
      inputRef.current?.focus();
    };

    return (
      <div ref={containerRef} className="relative w-full">
        <Command
          shouldFilter={false}
          className="overflow-visible bg-transparent"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleApply();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              inputRef.current?.blur();
            }
          }}
        >
          <CommandInput
            ref={inputRef}
            value={value}
            onValueChange={onValueChange}
            onFocus={() => setOpen(true)}
            placeholder="Filter runs — status:… trigger:… tool:… code:…"
            className="font-mono text-xs"
          />

          {open ? (
            <div
              className={cn(
                "absolute top-full left-0 right-0 z-20 mt-1",
                "overflow-hidden rounded-md border border-border",
                "bg-popover text-popover-foreground shadow-md",
              )}
            >
              <CommandList className="max-h-[420px]">
                {suggestions.length > 0 ? (
                  <CommandGroup heading={`${currentKey}:`}>
                    {suggestions.map((suggestion) => (
                      <CommandItem
                        key={suggestion.label}
                        value={suggestion.label}
                        onSelect={() => handleSuggestionSelect(suggestion.label)}
                      >
                        <span className="font-mono text-xs">{suggestion.label}</span>
                        <CommandShortcut>{suggestion.hint}</CommandShortcut>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : (
                  <CommandEmpty>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      No live suggestions for this token.
                    </span>
                  </CommandEmpty>
                )}

                <CommandSeparator />

                <CommandGroup heading="Add filter">
                  {FILTER_COMMAND_KEYS.map((entry) => (
                    <CommandItem
                      key={entry.key}
                      value={`key-${entry.key}`}
                      onSelect={() => handleKeyInsert(entry.key)}
                      className="group"
                    >
                      <span className="font-mono text-xs text-foreground">{entry.key}:</span>
                      <span className="text-[11px] text-muted-foreground">{entry.description}</span>
                      {/* Focus-only bracket hints */}
                      {entry.hints && entry.hints.length > 0 ? (
                        <span className="ml-auto hidden gap-1 group-aria-selected:flex group-data-[selected=true]:flex">
                          {entry.hints.map((hint) => (
                            <span
                              key={hint}
                              className="rounded-sm bg-muted/60 px-1 font-mono text-[10px] text-muted-foreground"
                            >
                              {hint}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>

                <CommandSeparator />

                <CommandGroup heading="Apply">
                  <CommandItem value="apply-filters" onSelect={handleApply}>
                    <span className="text-xs font-medium text-foreground">Apply filters</span>
                    <CommandShortcut>Enter</CommandShortcut>
                  </CommandItem>
                </CommandGroup>
              </CommandList>

              {/* Grammar footer — openstatus /infinite style */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 bg-muted/20 px-3 py-2 font-mono text-[10px] text-muted-foreground/70">
                <span className="flex items-center gap-1">
                  <span>Use</span>
                  <kbd className="rounded-sm border border-border bg-muted/50 px-1 font-sans">
                    ↑↓
                  </kbd>
                  <span>to navigate</span>
                </span>
                <span className="text-muted-foreground/30">·</span>
                <span className="flex items-center gap-1">
                  <kbd className="rounded-sm border border-border bg-muted/50 px-1 font-sans">
                    Enter
                  </kbd>
                  <span>to query</span>
                </span>
                <span className="text-muted-foreground/30">·</span>
                <span className="flex items-center gap-1">
                  <kbd className="rounded-sm border border-border bg-muted/50 px-1 font-sans">
                    Esc
                  </kbd>
                  <span>to close</span>
                </span>
                <span className="text-muted-foreground/30">·</span>
                <span>
                  Union:{" "}
                  <code className="rounded-sm bg-muted/50 px-1 text-muted-foreground">
                    status:failed,completed
                  </code>
                </span>
                <span className="text-muted-foreground/30">·</span>
                <span>
                  Range:{" "}
                  <code className="rounded-sm bg-muted/50 px-1 text-muted-foreground">
                    duration_ms:&gt;5000
                  </code>
                </span>
                <span className="text-muted-foreground/30">·</span>
                <span>
                  Time:{" "}
                  <code className="rounded-sm bg-muted/50 px-1 text-muted-foreground">
                    after:1h
                  </code>
                </span>
              </div>
            </div>
          ) : null}
        </Command>
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEY_PATTERN = /(status|trigger|tool|code|duration_ms|after|before):([^\s]*)$/;

/**
 * Detect the key the user is currently typing a value for. Used to
 * tailor the suggestion list to the trailing `key:` fragment.
 */
const detectActiveKey = (input: string): string | null => {
  const match = KEY_PATTERN.exec(input);
  return match ? match[1]! : null;
};

/**
 * Replace the in-progress trailing `key:partial` fragment with
 * `key:value`. If there's no trailing fragment, append.
 */
const replaceTrailingValue = (input: string, value: string): string => {
  const match = KEY_PATTERN.exec(input);
  if (!match) return input ? `${input} ${value}` : value;
  const key = match[1]!;
  const before = input.slice(0, match.index);
  return `${before}${key}:${value}`;
};
