"use client";

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { useSession } from "@/lib/session-context";
import { convexApi } from "@/lib/convex-api";
import type { PendingApprovalRecord } from "@/lib/types";

export function ApprovalNotifier() {
  const navigate = useNavigate();
  const { context } = useSession();
  const seenApprovalIdsRef = useRef<Set<string>>(new Set());
  const activeWorkspaceRef = useRef<string | null>(null);

  const approvals = useQuery(
    convexApi.workspace.listPendingApprovals,
    context ? { workspaceId: context.workspaceId, sessionId: context.sessionId } : "skip",
  );

  useEffect(() => {
    if (!context || approvals === undefined) {
      return;
    }

    const approvalRecords = approvals as PendingApprovalRecord[];

    const currentWorkspaceId = context.workspaceId;
    const currentIds = new Set(approvalRecords.map((approval) => approval.id));

    if (activeWorkspaceRef.current !== currentWorkspaceId) {
      activeWorkspaceRef.current = currentWorkspaceId;
      seenApprovalIdsRef.current = currentIds;
      return;
    }

    const newApprovals = approvalRecords.filter(
      (approval) => !seenApprovalIdsRef.current.has(approval.id),
    );

    seenApprovalIdsRef.current = currentIds;

    if (newApprovals.length === 0) {
      return;
    }

    const newest = newApprovals[newApprovals.length - 1];

    toast.info(
      newApprovals.length === 1
        ? `Approval required: ${newest.toolPath}`
        : `${newApprovals.length} new approvals pending`,
      {
        description:
          newApprovals.length === 1
            ? `Task ${newest.taskId} is waiting for review.`
            : "Open approvals to review pending tool calls.",
        action: {
          label: "Review",
          onClick: () => navigate("/approvals"),
        },
      },
    );

  }, [approvals, context, navigate]);

  return null;
}
