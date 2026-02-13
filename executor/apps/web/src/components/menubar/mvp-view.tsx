"use client";

import { Bell, Sparkles } from "lucide-react";
import { useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { PendingApprovalList, usePendingApprovals } from "@executor/ui";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { convexApi } from "@/lib/convex-api";
import { useSession } from "@/lib/session-context";
import type { TaskRecord } from "@/lib/types";
import { workspaceQueryArgs } from "@/lib/workspace-query-args";
import { getTaskRuntimeLabel } from "@/lib/runtime-display";

export function MenubarMvpView() {
  const navigate = useNavigate();
  const { context, loading: sessionLoading } = useSession();
  const {
    approvals,
    loading: approvalsLoading,
    resolvingApprovalId,
    approve,
    deny,
  } = usePendingApprovals(
    context
      ? {
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
        }
      : null,
  );
  const tasks = useQuery(
    convexApi.workspace.listTasks,
    workspaceQueryArgs(context),
  );
  const tasksLoading = Boolean(context) && tasks === undefined;
  const recentTasks = (tasks ?? []).slice(0, 8) as TaskRecord[];

  const runtimeTargets = useQuery(
    convexApi.workspace.listRuntimeTargets,
    context ? {} : "skip",
  );

  const runtimeTargetItems = runtimeTargets ?? [];

  if (sessionLoading) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 md:p-4">
      <section className="rounded-lg border border-border bg-card px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Menu bar MVP</p>
            <p className="text-xs text-muted-foreground">
              Run AI tasks quickly and resolve approvals without leaving your flow.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => navigate("/tools?tab=editor")}>
              Open Editor
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => navigate("/approvals")}>
              Open Approvals
            </Button>
          </div>
        </div>
      </section>

      {!context ? (
        <section className="rounded-lg border border-border bg-card px-3 py-2.5">
          <p className="text-xs text-muted-foreground">
            No active workspace in this session yet. Open the full console to sign in or create a workspace.
          </p>
        </section>
      ) : null}

      <section className="rounded-lg border border-border bg-card px-3 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Bell className="h-4 w-4 text-amber-500" />
            Pending approvals
          </p>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {approvals.length}
          </span>
        </div>

        {approvalsLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <PendingApprovalList
            approvals={approvals}
            resolvingApprovalId={resolvingApprovalId}
            onApprove={approve}
            onDeny={deny}
            onOpenTask={() => navigate("/approvals")}
            emptyLabel="No pending approvals right now."
          />
        )}
      </section>

      <section className="rounded-lg border border-border bg-card px-3 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Sparkles className="h-4 w-4 text-primary" />
            Recent AI tasks
          </p>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => navigate("/tools?tab=editor")}>Open Editor</Button>
        </div>

        {tasksLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : recentTasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">No tasks yet. Use the full console to start one.</p>
        ) : (
          <div className="space-y-1.5">
            {recentTasks.map((task) => (
              <button
                key={task.id}
                type="button"
                className="flex w-full items-center justify-between rounded border border-border bg-background px-2.5 py-2 text-left hover:bg-accent"
                onClick={() => navigate("/tools?tab=editor")}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[11px] font-mono text-foreground">{task.id}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {getTaskRuntimeLabel(task.runtimeId, runtimeTargetItems)}
                  </span>
                </span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                  {task.status}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
