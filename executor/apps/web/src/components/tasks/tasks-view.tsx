"use client";

import { useCallback } from "react";
import { useQueryStates } from "nuqs";
import { useNavigate } from "@/lib/router";
import { ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
      <div className="p-4 md:p-6 lg:p-8 space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-4 md:p-6 lg:p-8">
      <div className="mb-4 flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => navigate("/approvals")}>
          <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
          {pendingApprovals.length} pending
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="grid h-full min-h-0 gap-6 lg:grid-cols-[minmax(360px,440px)_1fr]">
          <Card className="bg-card border-border min-h-0 flex flex-col">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                Task History
                {tasks && (
                  <span className="text-[10px] font-mono bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                    {taskItems.length}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 min-h-0 flex-1">
              {tasksLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-14" />
                  ))}
                </div>
              ) : taskItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-sm text-muted-foreground gap-2">
                  <p>No tasks yet.</p>
                </div>
              ) : (
                <div className="h-full overflow-y-auto space-y-1 pr-1">
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
            </CardContent>
          </Card>

          <div className="min-h-0">
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
              <Card className="bg-card border-border h-full">
                <CardContent className="flex items-center justify-center py-24">
                  <p className="text-sm text-muted-foreground">
                    Select a task to view logs, output, and approval actions
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
