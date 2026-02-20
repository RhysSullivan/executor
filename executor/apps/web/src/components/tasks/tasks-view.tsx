"use client";

import { useCallback } from "react";
import { useQueryStates } from "nuqs";
import { useNavigate } from "@/lib/router";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TaskDetail } from "@/components/tasks/task-detail";
import { TaskListItem } from "@/components/tasks/task/list-item";
import { useSession } from "@/lib/session-context";
import { useQuery } from "convex/react";
import { convexApi } from "@/lib/convex-api";
import { workspaceQueryArgs } from "@/lib/workspace/query-args";
import { listRuntimeTargets } from "@/lib/runtime-targets";
import type {
  TaskRecord,
  PendingApprovalRecord,
} from "@/lib/types";
import { getTaskRuntimeLabel } from "@/lib/runtime-display";
import { taskQueryParsers } from "@/lib/url-state/tasks";
// ── Tasks View ──

export function TasksView() {
  const { context, loading: sessionLoading } = useSession();
  const navigate = useNavigate();
  const [taskQueryState, setTaskQueryState] = useQueryStates(taskQueryParsers, {
    history: "replace",
  });
  const selectedId = taskQueryState.selected;

  const tasks = useQuery(
    convexApi.workspace.listTasks,
    workspaceQueryArgs(context),
  );
  const tasksLoading = !!context && tasks === undefined;
  const taskItems = tasks ?? [];

  const runtimeItems = listRuntimeTargets();

  const approvals = useQuery(
    convexApi.workspace.listPendingApprovals,
    workspaceQueryArgs(context),
  );
  const pendingApprovals = approvals ?? [];

  const selectedTask = taskItems.find((t: TaskRecord) => t.id === selectedId);
  const selectedTaskApprovals = selectedTask
    ? pendingApprovals.filter((approval: PendingApprovalRecord) => approval.taskId === selectedTask.id)
    : [];

  const selectTask = useCallback(
    (taskId: string | null) => {
      void setTaskQueryState({ selected: taskId }, { history: "replace" });
    },
    [setTaskQueryState],
  );

  if (sessionLoading) {
    return (
      <div className="flex h-full min-h-0 overflow-hidden bg-background">
        <div className="w-80 shrink-0 border-r border-border/40 p-3 space-y-3">
          <Skeleton className="h-8 w-full" />
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
        <div className="flex-1 p-4">
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background">
      {/* ── Left sidebar: task list ── */}
      <aside className="flex h-full w-80 shrink-0 flex-col border-r border-border/40 bg-card/30 lg:w-[360px]">
        {/* Sidebar header */}
        <div className="shrink-0 border-b border-border/30 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium leading-none">Tasks</h3>
              {tasks && (
                <span className="text-[10px] font-mono bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                  {taskItems.length}
                </span>
              )}
            </div>
            <Button variant="outline" size="sm" className="h-7 text-[10px] gap-1" onClick={() => navigate("/approvals")}>
              <ShieldCheck className="h-3 w-3" />
              {pendingApprovals.length} pending
            </Button>
          </div>
        </div>

        {/* Task list */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {tasksLoading ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : taskItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-sm text-muted-foreground gap-2 px-4">
              <p>No tasks yet.</p>
              <p className="text-[11px] text-muted-foreground/60">
                Execute a task from the editor to see it here.
              </p>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {taskItems.map((task: TaskRecord) => (
                <TaskListItem
                  key={task.id}
                  task={task}
                  selected={task.id === selectedId}
                  runtimeLabel={getTaskRuntimeLabel(task.runtimeId, runtimeItems)}
                  onClick={() => selectTask(task.id)}
                />
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* ── Right content: task detail ── */}
      <div className="flex-1 min-w-0 max-h-screen overflow-y-auto bg-background/50">
        {selectedTask && context ? (
          <TaskDetail
            task={selectedTask}
            workspaceId={context.workspaceId}
            sessionId={context?.sessionId}
            runtimeLabel={getTaskRuntimeLabel(selectedTask.runtimeId, runtimeItems)}
            pendingApprovals={selectedTaskApprovals}
            onClose={() => selectTask(null)}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Select a task to view logs, output, and approval actions
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
