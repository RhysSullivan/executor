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
export const policyMatchTypeValidator = v.union(v.literal("glob"), v.literal("exact"));
export const policyEffectValidator = v.union(v.literal("allow"), v.literal("deny"));
export const policyApprovalModeValidator = v.union(v.literal("inherit"), v.literal("auto"), v.literal("required"));
export const toolSourceScopeTypeValidator = v.union(v.literal("organization"), v.literal("workspace"));
export const credentialScopeTypeValidator = v.union(v.literal("account"), v.literal("organization"), v.literal("workspace"));

export const credentialProviderValidator = v.union(
  v.literal("local-convex"),
  v.literal("workos-vault"),
);

export const toolSourceTypeValidator = v.union(v.literal("mcp"), v.literal("openapi"), v.literal("graphql"));
