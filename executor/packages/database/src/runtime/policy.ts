import type {
  AccessPolicyRecord,
  ArgumentCondition,
  PolicyDecision,
  TaskRecord,
} from "../../../core/src/types";

interface PolicyTool {
  path: string;
  approval: "auto" | "required";
  source?: string;
}

function matchesToolPath(pattern: string, toolPath: string, matchType: "glob" | "exact" = "glob"): boolean {
  if (matchType === "exact") {
    return pattern === toolPath;
  }

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(toolPath);
}

function matchesArgumentCondition(condition: ArgumentCondition, value: unknown): boolean {
  const strValue = value == null ? "" : String(value);
  switch (condition.operator) {
    case "equals":
      return strValue === condition.value;
    case "not_equals":
      return strValue !== condition.value;
    case "contains":
      return strValue.includes(condition.value);
    case "starts_with":
      return strValue.startsWith(condition.value);
    default:
      return false;
  }
}

function matchesArgumentConditions(
  conditions: ArgumentCondition[] | undefined,
  input: Record<string, unknown> | undefined,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  if (!input) return false;
  return conditions.every((condition) => matchesArgumentCondition(condition, input[condition.key]));
}

function matchesPolicyResource(policy: AccessPolicyRecord, tool: PolicyTool): boolean {
  if (policy.resourceType === "all_tools") {
    return true;
  }

  if (policy.resourceType === "source") {
    if (!tool.source) {
      return false;
    }
    return matchesToolPath(policy.resourcePattern, tool.source, policy.matchType);
  }

  if (policy.resourceType === "namespace") {
    return matchesToolPath(policy.resourcePattern, tool.path, policy.matchType);
  }

  return matchesToolPath(policy.resourcePattern, tool.path, policy.matchType);
}

function policySpecificity(
  policy: AccessPolicyRecord,
  context: { workspaceId: string; accountId?: string; clientId?: string },
): number {
  const scopeType = policy.scopeType;
  const targetAccountId = policy.targetAccountId;
  const resourcePattern = policy.resourcePattern;
  const matchType = policy.matchType;
  const resourceType = policy.resourceType;

  let score = 0;
  if (scopeType === "workspace" && policy.workspaceId === context.workspaceId) score += 16;
  if (scopeType === "organization") score += 8;
  if (targetAccountId && context.accountId && targetAccountId === context.accountId) score += 64;
  if (policy.clientId && context.clientId && policy.clientId === context.clientId) score += 4;
  if (resourceType === "source") score += 12;
  if (resourceType === "namespace") score += 18;
  if (resourceType === "tool_path") score += 24;
  if (matchType === "exact") score += 3;
  // Policies with argument conditions are more specific.
  if (policy.argumentConditions && policy.argumentConditions.length > 0) score += 32;
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
  input?: Record<string, unknown>,
): PolicyDecision {
  if (tool.path === "discover") {
    return "allow";
  }

  const defaultDecision: PolicyDecision = tool.approval === "required" ? "require_approval" : "allow";
  const candidates = policies
    .filter((policy) => {
      const scopeType = policy.scopeType;
      const targetAccountId = policy.targetAccountId;

      if (scopeType === "workspace" && policy.workspaceId !== context.workspaceId) return false;
      if (targetAccountId && targetAccountId !== context.accountId) return false;
      if (policy.clientId && policy.clientId !== context.clientId) return false;
      if (!matchesPolicyResource(policy, tool)) return false;
      // If the policy has argument conditions and we have input, check them.
      // If we don't have input and the policy has conditions, skip the policy
      // (it can only match at invocation time when input is known).
      if (policy.argumentConditions && policy.argumentConditions.length > 0) {
        if (!input) return false;
        if (!matchesArgumentConditions(policy.argumentConditions, input)) return false;
      }
      return true;
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
  input?: Record<string, unknown>,
): PolicyDecision {
  return getDecisionForContext(
    tool,
    {
      workspaceId: task.workspaceId,
      accountId: task.accountId,
      clientId: task.clientId,
    },
    policies,
    input,
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
