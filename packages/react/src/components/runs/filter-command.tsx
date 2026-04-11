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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../dialog";
import {
  FILTER_COMMAND_KEYS,
  parseFilterCommand,
  type RunsFilterTokens,
} from "./filter-command-parser";

// ---------------------------------------------------------------------------
// FilterCommand — openstatus-style cmdk filter palette for /runs
// ---------------------------------------------------------------------------
//
// Entry points:
//   - Hit `/` anywhere on /runs to open the palette.
//   - Click the thin "Filter" bar in the top bar to open it.
//
// Type `status:` / `trigger:` / `tool:` prefixes to discover values
// from the current `meta` — no blind typing required. Press Enter to
// apply.

export interface RunsFilterCommandProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly meta?: ExecutionListMeta;
  readonly onApply: (tokens: RunsFilterTokens) => void;
  /**
   * Pre-fill the input on open. Used so the palette reopens with the
   * last-applied expression for quick tweaks.
   */
  readonly initialValue?: string;
}

export function RunsFilterCommand({
  open,
  onOpenChange,
  meta,
  onApply,
  initialValue,
}: RunsFilterCommandProps) {
  const [value, setValue] = React.useState(initialValue ?? "");

  React.useEffect(() => {
    if (open) {
      setValue(initialValue ?? "");
    }
  }, [open, initialValue]);

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
    onOpenChange(false);
  };

  const handleSuggestionSelect = (suggestion: string) => {
    // Replace the trailing fragment after the active `key:` with the
    // selected value. If the user had a partial like `status:fai`,
    // `status:fai` → `status:failed`.
    const updated = replaceTrailingValue(value, suggestion);
    setValue(updated);
  };

  const handleKeyInsert = (key: string) => {
    // Insert `key:` after a leading space so multiple filters don't
    // collide. If the input is empty, drop the leading space.
    const trimmed = value.trimEnd();
    setValue(trimmed.length === 0 ? `${key}:` : `${trimmed} ${key}:`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader className="sr-only">
        <DialogTitle>Filter runs</DialogTitle>
        <DialogDescription>
          Type filter tokens like `status:failed tool:github.*` and press Enter to apply.
        </DialogDescription>
      </DialogHeader>
      <DialogContent className="overflow-hidden p-0 sm:max-w-2xl" showCloseButton={false}>
        <Command
          shouldFilter={false}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleApply();
            }
          }}
        >
          <CommandInput
            value={value}
            onValueChange={setValue}
            placeholder="status:failed tool:github.* duration_ms:>5000"
            className="font-mono text-xs"
          />
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
                  {/* Openstatus-style focus-only bracket hints */}
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
              <kbd className="rounded-sm border border-border bg-muted/50 px-1 font-sans">↑↓</kbd>
              <span>to navigate</span>
            </span>
            <span className="text-muted-foreground/30">·</span>
            <span className="flex items-center gap-1">
              <kbd className="rounded-sm border border-border bg-muted/50 px-1 font-sans">Enter</kbd>
              <span>to query</span>
            </span>
            <span className="text-muted-foreground/30">·</span>
            <span className="flex items-center gap-1">
              <kbd className="rounded-sm border border-border bg-muted/50 px-1 font-sans">Esc</kbd>
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
              <code className="rounded-sm bg-muted/50 px-1 text-muted-foreground">after:1h</code>
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Trigger strip — thin, always-visible clickable chip above the top bar
// ---------------------------------------------------------------------------
//
// Shows the currently-applied filter expression (or a placeholder)
// with a `/` shortcut hint.

export function RunsFilterCommandTrigger({
  value,
  onClick,
  className,
}: {
  readonly value: string;
  readonly onClick: () => void;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5",
        "font-mono text-[11px] text-muted-foreground",
        "hover:border-foreground/30 hover:text-foreground",
        className,
      )}
    >
      <svg viewBox="0 0 16 16" className="size-3 shrink-0 opacity-60" aria-hidden>
        <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M10.5 10.5L14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span className="flex-1 truncate text-left">
        {value ? value : "Filter runs — status:… trigger:… tool:… code:…"}
      </span>
      <kbd className="hidden shrink-0 rounded border border-border bg-muted/30 px-1 text-[10px] text-muted-foreground/70 sm:inline-block">
        /
      </kbd>
    </button>
  );
}

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
