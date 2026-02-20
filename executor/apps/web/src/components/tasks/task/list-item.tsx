"use client";

import { ChevronRight } from "lucide-react";
import { TaskStatusBadge } from "@/components/status-badge";
import type { TaskRecord } from "@/lib/types";
import { cn } from "@/lib/utils";

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type TaskListItemProps = {
  task: TaskRecord;
  selected: boolean;
  onClick: () => void;
  runtimeLabel?: string;
};

export function TaskListItem({ task, selected, onClick, runtimeLabel = task.runtimeId }: TaskListItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2.5 rounded-md transition-colors text-left group",
        selected
          ? "bg-primary/10 border border-primary/20"
          : "hover:bg-accent/50 border border-transparent",
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {task.id}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground">
            {runtimeLabel}
          </span>
          <span className="text-xs text-muted-foreground">
            {formatDate(task.createdAt)}
          </span>
        </div>
      </div>
      <TaskStatusBadge status={task.status} />
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </button>
  );
}
