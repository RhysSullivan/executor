import { Atom } from "@effect-atom/atom";
import { Result } from "@effect-atom/atom";
import type { ResolveInteractionPayload } from "@executor-v2/management-api";
import type { Interaction, InteractionId, WorkspaceId } from "@executor-v2/schema";

import { controlPlaneClient } from "../client";
import { stateFromResult, type EntityState } from "./entity";
import { approvalsKeys, approvalsMutationKeys } from "./keys";

export type ApprovalItem = {
  id: string;
  workspaceId: string;
  taskRunId: string;
  callId: string;
  toolPath: string;
  status: "pending" | "approved" | "denied" | "expired";
  inputPreviewJson: string;
  reason: string | null;
  requestedAt: number;
  resolvedAt: number | null;
};

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const approvalsResultByWorkspace = Atom.family(
  (workspaceId: WorkspaceId) =>
    controlPlaneClient.query("interactions", "list", {
      path: { workspaceId },
      reactivityKeys: approvalsKeys(workspaceId),
    }),
);

const toApproval = (item: Interaction): ApprovalItem => ({
  id: item.id,
  workspaceId: item.workspaceId,
  taskRunId: item.taskRunId,
  callId: item.callId,
  toolPath: item.toolPath,
  status: item.status === "resolved" ? "approved" : (item.status as ApprovalItem["status"]),
  inputPreviewJson: item.requestJson,
  reason: item.reason,
  requestedAt: item.requestedAt,
  resolvedAt: item.resolvedAt,
});

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

const sortApprovals = (a: ApprovalItem, b: ApprovalItem): number => {
  if (a.status !== b.status) {
    if (a.status === "pending") return -1;
    if (b.status === "pending") return 1;
  }
  if (a.requestedAt !== b.requestedAt) return b.requestedAt - a.requestedAt;
  return `${a.workspaceId}:${a.id}`.localeCompare(`${b.workspaceId}:${b.id}`);
};

export const approvalsByWorkspace = Atom.family((workspaceId: WorkspaceId) =>
  Atom.make((get): EntityState<ApprovalItem> => {
    const result = get(approvalsResultByWorkspace(workspaceId));
    const mapped = Result.map(result, (items) =>
      items.filter((item) => item.kind === "approval").map(toApproval));

    return stateFromResult(mapped, (items) => [...items].sort(sortApprovals));
  }));

export const approvalPendingByWorkspace = Atom.family((workspaceId: WorkspaceId) =>
  Atom.make((get): boolean => {
    const state = get(approvalsByWorkspace(workspaceId));
    return state.state === "loading";
  }),
);

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export const resolveApproval = controlPlaneClient.mutation("interactions", "resolve");

export const toResolveApprovalRequest = (input: {
  workspaceId: WorkspaceId;
  approvalId: string;
  payload: { status: "approved" | "denied"; reason?: string | null };
}) => ({
  path: {
    workspaceId: input.workspaceId,
    interactionId: input.approvalId as unknown as InteractionId,
  },
  payload: {
    status: input.payload.status === "approved" ? "resolved" : "denied",
    reason: input.payload.reason,
  } satisfies ResolveInteractionPayload,
  reactivityKeys: approvalsMutationKeys(input.workspaceId),
});

// ---------------------------------------------------------------------------
// Optimistic helpers
// ---------------------------------------------------------------------------

export const optimisticResolveApproval = (
  currentApprovals: ReadonlyArray<ApprovalItem>,
  input: {
    approvalId: string;
    payload: { status: "approved" | "denied"; reason?: string | null };
  },
): ReadonlyArray<ApprovalItem> =>
  [...currentApprovals.map((approval) => {
    if (approval.id !== input.approvalId) return approval;
    return {
      ...approval,
      status: input.payload.status,
      reason: input.payload.reason === undefined ? approval.reason : input.payload.reason,
      resolvedAt: Date.now(),
    };
  })].sort(sortApprovals);

export type ApprovalsState = EntityState<ApprovalItem>;
