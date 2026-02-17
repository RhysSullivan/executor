"use node";

import type {
  AccessPolicyRecord,
  PolicyDecision,
  TaskRecord,
} from "../../../core/src/types";

interface PolicyTool {
  path: string;
  approval: "auto" | "required";
}

function matchesToolPath(pattern: string, toolPath: string, matchType: "glob" | "exact" = "glob"): boolean {
  if (matchType === "exact") {
    return pattern === toolPath;
  }

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(toolPath);
}

function policySpecificity(
  policy: AccessPolicyRecord,
  context: { workspaceId: string; accountId?: string; clientId?: string },
): number {
  const scopeType = policy.scopeType;
  const targetAccountId = policy.targetAccountId;
  const resourcePattern = policy.resourcePattern;
  const matchType = policy.matchType;

  let score = 0;
  if (scopeType === "workspace" && policy.workspaceId === context.workspaceId) score += 16;
  if (scopeType === "organization") score += 8;
  if (targetAccountId && context.accountId && targetAccountId === context.accountId) score += 64;
  if (policy.clientId && context.clientId && policy.clientId === context.clientId) score += 4;
  if (matchType === "exact") score += 3;
  score += Math.max(1, resourcePattern.replace(/\*/g, "").length);
  score += policy.priority;
  return score;
}

function resolvePolicyDecision(policy: AccessPolicyRecord, defaultDecision: PolicyDecision): PolicyDecision {
  const effect = policy.effect;
  const approvalMode = policy.approvalMode;

  if (effect === "deny") {
    return "deny";
  }

  if (approvalMode === "required") {
    return "require_approval";
  }

  if (approvalMode === "auto") {
    return "allow";
  }

  return defaultDecision;
}

export function getDecisionForContext(
  tool: PolicyTool,
  context: { workspaceId: string; accountId?: string; clientId?: string },
  policies: AccessPolicyRecord[],
): PolicyDecision {
  if (tool.path === "discover") {
    return "allow";
  }

  const defaultDecision: PolicyDecision = tool.approval === "required" ? "require_approval" : "allow";
  const candidates = policies
    .filter((policy) => {
      const scopeType = policy.scopeType;
      const targetAccountId = policy.targetAccountId;
      const resourcePattern = policy.resourcePattern;
      const matchType = policy.matchType;

      if (scopeType === "workspace" && policy.workspaceId !== context.workspaceId) return false;
      if (scopeType === "organization" && !policy.organizationId) return false;
      if (targetAccountId && targetAccountId !== context.accountId) return false;
      if (policy.clientId && policy.clientId !== context.clientId) return false;
      return matchesToolPath(resourcePattern, tool.path, matchType);
    })
    .sort(
      (a, b) =>
        policySpecificity(b, context)
        - policySpecificity(a, context),
    );

  return candidates[0] ? resolvePolicyDecision(candidates[0], defaultDecision) : defaultDecision;
}

export function getToolDecision(
  task: TaskRecord,
  tool: PolicyTool,
  policies: AccessPolicyRecord[],
): PolicyDecision {
  return getDecisionForContext(
    tool,
    {
      workspaceId: task.workspaceId,
      accountId: task.accountId,
      clientId: task.clientId,
    },
    policies,
  );
}

export function isToolAllowedForTask(
  task: TaskRecord,
  toolPath: string,
  workspaceTools: ReadonlyMap<string, PolicyTool>,
  policies: AccessPolicyRecord[],
): boolean {
  const tool = workspaceTools.get(toolPath);
  if (!tool) return false;
  return getToolDecision(task, tool, policies) !== "deny";
}
