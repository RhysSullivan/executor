import { useCallback, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { GenericId } from "convex/values";
import { api } from "@executor/database";

export type WorkspaceRequestContext = {
  workspaceId: GenericId<"workspaces">;
  sessionId?: string;
};

export type PendingApproval = {
  id: string;
  taskId: string;
  toolPath: string;
  createdAt: number;
  task: {
    status: string;
  };
};

export function usePendingApprovals(context: WorkspaceRequestContext | null) {
  const approvals = useQuery(
    api.workspace.listPendingApprovals,
    context
      ? { workspaceId: context.workspaceId, sessionId: context.sessionId }
      : "skip",
  );
  const resolveApproval = useMutation(api.executor.resolveApproval);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);

  const resolve = useCallback(
    async (approvalId: string, decision: "approved" | "denied") => {
      if (!context) {
        return;
      }

      setResolvingApprovalId(approvalId);
      try {
        await resolveApproval({
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          approvalId,
          decision,
        });
      } finally {
        setResolvingApprovalId(null);
      }
    },
    [context, resolveApproval],
  );

  return {
    approvals: (approvals ?? []) as PendingApproval[],
    loading: Boolean(context) && approvals === undefined,
    resolvingApprovalId,
    approve: (approvalId: string) => resolve(approvalId, "approved"),
    deny: (approvalId: string) => resolve(approvalId, "denied"),
  };
}

export function PendingApprovalList(props: {
  approvals: PendingApproval[];
  resolvingApprovalId: string | null;
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
  onOpenTask?: (taskId: string) => void;
  emptyLabel?: string;
}) {
  const {
    approvals,
    resolvingApprovalId,
    onApprove,
    onDeny,
    onOpenTask,
    emptyLabel = "No pending approvals.",
  } = props;

  if (approvals.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-2">
      {approvals.map((approval) => {
        const resolving = resolvingApprovalId === approval.id;

        return (
          <div
            key={approval.id}
            className="rounded-md border border-border bg-card px-3 py-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-foreground">{approval.toolPath}</p>
                <p className="text-[11px] text-muted-foreground">Task {approval.taskId}</p>
              </div>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                {approval.task.status}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              {onOpenTask ? (
                <button
                  type="button"
                  onClick={() => onOpenTask(approval.taskId)}
                  className="h-7 rounded border border-border px-2 text-[11px] text-muted-foreground hover:bg-accent"
                >
                  Open
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onApprove(approval.id)}
                disabled={resolving}
                className="h-7 rounded border border-emerald-500/40 px-2 text-[11px] text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-50"
              >
                {resolving ? "..." : "Approve"}
              </button>
              <button
                type="button"
                onClick={() => onDeny(approval.id)}
                disabled={resolving}
                className="h-7 rounded border border-rose-500/40 px-2 text-[11px] text-rose-600 hover:bg-rose-500/10 disabled:opacity-50"
              >
                {resolving ? "..." : "Deny"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
