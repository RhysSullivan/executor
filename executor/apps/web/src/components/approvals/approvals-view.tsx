"use client";

import { useMemo, useState } from "react";
import { useNavigate } from "@/lib/router";
import {
  ShieldCheck,
  ShieldX,
  CheckCircle2,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { TaskStatusBadge } from "@/components/status-badge";
import { useSession } from "@/lib/session-context";
import { convexApi } from "@/lib/convex-api";
import { useMutation, useQuery } from "convex/react";
import type { PendingApprovalRecord } from "@/lib/types";
import { toast } from "sonner";
import { formatTimeAgo } from "@/lib/format";
import { FormattedCodeBlock } from "@/components/formatted/code-block";
import { formatApprovalInput } from "@/lib/approval/input-format";
import { workspaceQueryArgs } from "@/lib/workspace/query-args";

function ApprovalCard({
  approval,
}: {
  approval: PendingApprovalRecord;
}) {
  const navigate = useNavigate();
  const { context } = useSession();
  const resolveApproval = useMutation(convexApi.executor.resolveApproval);
  const [resolving, setResolving] = useState<"approved" | "denied" | null>(
    null,
  );

  const handleResolve = async (decision: "approved" | "denied") => {
    if (!context) return;
    setResolving(decision);
    try {
      await resolveApproval({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        approvalId: approval.id,
        decision,
      });
      toast.success(
        decision === "approved"
          ? `Approved: ${approval.toolPath}`
          : `Denied: ${approval.toolPath}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resolve");
    } finally {
      setResolving(null);
    }
  };

  const inputDisplay = useMemo(
    () =>
      formatApprovalInput(approval.input, {
        hideSerializedNull: true,
        hideSerializedEmptyObject: true,
      }),
    [approval.input],
  );

  return (
    <Card className="rounded-none bg-card/40 border-border/50 border-l-2 border-l-terminal-amber glow-amber">
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
          <div className="flex items-center gap-2 shrink-0">
            <TaskStatusBadge status={approval.task.status} />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => navigate("/tools/editor")}
            >
              Open editor
            </Button>
          </div>
        </div>

        {/* Input */}
        {inputDisplay && (
          <div>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground block mb-1.5">
              Input
            </span>
            <FormattedCodeBlock
              content={inputDisplay.content}
              language={inputDisplay.language}
              className="max-h-52 overflow-y-auto"
            />
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

  const approvals = useQuery(
    convexApi.workspace.listPendingApprovals,
    workspaceQueryArgs(context),
  );
  const approvalsLoading = !!context && approvals === undefined;

  if (sessionLoading) {
    return (
      <div className="p-4 md:p-6 lg:p-8 space-y-6">
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
    <div className="flex h-full min-h-0 flex-col p-4 md:p-6 lg:p-8">
      {approvalsLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : count === 0 ? (
        <Card className="rounded-none bg-card/40 border-border/50 flex-1">
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
        <div className="flex min-h-0 flex-1 flex-col max-w-2xl">
          <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {count} pending approval{count !== 1 ? "s" : ""}
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {(approvals ?? []).map((a: PendingApprovalRecord) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
