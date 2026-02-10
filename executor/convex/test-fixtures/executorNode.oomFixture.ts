import { v } from "convex/values";
import { internalAction } from "../_generated/server";

const OOM_MESSAGE = "JavaScript execution ran out of memory (maximum memory usage: 64 MB): request stream size was 0 bytes";

const TOOL = {
  path: "github.users.get_authenticated",
  description: "Get the authenticated GitHub user",
  approval: "auto" as const,
  source: "openapi:github",
  argsType: "{}",
  returnsType: "{ login: string; name: string | null; email: string | null }",
  operationId: "users/get-authenticated",
};

export const listToolsInternal = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async () => {
    return [TOOL];
  },
});

export const listToolsWithWarningsInternal = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async () => {
    throw new Error(OOM_MESSAGE);
  },
});
