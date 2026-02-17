"use node";

import { z } from "zod";
import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import type {
  AccessPolicyRecord,
  PolicyDecision,
  ResolvedToolCredential,
  TaskRecord,
  ToolDefinition,
  ToolCallRecord,
  ToolCallRequest,
  ToolRunContext,
} from "../../../core/src/types";
import { executeSerializedTool } from "../../../core/src/tool/source-serialization";
import { describeError } from "../../../core/src/utils";
import {
  decodeToolCallControlSignal,
  ToolCallControlError,
} from "../../../core/src/tool-call-control";
import { getToolDecision, getDecisionForContext } from "./policy";
import { baseTools } from "./workspace_tools";
import { publishTaskEvent } from "./events";
import { completeToolCall, denyToolCall, failToolCall } from "./tool_call_lifecycle";
import { resolveCredentialHeadersResult, validatePersistedCallRunnable } from "./tool_call_credentials";
import { getGraphqlDecision, resolveToolForCall } from "./tool_call_resolution";
import { getReadyRegistryBuildIdResult } from "./tool_registry_state";

const payloadRecordSchema = z.record(z.unknown());

function createApprovalId(): string {
  return `approval_${crypto.randomUUID()}`;
}

type RegistryToolEntry = {
  path: string;
  preferredPath?: string;
  source?: string;
  approval: ToolDefinition["approval"];
  description?: string;
  displayInput?: string;
  displayOutput?: string;
};

const registryNamespaceSchema = z.object({
  namespace: z.string(),
  toolCount: z.number(),
  samplePaths: z.array(z.string()),
});

const registryToolEntrySchema: z.ZodType<RegistryToolEntry> = z.object({
  path: z.string(),
  preferredPath: z.string().optional(),
  source: z.string().optional(),
  approval: z.enum(["auto", "required"]),
  description: z.string().optional(),
  displayInput: z.string().optional(),
  displayOutput: z.string().optional(),
});

const catalogNamespacesInputSchema = z.object({
  limit: z.coerce.number().optional(),
});

const catalogToolsInputSchema = z.object({
  namespace: z.string().optional(),
  query: z.string().optional(),
  limit: z.coerce.number().optional(),
});

const discoverInputSchema = z.object({
  query: z.string().optional(),
  limit: z.coerce.number().optional(),
  compact: z.boolean().optional(),
});

function toInputPayload(value: unknown): Record<string, unknown> {
  const parsed = payloadRecordSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  return value === undefined ? {} : { value };
}

async function upsertRequestedToolCall(
  ctx: ActionCtx,
  args: { taskId: string; callId: string; workspaceId: TaskRecord["workspaceId"]; toolPath: string },
): Promise<ToolCallRecord> {
  const persistedCall: ToolCallRecord = await ctx.runMutation(internal.database.upsertToolCallRequested, args);
  return persistedCall;
}

async function listWorkspaceAccessPolicies(
  ctx: ActionCtx,
  task: Pick<TaskRecord, "workspaceId" | "accountId">,
): Promise<AccessPolicyRecord[]> {
  const policies = await ctx.runQuery(internal.database.listAccessPolicies, {
    workspaceId: task.workspaceId,
    accountId: task.accountId,
  });
  return policies as AccessPolicyRecord[];
}

async function listRegistryNamespaces(
  ctx: ActionCtx,
  args: { workspaceId: TaskRecord["workspaceId"]; buildId: string; limit: number },
): Promise<Array<{ namespace: string; toolCount: number; samplePaths: string[] }>> {
  const namespaces = await ctx.runQuery(internal.toolRegistry.listNamespaces, args);
  const parsed = z.array(registryNamespaceSchema).safeParse(namespaces);
  return parsed.success ? parsed.data : [];
}

