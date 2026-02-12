"use node";

import type {
  AccessPolicyRecord,
  PolicyDecision,
  TaskRecord,
  ToolDefinition,
} from "../../core/src/types";

function matchesToolPath(pattern: string, toolPath: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(toolPath);
}

function policySpecificity(policy: AccessPolicyRecord, actorId?: string, clientId?: string): number {
  let score = 0;
  if (policy.actorId && actorId && policy.actorId === actorId) score += 4;
  if (policy.clientId && clientId && policy.clientId === clientId) score += 2;
  score += Math.max(1, policy.toolPathPattern.replace(/\*/g, "").length);
  score += policy.priority;
  return score;
}

export function getDecisionForContext(
  tool: ToolDefinition,
  context: { workspaceId: string; actorId?: string; clientId?: string },
  policies: AccessPolicyRecord[],
): PolicyDecision {
  if (tool.path === "discover") {
    return "allow";
  }

  const defaultDecision: PolicyDecision = tool.approval === "required" ? "require_approval" : "allow";
  const candidates = policies
    .filter((policy) => {
      if (policy.actorId && policy.actorId !== context.actorId) return false;
      if (policy.clientId && policy.clientId !== context.clientId) return false;
      return matchesToolPath(policy.toolPathPattern, tool.path);
    })
    .sort(
      (a, b) =>
        policySpecificity(b, context.actorId, context.clientId)
        - policySpecificity(a, context.actorId, context.clientId),
    );

  return candidates[0]?.decision ?? defaultDecision;
}

export function getToolDecision(
  task: TaskRecord,
  tool: ToolDefinition,
  policies: AccessPolicyRecord[],
): PolicyDecision {
  return getDecisionForContext(
    tool,
    {
      workspaceId: task.workspaceId,
      actorId: task.actorId,
      clientId: task.clientId,
    },
    policies,
  );
}

export function isToolAllowedForTask(
  task: TaskRecord,
  toolPath: string,
  workspaceTools: Map<string, ToolDefinition>,
  policies: AccessPolicyRecord[],
): boolean {
  const tool = workspaceTools.get(toolPath);
  if (!tool) return false;
  return getToolDecision(task, tool, policies) !== "deny";
}
