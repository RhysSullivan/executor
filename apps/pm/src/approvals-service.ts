import {
  PersistentToolApprovalPolicyStoreError,
  createPersistentToolApprovalPolicy,
  type PersistentToolApprovalRecord,
  type PersistentToolApprovalStore,
  type ToolApprovalPolicy,
} from "@executor-v2/engine";
import { type SqlControlPlanePersistence } from "@executor-v2/persistence-sql";
import {
  makeControlPlaneApprovalsService,
  type ControlPlaneApprovalsServiceShape,
} from "@executor-v2/management-api";
import { type Approval } from "@executor-v2/schema";
import * as Effect from "effect/Effect";

import { createSqlSourceStoreErrorMapper } from "./control-plane-row-helpers";

type ApprovalRows = Pick<SqlControlPlanePersistence["rows"], "approvals">;

const sourceStoreError = createSqlSourceStoreErrorMapper("approvals");

const findApprovalIndex = (
  approvals: ReadonlyArray<Approval>,
  workspaceId: string,
  approvalId: string,
): number =>
  approvals.findIndex(
    (approval) => approval.workspaceId === workspaceId && approval.id === approvalId,
  );

const sortApprovals = (approvals: ReadonlyArray<Approval>): Array<Approval> =>
  [...approvals].sort((left, right) => right.requestedAt - left.requestedAt);

const toPersistentApprovalStoreError = (
  operation: string,
  message: string,
  details: string | null,
): PersistentToolApprovalPolicyStoreError =>
  new PersistentToolApprovalPolicyStoreError({
    operation,
    message,
    details,
  });

const toPersistentApprovalStoreErrorFromRowStore = (
  operation: string,
  error: { message: string; details: string | null; reason: string | null },
): PersistentToolApprovalPolicyStoreError =>
  toPersistentApprovalStoreError(operation, error.message, error.details ?? error.reason ?? null);

const toPersistentApprovalRecord = (approval: Approval): PersistentToolApprovalRecord => ({
  approvalId: approval.id,
  workspaceId: approval.workspaceId,
  runId: approval.taskRunId,
  callId: approval.callId,
  toolPath: approval.toolPath,
  status: approval.status,
  reason: approval.reason,
});

export type PmPersistentToolApprovalPolicyOptions = {
  requireApprovals?: boolean;
  retryAfterMs?: number;
};

export const createPmPersistentToolApprovalPolicy = (
  rows: ApprovalRows,
  options: PmPersistentToolApprovalPolicyOptions = {},
): ToolApprovalPolicy => {
  const store: PersistentToolApprovalStore = {
    findByRunAndCall: (input) =>
      rows.approvals.list().pipe(
        Effect.mapError((error) =>
          toPersistentApprovalStoreErrorFromRowStore("approvals.read", error),
        ),
        Effect.flatMap((approvals) => {
          const approval =
            approvals.find(
              (candidate) =>
                candidate.workspaceId === input.workspaceId &&
                candidate.taskRunId === input.runId &&
                candidate.callId === input.callId,
            ) ?? null;

          return Effect.succeed(approval ? toPersistentApprovalRecord(approval) : null);
        }),
      ),

    createPending: (input) =>
      rows.approvals.list().pipe(
        Effect.mapError((error) =>
          toPersistentApprovalStoreErrorFromRowStore("approvals.read", error),
        ),
        Effect.flatMap(() => {
          const pendingApproval = {
            id: `apr_${crypto.randomUUID()}`,
            workspaceId: input.workspaceId,
            taskRunId: input.runId,
            callId: input.callId,
            toolPath: input.toolPath,
            status: "pending",
            inputPreviewJson: input.inputPreviewJson,
            reason: null,
            requestedAt: Date.now(),
            resolvedAt: null,
          } as Approval;

          return rows.approvals.upsert(pendingApproval).pipe(
            Effect.mapError((error) =>
              toPersistentApprovalStoreErrorFromRowStore("approvals.write", error),
            ),
            Effect.as(toPersistentApprovalRecord(pendingApproval)),
          );
        }),
      ),
  };

  return createPersistentToolApprovalPolicy({
    store,
    requireApprovals: options.requireApprovals,
    retryAfterMs: options.retryAfterMs,
  });
};

export const createPmApprovalsService = (
  rows: ApprovalRows,
): ControlPlaneApprovalsServiceShape =>
  makeControlPlaneApprovalsService({
    listApprovals: (workspaceId) =>
      Effect.gen(function* () {
        const approvals = yield* rows.approvals.list().pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("approvals.list", error),
          ),
        );

        const scopedApprovals = approvals.filter(
          (approval) => approval.workspaceId === workspaceId,
        );

        return sortApprovals(scopedApprovals);
      }),

    resolveApproval: (input) =>
      Effect.gen(function* () {
        const approvals = yield* rows.approvals.list().pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("approvals.resolve", error),
          ),
        );

        const index = findApprovalIndex(
          approvals,
          input.workspaceId,
          input.approvalId,
        );

        if (index < 0) {
          return yield* sourceStoreError.fromMessage(
            "approvals.resolve",
            "Approval not found",
            `workspace=${input.workspaceId} approval=${input.approvalId}`,
          );
        }

        const approval = approvals[index];
        if (approval.status !== "pending") {
          return yield* sourceStoreError.fromMessage(
            "approvals.resolve",
            "Approval is not pending",
            `approval=${input.approvalId} status=${approval.status}`,
          );
        }

        const resolvedApproval: Approval = {
          ...approval,
          status: input.payload.status,
          reason: input.payload.reason ?? approval.reason ?? null,
          resolvedAt: Date.now(),
        };

        yield* rows.approvals.upsert(resolvedApproval).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("approvals.resolve_write", error),
          ),
        );

        return resolvedApproval;
      }),
  });
