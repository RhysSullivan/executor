"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { useSession } from "@/lib/session-context";
import { convexApi } from "@/lib/convex-api";
import type { PendingApprovalRecord } from "@/lib/types";

const NOTIFICATION_PROMPT_KEY = "executor_approval_desktop_notifications_prompted_v1";

function supportsDesktopNotifications(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function notifyDesktop(approval: PendingApprovalRecord) {
  if (!supportsDesktopNotifications()) {
    return;
  }

  if (Notification.permission !== "granted") {
    return;
  }

  if (document.visibilityState === "visible") {
    return;
  }

  const notification = new Notification("Approval required", {
    body: `${approval.toolPath} is waiting for review`,
    tag: `approval-${approval.id}`,
  });

  notification.onclick = () => {
    window.focus();
    window.location.assign("/approvals");
    notification.close();
  };

  window.setTimeout(() => {
    notification.close();
  }, 12_000);
}

export function ApprovalNotifier() {
  const router = useRouter();
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
          onClick: () => router.push("/approvals"),
        },
      },
    );

    for (const approval of newApprovals) {
      notifyDesktop(approval);
    }
  }, [approvals, context, router]);

  useEffect(() => {
    if (!context) {
      return;
    }

    if (!supportsDesktopNotifications()) {
      return;
    }

    if (Notification.permission !== "default") {
      return;
    }

    if (localStorage.getItem(NOTIFICATION_PROMPT_KEY)) {
      return;
    }

    localStorage.setItem(NOTIFICATION_PROMPT_KEY, "1");

    toast.message("Enable desktop approval alerts?", {
      description: "Get browser notifications when new approvals arrive.",
      duration: 14_000,
      action: {
        label: "Enable",
        onClick: async () => {
          if (!supportsDesktopNotifications()) {
            return;
          }

          try {
            const permission = await Notification.requestPermission();

            if (permission === "granted") {
              toast.success("Desktop notifications enabled");
            } else if (permission === "denied") {
              toast.error("Desktop notifications blocked in this browser");
            }
          } catch {
            toast.error("Failed to request notification permission");
          }
        },
      },
      cancel: {
        label: "Later",
        onClick: () => {},
      },
    });
  }, [context]);

  return null;
}
