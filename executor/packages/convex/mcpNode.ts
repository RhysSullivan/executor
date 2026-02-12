"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { loadSourceDtsByUrl } from "../core/src/dts-loader";
import { generateToolDeclarations, typecheckCode } from "../core/src/typechecker";
import type { ToolDescriptor } from "../core/src/types";

export const typecheckRunCodeInternal = internalAction({
  args: {
    code: v.string(),
    workspaceId: v.id("workspaces"),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const toolContext = {
      workspaceId: args.workspaceId,
      actorId: args.actorId,
      clientId: args.clientId,
    };

    const result = await ctx.runAction(internal.executorNode.listToolsWithWarningsInternal, toolContext) as {
      tools: ToolDescriptor[];
      dtsUrls?: Record<string, string>;
    };

    const sourceDtsBySource = await loadSourceDtsByUrl(result.dtsUrls ?? {});
    const declarations = generateToolDeclarations(result.tools, {
      sourceDtsBySource,
    });
    const typecheck = typecheckCode(args.code, declarations);

    return {
      ok: typecheck.ok,
      errors: [...typecheck.errors],
      tools: result.tools,
    };
  },
});
