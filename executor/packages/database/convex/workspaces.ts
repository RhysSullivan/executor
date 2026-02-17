import { v } from "convex/values";
import { optionalAccountQuery, authedMutation } from "../../core/src/function-builders";
import {
  createWorkspaceHandler,
  generateWorkspaceIconUploadUrlHandler,
  listWorkspacesHandler,
} from "../src/workspaces/handlers";

export const create = authedMutation({
  method: "POST",
  args: {
    name: v.string(),
    organizationId: v.optional(v.id("organizations")),
    iconStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    return await createWorkspaceHandler(ctx, args);
  },
});

export const list = optionalAccountQuery({
  method: "GET",
  args: {
    organizationId: v.optional(v.id("organizations")),
  },
  handler: async (ctx, args) => {
    return await listWorkspacesHandler(ctx, args);
  },
});

export const generateWorkspaceIconUploadUrl = authedMutation({
  method: "POST",
  args: {},
  handler: async (ctx) => {
    return await generateWorkspaceIconUploadUrlHandler(ctx);
  },
});
