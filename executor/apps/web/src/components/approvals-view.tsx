"use client";

import { useState } from "react";
import {
  ShieldCheck,
  ShieldX,
  RefreshCw,
  CheckCircle2,
  Clock,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/page-header";
import { TaskStatusBadge } from "@/components/status-badge";
import { useSession } from "@/lib/session-context";
import { usePoll } from "@/hooks/use-poll";
import * as api from "@/lib/api";
import type { PendingApprovalRecord } from "@/lib/types";
import { toast } from "sonner";

function formatTimeAgo(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: PendingApprovalRecord;
  onResolve: () => void;
}) {
  const { context } = useSession();
  const [resolving, setResolving] = useState<"approved" | "denied" | null>(
    null,
  );

  const handleResolve = async (decision: "approved" | "denied") => {
    if (!context) return;
    setResolving(decision);
    try {
      await api.resolveApproval(approval.id, {
        workspaceId: context.workspaceId,
        decision,
        reviewerId: context.actorId,
      });
      toast.success(
        decision === "approved"
          ? `Approved: ${approval.toolPath}`
          : `Denied: ${approval.toolPath}`,
      );
      onResolve();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resolve");
    } finally {
      setResolving(null);
    }
  };

  const inputStr = JSON.stringify(approval.input, null, 2);

  return (
    <Card className="bg-card border-border border-l-2 border-l-terminal-amber glow-amber">
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-terminal-amber shrink-0" />
              <span className="text-sm font-mono font-medium text-foreground truncate">
                {approval.toolPath}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1 pl-6">
              <span className="text-[11px] text-muted-foreground">
                Task: {approval.taskId}
              </span>
              <span className="text-[11px] text-muted-foreground">
                &middot;
              </span>
              <span className="text-[11px] text-muted-foreground">
                {formatTimeAgo(approval.createdAt)}
              </span>
            </div>
          </div>
          <TaskStatusBadge status={approval.task.status} />
        </div>

        {/* Input */}
        {inputStr !== "null" && inputStr !== "{}" && (
          <div>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground block mb-1.5">
              Input
            </span>
            <pre className="terminal-block max-h-36 overflow-y-auto text-xs">
              {inputStr}
            </pre>
          </div>
        )}

        <Separator />

        {/* Actions */}
        <div className="flex items-center gap-2">
          <Button
            onClick={() => handleResolve("approved")}
            disabled={resolving !== null}
            className="flex-1 bg-terminal-green/15 text-terminal-green border border-terminal-green/30 hover:bg-terminal-green/25 h-9"
            variant="outline"
            size="sm"
          >
            <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
            {resolving === "approved" ? "Approving..." : "Approve"}
          </Button>
          <Button
            onClick={() => handleResolve("denied")}
            disabled={resolving !== null}
            className="flex-1 bg-terminal-red/15 text-terminal-red border border-terminal-red/30 hover:bg-terminal-red/25 h-9"
            variant="outline"
            size="sm"
          >
            <ShieldX className="h-3.5 w-3.5 mr-1.5" />
            {resolving === "denied" ? "Denying..." : "Deny"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ApprovalsView() {
  const { context, loading: sessionLoading } = useSession();

  const {
    data: approvals,
    loading: approvalsLoading,
    refresh,
  } = usePoll({
    fetcher: () => api.listPendingApprovals(context!.workspaceId),
    enabled: !!context,
    interval: 3000,
  });

  if (sessionLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      </div>
    );
  }

  const count = approvals?.length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approvals"
        description="Review and approve pending tool calls"
      >
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={refresh}
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Refresh
        </Button>
      </PageHeader>

      {approvalsLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : count === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="h-12 w-12 rounded-full bg-terminal-green/10 flex items-center justify-center">
              <CheckCircle2 className="h-6 w-6 text-terminal-green/60" />
            </div>
            <p className="text-sm text-muted-foreground">
              No pending approvals
            </p>
            <p className="text-[11px] text-muted-foreground/60">
              Tool calls requiring approval will appear here
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4 max-w-2xl">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {count} pending approval{count !== 1 ? "s" : ""}
          </div>
          {approvals!.map((a) => (
            <ApprovalCard key={a.id} approval={a} onResolve={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}