async function searchRegistryTools(
  ctx: ActionCtx,
  args: { workspaceId: TaskRecord["workspaceId"]; buildId: string; query: string; limit: number },
): Promise<RegistryToolEntry[]> {
  const entries = await ctx.runQuery(internal.toolRegistry.searchTools, args);
  const parsed = z.array(registryToolEntrySchema).safeParse(entries);
  return parsed.success ? parsed.data : [];
}

async function listRegistryToolsByNamespace(
  ctx: ActionCtx,
  args: { workspaceId: TaskRecord["workspaceId"]; buildId: string; namespace: string; limit: number },
): Promise<RegistryToolEntry[]> {
  const entries = await ctx.runQuery(internal.toolRegistry.listToolsByNamespace, args);
  const parsed = z.array(registryToolEntrySchema).safeParse(entries);
  return parsed.success ? parsed.data : [];
}

async function denyToolCallForApproval(
  ctx: ActionCtx,
  args: {
    task: TaskRecord;
    callId: string;
    toolPath: string;
    approvalId: string;
  },
): Promise<never> {
  const deniedMessage = `${args.toolPath} (${args.approvalId})`;
  return await denyToolCall(ctx, {
    task: args.task,
    callId: args.callId,
    toolPath: args.toolPath,
    deniedMessage,
    approvalId: args.approvalId,
  });
}

