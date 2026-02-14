"use client";

import { Server } from "lucide-react";
import { useQuery } from "convex/react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { DashboardPendingApprovalsCard } from "@/components/dashboard/pending/approvals-card";
import { McpSetupCard } from "@/components/tools/setup-card";
import { useSession } from "@/lib/session-context";
import { convexApi } from "@/lib/convex-api";
import { workspaceQueryArgs } from "@/lib/workspace/query-args";

export function DashboardView() {
  const { context, loading: sessionLoading } = useSession();
  const approvals = useQuery(
    convexApi.workspace.listPendingApprovals,
    workspaceQueryArgs(context),
  );
  const approvalsLoading = Boolean(context) && approvals === undefined;
  const pendingApprovals = (approvals ?? []).slice(0, 5);
  const pendingCount = approvals?.length ?? 0;

  if (sessionLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-6 xl:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-[420px]" />
          ))}
        </div>
        <Skeleton className="h-[360px]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspace Home"
        description="Approvals on the left and agent setup on the right"
      />

      <div className="grid gap-6 xl:grid-cols-2">
        {approvalsLoading ? (
          <Skeleton className="h-[420px]" />
        ) : (
          <DashboardPendingApprovalsCard
            pendingCount={pendingCount}
            approvals={pendingApprovals}
          />
        )}

        <Card id="mcp-setup" className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Server className="h-4 w-4 text-primary" />
              Integrate with your agent
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <McpSetupCard
              workspaceId={context?.workspaceId}
              sessionId={context?.sessionId}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
