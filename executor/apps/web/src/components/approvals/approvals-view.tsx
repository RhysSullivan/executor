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
    <Card className="rounded-none border-border/50 border-l-2 border-l-primary/40 bg-card/40">
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
              <span className="truncate text-sm font-medium text-foreground">
                {approval.toolPath}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1 pl-6">
              <span className="text-xs text-muted-foreground">
                Task: {approval.taskId}
              </span>
              <span className="text-xs text-muted-foreground">
                &middot;
              </span>
              <span className="text-xs text-muted-foreground">
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
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
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
            className="h-9 flex-1 border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20"
            variant="outline"
            size="sm"
          >
            <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
            {resolving === "approved" ? "Approving..." : "Approve"}
          </Button>
          <Button
            onClick={() => handleResolve("denied")}
            disabled={resolving !== null}
            className="h-9 flex-1 border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20"
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
      <div className="flex h-full min-h-0 overflow-hidden bg-background">
        <div className="w-72 shrink-0 border-r border-border/40 p-3 space-y-3">
          <Skeleton className="h-8 w-full" />
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
        <div className="flex-1 p-4">
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  }

  const count = approvals?.length ?? 0;

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background">
      {/* ── Left sidebar: approval list ── */}
      <aside className="flex h-full w-72 shrink-0 flex-col border-r border-border/40 bg-card/30 lg:w-80">
        {/* Sidebar header */}
        <div className="shrink-0 border-b border-border/30 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium leading-none">Approvals</h3>
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            {count} pending
          </p>
        </div>

        {/* Approval items in sidebar */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {approvalsLoading ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          ) : count === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 px-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                <CheckCircle2 className="h-5 w-5 text-primary/60" />
              </div>
              <p className="text-xs text-muted-foreground text-center">No pending approvals</p>
              <p className="text-[10px] text-muted-foreground/60 text-center">
                Tool calls requiring approval will appear here
              </p>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {(approvals ?? []).map((a: PendingApprovalRecord) => (
                <div
                  key={a.id}
                  className="rounded-md border border-border/40 bg-background/70 px-2.5 py-2 transition-colors hover:bg-accent/20"
                >
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="text-xs font-medium truncate">{a.toolPath}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 pl-5">
                    <span className="text-[10px] text-muted-foreground truncate">
                      {formatTimeAgo(a.createdAt)}
                    </span>
                    <TaskStatusBadge status={a.task.status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* ── Right content: full approval cards ── */}
      <div className="flex-1 min-w-0 max-h-screen overflow-y-auto bg-background/50">
        {approvalsLoading ? (
          <div className="p-4 space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-40" />
            ))}
          </div>
        ) : count === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center space-y-2">
              <CheckCircle2 className="h-8 w-8 text-primary/40 mx-auto" />
              <p className="text-sm text-muted-foreground">All clear</p>
              <p className="text-[11px] text-muted-foreground/60">No approvals waiting for review</p>
            </div>
          </div>
        ) : (
          <div className="p-4 sm:p-6 space-y-4 max-w-3xl">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              <Clock className="h-3.5 w-3.5" />
              {count} pending approval{count !== 1 ? "s" : ""}
            </div>
            {(approvals ?? []).map((a: PendingApprovalRecord) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
