import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { workspaceAction } from "../../core/src/function-builders";
import { readVaultObjectHandler } from "../src/credentials-node/read-vault-object";
import { upsertCredentialHandler } from "../src/credentials-node/upsert-credential";
import {
  credentialAdditionalHeadersValidator,
  credentialProviderValidator,
  credentialScopeTypeValidator,
  jsonObjectValidator,
} from "../src/database/validators";
import { vv } from "./typedV";

export const upsertCredential = workspaceAction({
  method: "POST",
  requireAdmin: true,
  args: {
    id: v.optional(v.string()),
    scopeType: v.optional(credentialScopeTypeValidator),
    sourceKey: v.string(),
    accountId: v.optional(vv.id("accounts")),
    provider: v.optional(credentialProviderValidator),
    secretJson: jsonObjectValidator,
    additionalHeaders: v.optional(credentialAdditionalHeadersValidator),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    return await upsertCredentialHandler(ctx, internal, args);
  },
});

export const readVaultObject = internalAction({
  args: {
    objectId: v.string(),
    apiKey: v.optional(v.string()),
  },
  handler: async (_ctx, args): Promise<string> => {
    return await readVaultObjectHandler(args);
  },
});
