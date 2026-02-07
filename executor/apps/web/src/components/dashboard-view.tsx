"use client";

import { useRouter } from "next/navigation";
import {
  Play,
  ShieldCheck,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { TaskStatusBadge } from "@/components/status-badge";
import { useSession } from "@/lib/session-context";
import { usePoll } from "@/hooks/use-poll";
import * as api from "@/lib/api";
import type { TaskRecord, PendingApprovalRecord } from "@/lib/types";

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatTimeAgo(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function StatCard({
  label,
  value,
  icon: Icon,
  accent,
}: {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  accent?: "green" | "amber" | "red" | "default";
}) {
  const accentClass = {
    green: "text-terminal-green",
    amber: "text-terminal-amber",
    red: "text-terminal-red",
    default: "text-muted-foreground",
  }[accent ?? "default"];

  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
              {label}
            </p>
            <p className={`text-2xl font-semibold mt-1 font-mono ${accentClass}`}>
              {value}
            </p>
          </div>
          <div className={`${accentClass} opacity-40`}>
            <Icon className="h-8 w-8" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PendingApprovalRow({ approval }: { approval: PendingApprovalRecord }) {
  const router = useRouter();
  return (
    <button
      onClick={() => router.push("/approvals")}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-accent/50 transition-colors text-left group"
    >
      <div className="h-2 w-2 rounded-full bg-terminal-amber pulse-dot shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-sm font-mono text-foreground">
          {approval.toolPath}
        </span>
        <span className="text-[11px] text-muted-foreground ml-2">
          {formatTimeAgo(approval.createdAt)}
        </span>
      </div>
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </button>
  );
}

function RecentTaskRow({ task }: { task: TaskRecord }) {
  const router = useRouter();
  return (
    <button
      onClick={() => router.push(`/tasks?selected=${task.id}`)}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-accent/50 transition-colors text-left group"
    >
      <div className="flex-1 min-w-0">
        <span className="text-sm font-mono text-foreground truncate block">
          {task.id}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {task.runtimeId} &middot; {formatTime(task.createdAt)}
        </span>
      </div>
      <TaskStatusBadge status={task.status} />
    </button>
  );
}

export function DashboardView() {
  const { context, loading: sessionLoading } = useSession();

  const { data: tasks } = usePoll({
    fetcher: () => api.listTasks(context!.workspaceId),
    enabled: !!context,
  });

  const { data: approvals } = usePoll({
    fetcher: () => api.listPendingApprovals(context!.workspaceId),
    enabled: !!context,
  });

  const { data: tools } = usePoll({
    fetcher: () =>
      api.listToolsForContext({
        workspaceId: context!.workspaceId,
        actorId: context!.actorId,
        clientId: context!.clientId,
      }),
    enabled: !!context,
    interval: 10000,
  });

  if (sessionLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      </div>
    );
  }

  const pendingCount = approvals?.length ?? 0;
  const runningCount =
    tasks?.filter((t) => t.status === "running").length ?? 0;
  const completedCount =
    tasks?.filter((t) => t.status === "completed").length ?? 0;
  const failedCount =
    tasks?.filter((t) => ["failed", "timed_out", "denied"].includes(t.status))
      .length ?? 0;
  const recentTasks = (tasks ?? []).slice(0, 8);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Overview of your executor workspace"
      />

      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Pending Approvals"
          value={pendingCount}
          icon={ShieldCheck}
          accent={pendingCount > 0 ? "amber" : "default"}
        />
        <StatCard
          label="Running"
          value={runningCount}
          icon={Play}
          accent={runningCount > 0 ? "green" : "default"}
        />
        <StatCard
          label="Completed"
          value={completedCount}
          icon={CheckCircle2}
          accent="green"
        />
        <StatCard
          label="Failed"
          value={failedCount}
          icon={XCircle}
          accent={failedCount > 0 ? "red" : "default"}
        />
      </div>

      {/* Two column layout */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Pending approvals */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-terminal-amber" />
                Pending Approvals
                {pendingCount > 0 && (
                  <span className="text-[10px] font-mono bg-terminal-amber/15 text-terminal-amber px-1.5 py-0.5 rounded">
                    {pendingCount}
                  </span>
                )}
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-7"
                asChild
              >
                <a href="/approvals">View all</a>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {pendingCount === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 mr-2 text-terminal-green/50" />
                No pending approvals
              </div>
            ) : (
              <div className="space-y-0.5">
                {(approvals ?? []).slice(0, 5).map((a) => (
                  <PendingApprovalRow key={a.id} approval={a} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent tasks */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                Recent Tasks
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-7"
                asChild
              >
                <a href="/tasks">View all</a>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {recentTasks.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                No tasks yet
              </div>
            ) : (
              <div className="space-y-0.5">
                {recentTasks.map((t) => (
                  <RecentTaskRow key={t.id} task={t} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Tools summary */}
      {tools && tools.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              Available Tools
              <span className="text-[10px] font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                {tools.length}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex flex-wrap gap-2">
              {tools.map((tool) => (
                <span
                  key={tool.path}
                  className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded bg-muted text-muted-foreground"
                >
                  {tool.approval === "required" && (
                    <ShieldCheck className="h-3 w-3 text-terminal-amber" />
                  )}
                  {tool.path}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
