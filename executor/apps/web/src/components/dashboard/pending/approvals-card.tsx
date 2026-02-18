import { useNavigate } from "@/lib/router";
import { AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { PendingApprovalRecord } from "@/lib/types";
import { formatTimeAgo } from "@/lib/format";

function PendingApprovalRow({ approval }: { approval: PendingApprovalRecord }) {
  const navigate = useNavigate();

  return (
    <button
      onClick={() => navigate("/approvals")}
      className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/20"
    >
      <div className="h-2 w-2 rounded-full bg-terminal-amber pulse-dot shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-sm font-mono text-foreground">{approval.toolPath}</span>
        <span className="text-[11px] text-muted-foreground ml-2">{formatTimeAgo(approval.createdAt)}</span>
      </div>
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </button>
  );
}

export function DashboardPendingApprovalsCard({
  pendingCount,
  approvals,
}: {
  pendingCount: number;
  approvals: PendingApprovalRecord[];
}) {
  const navigate = useNavigate();

  return (
    <Card className="rounded-none border-border/50 bg-card/40">
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
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs h-7"
            onClick={() => navigate("/approvals")}
          >
            View all
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
          <div className="divide-y divide-border/30">
            {approvals.map((approval) => (
              <PendingApprovalRow key={approval.id} approval={approval} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
