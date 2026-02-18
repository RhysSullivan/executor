import { v } from "convex/values";

export const jsonObjectValidator = v.record(v.string(), v.any());

export const completedTaskStatusValidator = v.union(
  v.literal("completed"),
  v.literal("failed"),
  v.literal("timed_out"),
  v.literal("denied"),
);

export const approvalStatusValidator = v.union(v.literal("pending"), v.literal("approved"), v.literal("denied"));

export const terminalToolCallStatusValidator = v.union(
  v.literal("completed"),
  v.literal("failed"),
  v.literal("denied"),
);

export const policyScopeTypeValidator = v.union(v.literal("account"), v.literal("organization"), v.literal("workspace"));
export const policyResourceTypeValidator = v.union(
  v.literal("all_tools"),
  v.literal("source"),
  v.literal("namespace"),
  v.literal("tool_path"),
);
export const policyMatchTypeValidator = v.union(v.literal("glob"), v.literal("exact"));
export const policyEffectValidator = v.union(v.literal("allow"), v.literal("deny"));
export const policyApprovalModeValidator = v.union(v.literal("inherit"), v.literal("auto"), v.literal("required"));
export const toolRoleSelectorTypeValidator = v.union(
  v.literal("all"),
  v.literal("source"),
  v.literal("namespace"),
  v.literal("tool_path"),
);
export const toolRoleBindingStatusValidator = v.union(v.literal("active"), v.literal("disabled"));
export const argumentConditionOperatorValidator = v.union(v.literal("equals"), v.literal("contains"), v.literal("starts_with"), v.literal("not_equals"));
export const argumentConditionValidator = v.object({
  key: v.string(),
  operator: argumentConditionOperatorValidator,
  value: v.string(),
});
export const toolSourceScopeTypeValidator = v.union(v.literal("organization"), v.literal("workspace"));
export const credentialScopeTypeValidator = v.union(v.literal("account"), v.literal("organization"), v.literal("workspace"));

export const credentialProviderValidator = v.union(
  v.literal("local-convex"),
  v.literal("workos-vault"),
);

export const toolSourceTypeValidator = v.union(v.literal("mcp"), v.literal("openapi"), v.literal("graphql"));
