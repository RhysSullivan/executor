import * as React from "react";

export function LiveRow() {
  return (
    <div
      aria-label="Live cutoff"
      className="relative flex h-0 w-full items-center border-t border-[color:var(--color-info)]/80"
    >
      <span className="absolute left-4 -top-[9px] rounded-sm bg-background px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[color:var(--color-info)]">
        ● Live · now
      </span>
    </div>
  );
}
