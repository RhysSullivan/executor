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

export const policyDecisionValidator = v.union(v.literal("allow"), v.literal("require_approval"), v.literal("deny"));

export const credentialScopeValidator = v.union(v.literal("workspace"), v.literal("actor"));

export const credentialProviderValidator = v.union(
  v.literal("local-convex"),
  v.literal("workos-vault"),
);

export const toolSourceTypeValidator = v.union(v.literal("mcp"), v.literal("openapi"), v.literal("graphql"));
