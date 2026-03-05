"use client";

import { useAtomSet, useAtomValue } from "@effect-atom/atom-react";
import { useMemo, useState } from "react";

import { useWorkspace } from "../../lib/hooks/use-workspace";
import {
  approvalsByWorkspace,
  type ApprovalItem,
  optimisticResolveApproval,
  resolveApproval,
  toResolveApprovalRequest,
} from "../../lib/control-plane/atoms";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Badge } from "../ui/badge";
import { cn, formatTimestamp } from "../../lib/utils";
import { matchState } from "../shared/match-state";
import { PageHeader } from "../shared/page-header";
import { StatusMessage } from "../shared/status-message";

type ApprovalFilterValue = "pending" | "completed" | "all";

const statusBadgeVariant = (
  status: ApprovalItem["status"],
): "pending" | "approved" | "denied" | "outline" => {
  if (status === "pending") {
    return "pending";
  }

  if (status === "accepted") {
    return "approved";
  }

  if (status === "declined" || status === "cancelled" || status === "failed") {
    return "denied";
  }

  return "outline";
};

const previewFromInputJson = (inputPreviewJson: string): string => {
  const trimmed = inputPreviewJson.trim();

  if (trimmed.length === 0) {
    return "{}";
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const pretty = JSON.stringify(parsed, null, 2);
    return pretty.length > 640 ? `${pretty.slice(0, 640)}\n...` : pretty;
  } catch {
    return trimmed.length > 640 ? `${trimmed.slice(0, 640)}...` : trimmed;
  }
};

export function usePendingApprovalCount(): number {
  const { workspaceId } = useWorkspace();
  const approvalsState = useAtomValue(approvalsByWorkspace(workspaceId));

  return approvalsState.items.filter((approval) => approval.status === "pending").length;
}

export function ApprovalsView() {
  const { workspaceId } = useWorkspace();

  const [approvalFilter, setApprovalFilter] = useState<ApprovalFilterValue>("pending");
  const [approvalSearchQuery, setApprovalSearchQuery] = useState("");
  const [approvalStatusText, setApprovalStatusText] = useState<string | null>(null);
  const [approvalStatusVariant, setApprovalStatusVariant] = useState<"info" | "error">("info");
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const [optimisticApprovals, setOptimisticApprovals] = useState<
    ReadonlyArray<ApprovalItem> | null
  >(null);

  const approvalsState = useAtomValue(approvalsByWorkspace(workspaceId));
  const runResolveApproval = useAtomSet(resolveApproval, { mode: "promise" });

  const approvalItems = optimisticApprovals ?? approvalsState.items;

  const filteredApprovals = useMemo(() => {
    const query = approvalSearchQuery.trim().toLowerCase();

    return approvalItems.filter((approval) => {
      if (approvalFilter === "pending" && approval.status !== "pending") {
        return false;
      }

      if (approvalFilter === "completed" && approval.status === "pending") {
        return false;
      }

      if (query.length === 0) {
        return true;
      }

      return (
        approval.toolPath.toLowerCase().includes(query) ||
        approval.status.toLowerCase().includes(query) ||
        approval.callId.toLowerCase().includes(query) ||
        approval.taskRunId.toLowerCase().includes(query) ||
        (approval.reason ?? "").toLowerCase().includes(query)
      );
    });
  }, [approvalFilter, approvalItems, approvalSearchQuery]);

  const setStatus = (message: string | null, variant: "info" | "error" = "info") => {
    setApprovalStatusText(message);
    setApprovalStatusVariant(variant);
  };

  const handleResolveApproval = (approvalId: string, action: "accept" | "decline") => {
    if (approvalBusyId !== null) {
      return;
    }

    setApprovalBusyId(approvalId);

    const nextOptimistic = optimisticResolveApproval(approvalItems, {
      approvalId,
      payload: {
        action,
        reason: null,
      },
    });

    setOptimisticApprovals(nextOptimistic);

    void runResolveApproval(toResolveApprovalRequest({
      workspaceId,
      approvalId,
      payload: {
        action,
        reason: null,
      },
    }))
      .then(() => {
        setStatus(action === "accept" ? "Approval granted." : "Approval denied.");
        setOptimisticApprovals(null);
      })
      .catch(() => {
        setStatus("Approval update failed.", "error");
        setOptimisticApprovals(null);
      })
      .finally(() => {
        setApprovalBusyId(null);
      });
  };

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <PageHeader title="Approvals" description="Review and resolve tool-call approvals." />

      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <CardTitle>Approval Requests</CardTitle>
          <CardDescription>Manage request status and inspect input previews.</CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="approval-filter">
                Filter
              </label>
              <Select
                id="approval-filter"
                value={approvalFilter}
                onChange={(event) =>
                  setApprovalFilter(event.target.value as ApprovalFilterValue)
                }
              >
                <option value="pending">pending</option>
                <option value="completed">completed</option>
                <option value="all">all</option>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="approval-search">
                Search
              </label>
              <Input
                id="approval-search"
                value={approvalSearchQuery}
                onChange={(event) => {
                  setApprovalSearchQuery(event.target.value);
                }}
                placeholder="tool path, status, task run, call id"
              />
            </div>
          </div>

          <StatusMessage message={approvalStatusText} variant={approvalStatusVariant} />

          {matchState(approvalsState, {
            loading: "Loading approvals...",
            empty:
              approvalsState.items.length === 0
                ? "No approvals found for this workspace."
                : "No approvals match your filter and search.",
            filteredCount: filteredApprovals.length,
            ready: () => (
              <div className="space-y-2">
                {filteredApprovals.map((approval) => {
                  const isBusy = approvalBusyId === approval.id;
                  const canResolve = approval.status === "pending";

                  return (
                    <article
                      key={approval.id}
                      className={cn(
                        "rounded-lg border border-border bg-background/70 p-3",
                        isBusy && "opacity-80",
                      )}
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 space-y-1">
                          <p className="break-all text-sm font-medium">{approval.toolPath}</p>
                          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            <Badge variant={statusBadgeVariant(approval.status)}>{approval.status}</Badge>
                            <span>requested {formatTimestamp(approval.requestedAt)}</span>
                            <span>resolved {formatTimestamp(approval.resolvedAt)}</span>
                          </div>
                          <p className="break-all text-xs text-muted-foreground">task {approval.taskRunId}</p>
                          <p className="break-all text-xs text-muted-foreground">call {approval.callId}</p>
                          {approval.reason ? (
                            <p className="break-all text-xs text-muted-foreground">
                              reason: {approval.reason}
                            </p>
                          ) : null}
                        </div>

                        {canResolve ? (
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => handleResolveApproval(approval.id, "accept")}
                              disabled={isBusy}
                            >
                              {isBusy ? "Working..." : "Approve"}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              onClick={() => handleResolveApproval(approval.id, "decline")}
                              disabled={isBusy}
                            >
                              {isBusy ? "Working..." : "Deny"}
                            </Button>
                          </div>
                        ) : null}
                      </div>

                      <pre className="mt-3 max-h-56 overflow-auto rounded-md border border-border bg-muted/45 p-3 text-[11px] leading-5 text-muted-foreground">
                        {previewFromInputJson(approval.inputPreviewJson)}
                      </pre>
                    </article>
                  );
                })}
              </div>
            ),
          })}
        </CardContent>
      </Card>
    </section>
  );
}
