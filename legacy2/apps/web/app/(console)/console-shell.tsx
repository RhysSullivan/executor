"use client";

import { memo, type ReactNode } from "react";
import { useAtomValue } from "@effect-atom/atom-react";

import { AppShell } from "../../components/shell/app-shell";
import { WorkspaceProvider, useWorkspace } from "../../lib/hooks/use-workspace";
import { approvalsByWorkspace } from "../../lib/control-plane/atoms";

type ConsoleShellProps = {
  authEnabled: boolean;
  initialWorkspaceId: string;
  children: ReactNode;
};

export function ConsoleShell({
  authEnabled,
  initialWorkspaceId,
  children,
}: ConsoleShellProps) {
  return (
    <WorkspaceProvider initialWorkspaceId={initialWorkspaceId}>
      <ConsoleShellInner authEnabled={authEnabled}>
        {children}
      </ConsoleShellInner>
    </WorkspaceProvider>
  );
}

function ConsoleShellInner({
  authEnabled,
  children,
}: {
  authEnabled: boolean;
  children: ReactNode;
}) {
  return (
    <AppShell
      authEnabled={authEnabled}
      approvalsBadge={<ApprovalsBadge />}
    >
      {children}
    </AppShell>
  );
}

/** Isolated subscription boundary: only this component re-renders when approvals change. */
const ApprovalsBadge = memo(function ApprovalsBadge() {
  const { workspaceId } = useWorkspace();
  const approvalsState = useAtomValue(approvalsByWorkspace(workspaceId));
  const pendingCount = approvalsState.items.filter((a) => a.status === "pending").length;

  if (pendingCount === 0) return null;

  return (
    <span className="flex size-5 items-center justify-center rounded-full bg-primary/80 text-[10px] font-semibold text-primary-foreground">
      {pendingCount}
    </span>
  );
});
