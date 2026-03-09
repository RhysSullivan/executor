import type {
  Policy,
  PolicyArgumentCondition,
  Source,
} from "#schema";

export type InvocationOperationKind =
  | "read"
  | "write"
  | "delete"
  | "execute"
  | "unknown";

export type InvocationDescriptor = {
  toolPath: string;
  sourceId: Source["id"];
  sourceName: Source["name"];
  sourceKind: Source["kind"];
  sourceNamespace: string | null;
  operationKind: InvocationOperationKind;
  httpMethod: string | null;
  httpPathTemplate: string | null;
  graphqlOperationType: "query" | "mutation" | "subscription" | null;
};

export type InvocationPolicyContext = {
  workspaceId: Exclude<Policy["workspaceId"], null>;
  organizationId: Policy["organizationId"];
  accountId?: Policy["targetAccountId"];
  clientId?: Policy["clientId"];
};

export type InvocationAuthorizationDecision = {
  kind: "allow" | "deny" | "require_interaction";
  reason: string;
  matchedPolicyId: Policy["id"] | null;
};

const namespaceFromToolPath = (toolPath: string): string | null => {
  const parts = toolPath.split(".").filter(Boolean);
  if (parts.length <= 1) {
    return null;
  }

  return parts.slice(0, -1).join(".");
};

const matchesPattern = (
  pattern: string,
  value: string,
  matchType: Policy["matchType"],
): boolean => {
  if (matchType === "exact") {
    return pattern === value;
  }

  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
};

const parseArgumentConditions = (
  argumentConditionsJson: Policy["argumentConditionsJson"],
): ReadonlyArray<PolicyArgumentCondition> | null => {
  if (argumentConditionsJson === null) {
    return [];
  }

  try {
    const parsed = JSON.parse(argumentConditionsJson) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }

    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }

      const candidate = item as Record<string, unknown>;
      return typeof candidate.key === "string"
        && typeof candidate.operator === "string"
        && typeof candidate.value === "string"
        ? [{
            key: candidate.key,
            operator: candidate.operator as PolicyArgumentCondition["operator"],
            value: candidate.value,
          } satisfies PolicyArgumentCondition]
        : [];
    });
  } catch {
    return null;
  }
};

const asString = (value: unknown): string => value == null ? "" : String(value);

const matchesArgumentCondition = (
  condition: PolicyArgumentCondition,
  args: Record<string, unknown>,
): boolean => {
  const value = asString(args[condition.key]);
  switch (condition.operator) {
    case "equals":
      return value === condition.value;
    case "not_equals":
      return value !== condition.value;
    case "contains":
      return value.includes(condition.value);
    case "starts_with":
      return value.startsWith(condition.value);
    default:
      return false;
  }
};

const matchesArgumentConditions = (
  policy: Policy,
  args: unknown,
): boolean => {
  const conditions = parseArgumentConditions(policy.argumentConditionsJson);
  if (conditions === null) {
    return false;
  }
  if (conditions.length === 0) {
    return true;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return false;
  }

  const record = args as Record<string, unknown>;
  return conditions.every((condition) => matchesArgumentCondition(condition, record));
};

const matchesScope = (
  policy: Policy,
  context: InvocationPolicyContext,
): boolean => {
  if (policy.organizationId !== context.organizationId) {
    return false;
  }
  if (policy.scopeType === "workspace" && policy.workspaceId !== context.workspaceId) {
    return false;
  }
  if (policy.scopeType === "organization" && policy.workspaceId !== null) {
    return false;
  }
  if (policy.targetAccountId && policy.targetAccountId !== context.accountId) {
    return false;
  }
  if (policy.clientId && policy.clientId !== context.clientId) {
    return false;
  }

  return true;
};

