import { describe, expect, test } from "bun:test";
import { ToolCallControlError } from "../../../core/src/tool-call-control";
import type { TaskRecord } from "../../../core/src/types";
import { enforceToolApproval } from "./tool_invocation";

type FakeApproval = {
  id: string;
  taskId: string;
  toolPath: string;
  input: unknown;
  status: "pending" | "approved" | "denied";
  createdAt: number;
};

function makeTask(id = "task_approval"): TaskRecord {
  const now = Date.now();
  return {
    id,
    code: "",
    runtimeId: "local-bun",
    status: "running",
    timeoutMs: 30_000,
    metadata: {},
    workspaceId: "ws_test" as TaskRecord["workspaceId"],
    accountId: "acct_test" as TaskRecord["accountId"],
    clientId: "web",
    createdAt: now,
    updatedAt: now,
  };
}

function makeFakeCtx(seedApprovals?: FakeApproval[]) {
  const approvals = new Map((seedApprovals ?? []).map((approval) => [approval.id, approval]));
  const mutations: Array<{
    kind: "create_approval" | "set_pending" | "create_event";
    args: Record<string, unknown>;
  }> = [];

  const ctx = {
    runQuery: async (query: unknown, args: Record<string, unknown>) => {
      if (query && "approvalId" in args) {
        return approvals.get(String(args.approvalId)) ?? null;
      }

      throw new Error("Unexpected query arguments in enforceToolApproval test");
    },
    runMutation: async (_mutation: unknown, args: Record<string, unknown>) => {
      if ("id" in args && "toolPath" in args && "input" in args) {
        mutations.push({ kind: "create_approval", args });
        const created: FakeApproval = {
          id: String(args.id),
          taskId: String(args.taskId),
          toolPath: String(args.toolPath),
          input: args.input,
          status: "pending",
          createdAt: Date.now(),
        };
        approvals.set(created.id, created);
        return created;
      }

      if ("callId" in args && "approvalId" in args) {
        mutations.push({ kind: "set_pending", args });
        return null;
      }

      if ("eventName" in args && "type" in args && "payload" in args) {
        mutations.push({ kind: "create_event", args });
        return null;
      }

      throw new Error("Unexpected mutation in enforceToolApproval test");
    },
  };

  return {
    ctx,
    mutations,
    approvals,
  };
}

describe("storage/tool approval enforcement", () => {
  test("throws approval_pending when existing approval is still pending", async () => {
    const pendingApproval: FakeApproval = {
      id: "approval_pending_1",
      taskId: "task_approval",
      toolPath: "storage.delete",
      input: { instanceId: "inst_1" },
      status: "pending",
      createdAt: Date.now(),
    };
    const { ctx, mutations } = makeFakeCtx([pendingApproval]);

    await expect(
      enforceToolApproval(ctx as never, {
        task: makeTask(),
        callId: "call_1",
        toolPath: "storage.delete",
        input: { instanceId: "inst_1" },
        requireApproval: true,
        existingApprovalId: pendingApproval.id,
      }),
    ).rejects.toBeInstanceOf(ToolCallControlError);

    expect(mutations).toHaveLength(0);
  });

  test("creates approval and marks call pending when approval is required", async () => {
    const { ctx, mutations } = makeFakeCtx();

    await expect(
      enforceToolApproval(ctx as never, {
        task: makeTask("task_new_approval"),
        callId: "call_2",
        toolPath: "storage.delete",
        input: { instanceId: "inst_2" },
        requireApproval: true,
      }),
    ).rejects.toBeInstanceOf(ToolCallControlError);

    const createdApprovalMutation = mutations.find((entry) => entry.kind === "create_approval");
    const setPendingMutation = mutations.find((entry) => entry.kind === "set_pending");
    const approvalEventMutation = mutations.find((entry) => entry.kind === "create_event");

    expect(createdApprovalMutation?.args.toolPath).toBe("storage.delete");
    expect(setPendingMutation).toBeDefined();
    expect(approvalEventMutation?.args.type).toBe("approval.requested");
  });

  test("returns without mutations when existing approval is already approved", async () => {
    const approvedApproval: FakeApproval = {
      id: "approval_done",
      taskId: "task_approval",
      toolPath: "storage.delete",
      input: { instanceId: "inst_3" },
      status: "approved",
      createdAt: Date.now(),
    };
    const { ctx, mutations } = makeFakeCtx([approvedApproval]);

    await enforceToolApproval(ctx as never, {
      task: makeTask(),
      callId: "call_3",
      toolPath: "storage.delete",
      input: { instanceId: "inst_3" },
      requireApproval: true,
      existingApprovalId: approvedApproval.id,
    });

    expect(mutations).toHaveLength(0);
  });
});
