import type { Policy } from "./policies";
import { PolicyDecision, type PolicyCheckInput } from "./policies";

const escapeRegExp = (value: string): string => value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

export const matchesPolicyPattern = (pattern: string, toolId: string): boolean =>
  new RegExp(`^${escapeRegExp(pattern).replace(/\*/g, ".*")}$`).test(toolId);

export const policyLiteralCharCount = (pattern: string): number => pattern.replace(/\*/g, "").length;

export const policySpecificity = (policy: Pick<Policy, "priority" | "toolPattern">): number =>
  policy.priority + policyLiteralCharCount(policy.toolPattern);

export const comparePoliciesByPrecedence = (left: Policy, right: Policy): number =>
  policySpecificity(right) - policySpecificity(left) ||
  right.createdAt.getTime() - left.createdAt.getTime();

export const sortPoliciesByPrecedence = (policies: ReadonlyArray<Policy>): readonly Policy[] =>
  [...policies].sort(comparePoliciesByPrecedence);

export const evaluatePolicyDecision = (
  policies: ReadonlyArray<Policy>,
  input: PolicyCheckInput,
): PolicyDecision => {
  const matched = sortPoliciesByPrecedence(
    policies.filter(
      (policy) =>
        policy.enabled &&
        policy.scopeId === input.scopeId &&
        matchesPolicyPattern(policy.toolPattern, input.toolId),
    ),
  )[0];

  if (!matched) {
    return new PolicyDecision({
      kind: "fallback",
      matchedPolicyId: null,
      reason: `No matching policy for ${input.toolId}`,
    });
  }

  if (matched.effect === "deny") {
    return new PolicyDecision({
      kind: "deny",
      matchedPolicyId: matched.id,
      reason: `Denied by policy ${matched.id}`,
    });
  }

  if (matched.approvalMode === "required") {
    return new PolicyDecision({
      kind: "require_interaction",
      matchedPolicyId: matched.id,
      reason: `Approval required by policy ${matched.id}`,
    });
  }

  return new PolicyDecision({
    kind: "allow",
    matchedPolicyId: matched.id,
    reason: `Allowed by policy ${matched.id}`,
  });
};
