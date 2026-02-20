"use client";

import { useState } from "react";
import { X, ShieldX, CheckCircle2 } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import type { Id } from "@executor/database/convex/_generated/dataModel";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { TaskStatusBadge } from "@/components/status-badge";
import { FormattedCodeBlock } from "@/components/formatted/code-block";
import { convexApi } from "@/lib/convex-api";
import { formatApprovalInput } from "@/lib/approval/input-format";
import { cn } from "@/lib/utils";
import type { TaskRecord, PendingApprovalRecord } from "@/lib/types";

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatResult(result: unknown): string {
  if (result === undefined) {
    return "";
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export function TaskDetail({
  task,
  workspaceId,
  sessionId,
  pendingApprovals,
  runtimeLabel,
  onClose,
}: {
  task: TaskRecord;
  workspaceId: Id<"workspaces">;
  sessionId?: string;
  pendingApprovals: PendingApprovalRecord[];
  runtimeLabel?: string;
  onClose: () => void;
}) {
  const resolveApproval = useMutation(convexApi.executor.resolveApproval);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const allTasks = useQuery(
    convexApi.workspace.listTasks,
    { workspaceId, sessionId },
  );

  const liveTaskData = allTasks?.find((candidate: TaskRecord) => candidate.id === task.id);

  const liveTask = liveTaskData ?? task;
  const liveResult = formatResult(liveTask.result);

  const duration =
    liveTask.completedAt && liveTask.startedAt
      ? `${((liveTask.completedAt - liveTask.startedAt) / 1000).toFixed(2)}s`
      : liveTask.startedAt
        ? "running..."
        : "—";

  const handleResolveApproval = async (
    approvalId: string,
    decision: "approved" | "denied",
    toolPath: string,
  ) => {
    setResolvingApprovalId(approvalId);
    try {
      await resolveApproval({
        workspaceId,
        sessionId,
        approvalId,
        decision,
      });
      toast.success(
        decision === "approved"
          ? `Approved: ${toolPath}`
          : `Denied: ${toolPath}`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to resolve approval");
    } finally {
      setResolvingApprovalId(null);
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0 pr-4">
            <CardTitle className="truncate text-sm font-semibold">Task details</CardTitle>
            <p className="truncate text-xs text-muted-foreground">{liveTask.id}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Status", value: <TaskStatusBadge status={liveTask.status} /> },
            { label: "Runtime", value: <span className="text-sm">{runtimeLabel ?? liveTask.runtimeId}</span> },
            { label: "Duration", value: <span className="text-sm">{duration}</span> },
            {
              label: "Exit Code",
              value: (
                <span className={cn("text-sm", liveTask.exitCode === 0 ? "text-primary" : liveTask.exitCode ? "text-destructive" : "text-muted-foreground")}>
                  {liveTask.exitCode ?? "—"}
                </span>
              ),
            },
          ].map((item) => (
            <div key={item.label}>
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                {item.label}
              </span>
              {item.value}
            </div>
          ))}
        </div>

        {pendingApprovals.length > 0 ? (
          <>
            <Separator />
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-primary">
                  Pending approvals
                </span>
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                  {pendingApprovals.length}
                </span>
              </div>
              {pendingApprovals.map((approval) => {
                const input = formatApprovalInput(approval.input);
                const resolving = resolvingApprovalId === approval.id;
                return (
                  <div
                    key={approval.id}
                    className="space-y-2 rounded-md border border-primary/20 bg-primary/5 p-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {approval.toolPath}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Requested {formatDate(approval.createdAt)}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 border-primary/30 bg-primary/10 text-primary hover:bg-primary/20"
                          disabled={resolvingApprovalId !== null}
                          onClick={() =>
                            void handleResolveApproval(
                              approval.id,
                              "approved",
                              approval.toolPath,
                            )
                          }
                        >
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                          {resolving ? "Approving..." : "Approve"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20"
                          disabled={resolvingApprovalId !== null}
                          onClick={() =>
                            void handleResolveApproval(
                              approval.id,
                              "denied",
                              approval.toolPath,
                            )
                          }
                        >
                          <ShieldX className="h-3 w-3 mr-1" />
                          {resolving ? "Denying..." : "Deny"}
                        </Button>
                      </div>
                    </div>
                    {input ? (
                      <FormattedCodeBlock
                        content={input.content}
                        language={input.language}
                        className="max-h-40 overflow-y-auto"
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}

        <Separator />

        <div>
          <span className="mb-2 block text-xs font-medium text-muted-foreground">
            Code
          </span>
          <FormattedCodeBlock
            content={liveTask.code}
            language="typescript"
            className="max-h-48 overflow-y-auto"
          />
        </div>

        {liveResult && (
          <div>
            <span className="mb-2 block text-xs font-medium text-primary">
              Result
            </span>
            <FormattedCodeBlock
              content={liveResult}
              language="json"
              className="max-h-48 overflow-y-auto"
            />
          </div>
        )}

        {liveTask.error && (
          <div>
            <span className="mb-2 block text-xs font-medium text-destructive">
              Error
            </span>
            <FormattedCodeBlock
              content={liveTask.error}
              language="text"
              tone="red"
              className="max-h-48 overflow-y-auto"
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
