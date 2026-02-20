"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TaskStatus } from "@/lib/types";

const TASK_STATUS_CONFIG: Record<
  TaskStatus,
  { label: string; className: string }
> = {
  queued: {
    label: "Queued",
    className: "bg-muted text-muted-foreground border-muted",
  },
  running: {
    label: "Running",
    className:
      "bg-terminal-amber/10 text-terminal-amber border-terminal-amber/30",
  },
  completed: {
    label: "Completed",
    className:
      "bg-terminal-green/10 text-terminal-green border-terminal-green/30",
  },
  failed: {
    label: "Failed",
    className: "bg-terminal-red/10 text-terminal-red border-terminal-red/30",
  },
  timed_out: {
    label: "Timed Out",
    className: "bg-terminal-red/10 text-terminal-red border-terminal-red/30",
  },
  denied: {
    label: "Denied",
    className: "bg-terminal-red/10 text-terminal-red border-terminal-red/30",
  },
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const config = TASK_STATUS_CONFIG[status];
  return (
    <Badge
      variant="outline"
      className={cn("text-xs font-medium", config.className)}
    >
      {status === "running" && (
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current mr-1.5 pulse-dot" />
      )}
      {config.label}
    </Badge>
  );
}
