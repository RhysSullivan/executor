"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Play,
  ShieldCheck,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowRight,
  Wrench,
  ChevronRight,
  Server,
  Globe,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { TaskStatusBadge } from "@/components/status-badge";
import { useSession } from "@/lib/session-context";
import { useWorkspaceTools } from "@/hooks/use-workspace-tools";
import { useQuery } from "convex/react";
import { convexApi } from "@/lib/convex-api";
import type { TaskRecord, PendingApprovalRecord, ToolDescriptor } from "@/lib/types";
import { formatTime, formatTimeAgo } from "@/lib/format";

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

/** Derive the "source name" from a tool's source field (e.g. "openapi:github" → "github"). */
function sourceLabel(source?: string): string {
  if (!source) return "built-in";
  const colonIdx = source.indexOf(":");
  return colonIdx >= 0 ? source.slice(colonIdx + 1) : source;
}

/** Derive the source type prefix (e.g. "openapi", "mcp", "graphql"). */
function sourceType(source?: string): string {
  if (!source) return "local";
  const colonIdx = source.indexOf(":");
  return colonIdx >= 0 ? source.slice(0, colonIdx) : "local";
}

function ToolsSummaryCard({ tools }: { tools: ToolDescriptor[] }) {
  const router = useRouter();

  const groups = useMemo(() => {
    const map = new Map<
      string,
      {
        name: string;
        type: string;
        tools: ToolDescriptor[];
        namespaces: Set<string>;
        approvalCount: number;
      }
    >();

    for (const tool of tools) {
      const name = sourceLabel(tool.source);
      const type = sourceType(tool.source);
      let group = map.get(name);
      if (!group) {
        group = { name, type, tools: [], namespaces: new Set(), approvalCount: 0 };
        map.set(name, group);
      }
      group.tools.push(tool);
      // Extract namespace: first two segments of the path (e.g. "github.repos" from "github.repos.list")
      const parts = tool.path.split(".");
      if (parts.length >= 2) {
        group.namespaces.add(`${parts[0]}.${parts[1]}`);
      }
      if (tool.approval === "required") {
        group.approvalCount++;
      }
    }

    return Array.from(map.values()).sort((a, b) => b.tools.length - a.tools.length);
  }, [tools]);

  const totalApprovals = tools.filter((t) => t.approval === "required").length;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Wrench className="h-4 w-4 text-muted-foreground" />
            Tool Sources
            <span className="text-[10px] font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded">
              {tools.length} tools
            </span>
            {totalApprovals > 0 && (
              <span className="text-[10px] font-mono bg-terminal-amber/10 text-terminal-amber px-1.5 py-0.5 rounded">
                {totalApprovals} gated
              </span>
            )}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-7"
            onClick={() => router.push("/tools")}
          >
            Manage
            <ArrowRight className="h-3 w-3 ml-1" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid gap-1">
          {groups.map((group) => {
            const SourceIcon = group.type === "mcp" ? Server : Globe;
            return (
              <button
                key={group.name}
                onClick={() => router.push(`/tools?source=${encodeURIComponent(group.name)}`)}
                className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent/40 transition-colors text-left group/row w-full"
              >
                <div className="h-7 w-7 rounded bg-muted flex items-center justify-center shrink-0">
                  <SourceIcon className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono font-medium text-foreground">
                      {group.name}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
                      {group.type}
                    </span>
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    {group.tools.length} tool{group.tools.length !== 1 ? "s" : ""}
                    {group.namespaces.size > 0 && (
                      <> · {group.namespaces.size} namespace{group.namespaces.size !== 1 ? "s" : ""}</>
                    )}
                    {group.approvalCount > 0 && (
                      <> · <span className="text-terminal-amber">{group.approvalCount} gated</span></>
                    )}
                  </span>
                </div>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0" />
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export function DashboardView() {
  const { context, loading: sessionLoading } = useSession();

  const tasks = useQuery(
    convexApi.workspace.listTasks,
    context ? { workspaceId: context.workspaceId, sessionId: context.sessionId } : "skip",
  );

  const approvals = useQuery(
    convexApi.workspace.listPendingApprovals,
    context ? { workspaceId: context.workspaceId, sessionId: context.sessionId } : "skip",
  );

  const { tools } = useWorkspaceTools(context ?? null);

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
    tasks?.filter((t: TaskRecord) => t.status === "running").length ?? 0;
  const completedCount =
    tasks?.filter((t: TaskRecord) => t.status === "completed").length ?? 0;
  const failedCount =
    tasks?.filter((t: TaskRecord) => ["failed", "timed_out", "denied"].includes(t.status))
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
                {(approvals ?? []).slice(0, 5).map((a: PendingApprovalRecord) => (
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
                {recentTasks.map((t: TaskRecord) => (
                  <RecentTaskRow key={t.id} task={t} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Tools summary — grouped by source */}
      {tools.length > 0 && <ToolsSummaryCard tools={tools} />}
    </div>
  );
}
