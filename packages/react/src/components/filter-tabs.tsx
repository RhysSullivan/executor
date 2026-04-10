"use client";

import type { ReactNode } from "react";
import { Button } from "./button";
import { cn } from "../lib/utils";

export interface FilterTab<T extends string = string> {
  label: ReactNode;
  value: T;
  count?: number;
}

interface FilterTabsProps<T extends string = string> {
  tabs: FilterTab<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function FilterTabs<T extends string = string>({
  tabs,
  value,
  onChange,
}: FilterTabsProps<T>) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tabs.map((tab) => {
        const isActive = value === tab.value;
        return (
          <Button
            variant="outline"
            size="sm"
            key={tab.value}
            onClick={() => onChange(tab.value)}
            className={cn(
              "shadow-none",
              isActive
                ? "inline-flex items-center justify-center gap-1.5 rounded-full border border-border bg-white px-2.5 py-1 text-sm font-medium text-foreground transition-transform duration-100 active:scale-[0.98]"
                : "inline-flex items-center justify-center gap-1.5 rounded-full border border-transparent bg-transparent px-2.5 py-1 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-transform duration-100 active:scale-[0.98]",
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={`inline-flex items-center justify-center rounded-full text-xs tabular-nums min-w-[18px] h-[18px] px-1 ${isActive ? "bg-muted text-foreground" : "bg-muted/60 text-muted-foreground"}`}
              >
                {tab.count}
              </span>
            )}
          </Button>
        );
      })}
    </div>
  );
}
