"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { customAction } from "../../core/src/function-builders";
import { upsertCredentialHandler } from "../src/credentials-node/upsert-credential";
import {
  credentialProviderValidator,
  credentialScopeTypeValidator,
  jsonObjectValidator,
} from "../src/database/validators";

export const upsertCredential = customAction({
  method: "POST",
  args: {
    id: v.optional(v.string()),
    workspaceId: v.id("workspaces"),
    sessionId: v.optional(v.string()),
    scopeType: v.optional(credentialScopeTypeValidator),
    sourceKey: v.string(),
    accountId: v.optional(v.id("accounts")),
    provider: v.optional(credentialProviderValidator),
    secretJson: jsonObjectValidator,
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    return await upsertCredentialHandler(ctx, internal, args);
  },
});