const matchesResource = (
  policy: Policy,
  descriptor: InvocationDescriptor,
): boolean => {
  if (policy.resourceType === "all_tools") {
    return true;
  }

  if (policy.resourceType === "source") {
    return [descriptor.sourceId, `source:${descriptor.sourceId}`].some((candidate) =>
      matchesPattern(policy.resourcePattern, candidate, policy.matchType));
  }

  if (policy.resourceType === "namespace") {
    const namespace = descriptor.sourceNamespace ?? namespaceFromToolPath(descriptor.toolPath);
    return namespace === null
      ? false
      : matchesPattern(policy.resourcePattern, namespace, policy.matchType);
  }

  return matchesPattern(policy.resourcePattern, descriptor.toolPath, policy.matchType);
};

const policySpecificity = (
  policy: Policy,
  context: InvocationPolicyContext,
): number => {
  let score = 0;

  score += policy.scopeType === "workspace" ? 64 : 32;
  if (policy.targetAccountId && policy.targetAccountId === context.accountId) {
    score += 128;
  }
  if (policy.clientId && policy.clientId === context.clientId) {
    score += 16;
  }

  switch (policy.resourceType) {
    case "tool_path":
      score += 24;
      break;
    case "namespace":
      score += 18;
      break;
    case "source":
      score += 12;
      break;
    default:
      break;
  }

  if (policy.matchType === "exact") {
    score += 4;
  }
  if (policy.argumentConditionsJson !== null) {
    score += 32;
  }

  score += policy.priority;
  score += Math.max(1, policy.resourcePattern.replace(/\*/g, "").length);
  return score;
};

const defaultDecisionForInvocation = (
  descriptor: InvocationDescriptor,
): InvocationAuthorizationDecision => {
  if (descriptor.sourceKind === "openapi") {
    const method = descriptor.httpMethod?.toUpperCase() ?? null;
    if (method === "GET" || method === "HEAD") {
      return {
        kind: "allow",
        reason: `${method} defaults to allow`,
        matchedPolicyId: null,
      };
    }

    return {
      kind: "require_interaction",
      reason: `${method ?? "unknown HTTP method"} defaults to approval`,
      matchedPolicyId: null,
    };
  }

  if (descriptor.sourceKind === "graphql") {
    if (descriptor.graphqlOperationType === "query") {
      return {
        kind: "allow",
        reason: "GraphQL query defaults to allow",
        matchedPolicyId: null,
      };
    }

    return {
      kind: "require_interaction",
      reason: `${descriptor.graphqlOperationType ?? "Unknown GraphQL operation"} defaults to approval`,
      matchedPolicyId: null,
    };
  }

  return {
    kind: "allow",
    reason: "No invocation-specific approval required by default",
    matchedPolicyId: null,
  };
};

const resolvePolicyDecision = (
  policy: Policy,
): InvocationAuthorizationDecision => {
  if (policy.effect === "deny") {
    return {
      kind: "deny",
      reason: `Denied by policy ${policy.id}`,
      matchedPolicyId: policy.id,
    };
  }

  if (policy.approvalMode === "required") {
    return {
      kind: "require_interaction",
      reason: `Approval required by policy ${policy.id}`,
      matchedPolicyId: policy.id,
    };
  }

  return {
    kind: "allow",
    reason: `Allowed by policy ${policy.id}`,
    matchedPolicyId: policy.id,
  };
};

export const evaluateInvocationPolicy = (input: {
  descriptor: InvocationDescriptor;
  args: unknown;
  policies: ReadonlyArray<Policy>;
  context: InvocationPolicyContext;
}): InvocationAuthorizationDecision => {
  const candidates = input.policies
    .filter((policy) => policy.enabled)
    .filter((policy) => matchesScope(policy, input.context))
    .filter((policy) => matchesResource(policy, input.descriptor))
    .filter((policy) => matchesArgumentConditions(policy, input.args))
    .sort((left, right) =>
      policySpecificity(right, input.context) - policySpecificity(left, input.context));

  return candidates[0]
    ? resolvePolicyDecision(candidates[0])
    : defaultDecisionForInvocation(input.descriptor);
};