export async function invokeTool(ctx: ActionCtx, task: TaskRecord, call: ToolCallRequest): Promise<unknown> {
  const { toolPath, input, callId } = call;
  const persistedCall = await upsertRequestedToolCall(ctx, {
    taskId: task.id,
    callId,
    workspaceId: task.workspaceId,
    toolPath,
  });
  const runnable = validatePersistedCallRunnable(persistedCall, callId);
  if (runnable.isErr()) {
    throw runnable.error;
  }

  let effectiveToolPath = toolPath;
  try {
    const typedPolicies = await listWorkspaceAccessPolicies(ctx, task);
    const finalizeImmediateTool = async (value: unknown): Promise<unknown> => {
      if (persistedCall.status === "requested") {
        await publishTaskEvent(ctx, task.id, "task", "tool.call.started", {
          taskId: task.id,
          callId,
          toolPath,
          approval: "auto",
        });
      }
      await completeToolCall(ctx, {
        taskId: task.id,
        callId,
        toolPath,
      });
      return value;
    };

    // Fast system tools are handled server-side from the registry.
    if (toolPath === "discover" || toolPath === "catalog.namespaces" || toolPath === "catalog.tools") {
      const buildIdResult = await getReadyRegistryBuildIdResult(ctx, {
        workspaceId: task.workspaceId,
        accountId: task.accountId,
        clientId: task.clientId,
      });
      if (buildIdResult.isErr()) {
        throw buildIdResult.error;
      }
      const buildId = buildIdResult.value;

      const payload = typeof input === "string"
        ? { query: input }
        : toInputPayload(input);
      const isAllowed = (path: string, approval: ToolDefinition["approval"]) => {
        const policyProbeTool: ToolDefinition = {
          path,
          approval,
          description: "",
          run: async () => null,
        };
        return getDecisionForContext(
          policyProbeTool,
          { workspaceId: task.workspaceId, accountId: task.accountId, clientId: task.clientId },
          typedPolicies,
        ) !== "deny";
      };

      const normalizeHint = (value: unknown, fallback: string) => {
        const str = typeof value === "string" ? value.trim() : "";
        return str.length > 0 ? str : fallback;
      };

      if (toolPath === "catalog.namespaces") {
        const parsedInput = catalogNamespacesInputSchema.safeParse(payload);
        const limitInput = parsedInput.success ? parsedInput.data.limit : undefined;
        const limit = Math.max(1, Math.min(200, Number(limitInput ?? 200)));
        const namespaces = await listRegistryNamespaces(ctx, {
          workspaceId: task.workspaceId,
          buildId,
          limit,
        });
        return await finalizeImmediateTool({ namespaces, total: namespaces.length });
      }

      if (toolPath === "catalog.tools") {
        const parsedInput = catalogToolsInputSchema.safeParse(payload);
        const namespace = (parsedInput.success ? (parsedInput.data.namespace ?? "") : "").trim().toLowerCase();
        const query = (parsedInput.success ? (parsedInput.data.query ?? "") : "").trim();
        const limitInput = parsedInput.success ? parsedInput.data.limit : undefined;
        const limit = Math.max(1, Math.min(200, Number(limitInput ?? 50)));

        const raw = query
          ? await searchRegistryTools(ctx, {
              workspaceId: task.workspaceId,
              buildId,
              query,
              limit,
            })
          : namespace
            ? await listRegistryToolsByNamespace(ctx, {
                workspaceId: task.workspaceId,
                buildId,
                namespace,
                limit,
              })
            : [];

        const results = raw
          .filter((entry) => !namespace || String(entry.preferredPath ?? entry.path ?? "").toLowerCase().startsWith(`${namespace}.`))
          .filter((entry) => isAllowed(entry.path, entry.approval))
          .slice(0, limit)
          .map((entry) => {
            const preferredPath = entry.preferredPath ?? entry.path;
            return {
              path: preferredPath,
              source: entry.source,
              approval: entry.approval,
              description: entry.description,
              input: normalizeHint(entry.displayInput, "{}"),
              output: normalizeHint(entry.displayOutput, "unknown"),
              // required keys are encoded in the `input` type hint
            };
          });

        return await finalizeImmediateTool({ results, total: results.length });
      }

      // discover
      const parsedInput = discoverInputSchema.safeParse(payload);
      const query = (parsedInput.success ? (parsedInput.data.query ?? "") : "").trim();
      const limitInput = parsedInput.success ? parsedInput.data.limit : undefined;
      const limit = Math.max(1, Math.min(50, Number(limitInput ?? 8)));
      const compact = parsedInput.success ? (parsedInput.data.compact ?? true) : true;
      const hits = await searchRegistryTools(ctx, {
        workspaceId: task.workspaceId,
        buildId,
        query,
        limit: Math.max(limit * 2, limit),
      });

      const filtered = hits
        .filter((entry) => isAllowed(entry.path, entry.approval))
        .slice(0, limit);

      const results = filtered.map((entry) => {
        const preferredPath = entry.preferredPath ?? entry.path;
        const description = compact ? String(entry.description ?? "").split("\n")[0] : entry.description;
        return {
          path: preferredPath,
          source: entry.source,
          approval: entry.approval,
          description,
          input: normalizeHint(entry.displayInput, "{}"),
          output: normalizeHint(entry.displayOutput, "unknown"),
          // required keys are encoded in the `input` type hint
        };
      });

      const bestPath = results[0]?.path ?? null;
      return await finalizeImmediateTool({
        bestPath,
        results,
        total: results.length,
      });
    }

    const resolvedToolResult = await resolveToolForCall(ctx, task, toolPath);
    if (resolvedToolResult.isErr()) {
      throw resolvedToolResult.error;
    }
    const resolvedTool = resolvedToolResult.value;
    const { resolvedToolPath } = resolvedTool;
    const tool = resolvedTool.tool;
    const toolForPolicy = {
      path: tool.path,
      approval: tool.approval,
      _graphqlSource: tool._graphqlSource,
    };

    let decision: PolicyDecision;
    effectiveToolPath = resolvedToolPath;
    if (toolForPolicy._graphqlSource) {
      const result = getGraphqlDecision(task, toolForPolicy, input, undefined, typedPolicies);
      decision = result.decision;
      if (result.effectivePaths.length > 0) {
        effectiveToolPath = result.effectivePaths.join(", ");
      }
    } else {
      decision = getToolDecision(task, toolForPolicy, typedPolicies);
    }

    const publishToolStarted = persistedCall.status === "requested";

    if (decision === "deny") {
      const deniedMessage = `${effectiveToolPath} (policy denied)`;
      await denyToolCall(ctx, {
        task,
        callId,
        toolPath: effectiveToolPath,
        deniedMessage,
        reason: "policy_deny",
      });
    }

    let credential: ResolvedToolCredential | undefined;
    if (tool.credential) {
      const credentialResult = await resolveCredentialHeadersResult(ctx, tool.credential, task);
      if (credentialResult.isErr()) {
        throw credentialResult.error;
      }

      const resolved = credentialResult.value;
      if (!resolved) {
        throw new Error(`Missing credential for source '${tool.credential.sourceKey}' (${tool.credential.mode} scope)`);
      }
      credential = resolved;
    }

    if (publishToolStarted) {
      await publishTaskEvent(ctx, task.id, "task", "tool.call.started", {
        taskId: task.id,
        callId,
        toolPath: effectiveToolPath,
        approval: decision === "require_approval" ? "required" : "auto",
      });
    }

    let approvalSatisfied = false;
    if (persistedCall.approvalId) {
      const existingApproval = await ctx.runQuery(internal.database.getApproval, {
        approvalId: persistedCall.approvalId,
      });
      if (!existingApproval) {
        throw new Error(`Approval ${persistedCall.approvalId} not found for call ${callId}`);
      }

      if (existingApproval.status === "pending") {
        throw new ToolCallControlError({
          kind: "approval_pending",
          approvalId: existingApproval.id,
        });
      }

      if (existingApproval.status === "denied") {
        await denyToolCallForApproval(ctx, {
          task,
          callId,
          toolPath: effectiveToolPath,
          approvalId: existingApproval.id,
        });
      }

      approvalSatisfied = existingApproval.status === "approved";
    }

    if (decision === "require_approval" && !approvalSatisfied) {
      const approvalId = persistedCall.approvalId ?? createApprovalId();
      let approval = await ctx.runQuery(internal.database.getApproval, {
        approvalId,
      });

      if (!approval) {
        approval = await ctx.runMutation(internal.database.createApproval, {
          id: approvalId,
          taskId: task.id,
          toolPath: effectiveToolPath,
          input: toInputPayload(input),
        });

        await publishTaskEvent(ctx, task.id, "approval", "approval.requested", {
          approvalId: approval.id,
          taskId: task.id,
          callId,
          toolPath: approval.toolPath,
          input: toInputPayload(approval.input),
          createdAt: approval.createdAt,
        });
      }

      await ctx.runMutation(internal.database.setToolCallPendingApproval, {
        taskId: task.id,
        callId,
        approvalId: approval.id,
      });

      if (approval.status === "pending") {
        throw new ToolCallControlError({
          kind: "approval_pending",
          approvalId: approval.id,
        });
      }

      if (approval.status === "denied") {
        await denyToolCallForApproval(ctx, {
          task,
          callId,
          toolPath: effectiveToolPath,
          approvalId: approval.id,
        });
      }
    }

    const context: ToolRunContext = {
      taskId: task.id,
      workspaceId: task.workspaceId,
      accountId: task.accountId,
      clientId: task.clientId,
      credential,
      // Tool visibility is enforced server-side; runtime tool implementations don't use this.
      isToolAllowed: (_path) => true,
    };
    const value = resolvedTool.kind === "builtin"
      ? await resolvedTool.tool.run(input, context)
      : await executeSerializedTool(resolvedTool.tool, input, context, baseTools);
    await completeToolCall(ctx, {
      taskId: task.id,
      callId,
      toolPath: effectiveToolPath,
    });
    return value;
  } catch (error) {
    const message = describeError(error);
    const controlSignal = decodeToolCallControlSignal(error);

    if (!controlSignal) {
      await failToolCall(ctx, {
        taskId: task.id,
        callId,
        error: message,
        toolPath: effectiveToolPath,
      });
    }

    throw error;
  }
}
