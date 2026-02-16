"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { upsertCredentialHandler } from "../src/credentials-node/upsert-credential";

const credentialScopeValidator = v.union(v.literal("workspace"), v.literal("actor"));
const credentialProviderValidator = v.union(v.literal("local-convex"), v.literal("workos-vault"));

export const upsertCredential = action({
  args: {
    id: v.optional(v.string()),
    workspaceId: v.id("workspaces"),
    sessionId: v.optional(v.string()),
    sourceKey: v.string(),
    scope: credentialScopeValidator,
    actorId: v.optional(v.string()),
    provider: v.optional(credentialProviderValidator),
    secretJson: v.any(),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    return await upsertCredentialHandler(ctx, internal, args);
  },
});
