"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import {
  executeLocalVmRun,
} from "../src/runtime-node/runtime-dispatch";
import { compileExternalToolSource as compileExternalToolSourceInNode } from "../../core/src/tool-sources";
import { prepareOpenApiSpec as prepareOpenApiSpecInNode } from "../../core/src/openapi-prepare";
import { jsonObjectValidator } from "../src/database/validators";

export const executeLocalVm = internalAction({
  args: {
    taskId: v.string(),
    code: v.string(),
    timeoutMs: v.number(),
  },
  handler: async (_ctx, args) => {
    return await executeLocalVmRun(args);
  },
});

export const compileExternalToolSource = internalAction({
  args: {
    source: jsonObjectValidator,
  },
  handler: async (_ctx, args): Promise<string> => {
    const source = args.source as unknown as { type?: string; name?: string };
    if (typeof source.type !== "string" || typeof source.name !== "string") {
      throw new Error("Runtime source compile requires source.type and source.name");
    }
    const artifact = await compileExternalToolSourceInNode(args.source as any);
    return JSON.stringify(artifact);
  },
});

export const prepareOpenApiSpec = internalAction({
  args: {
    specUrl: v.string(),
    sourceName: v.string(),
    includeDts: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<string> => {
    const prepared = await prepareOpenApiSpecInNode(args.specUrl, args.sourceName, {
      includeDts: args.includeDts,
      profile: "full",
    });

    const json = JSON.stringify(prepared);
    const blob = new Blob([json], { type: "application/json" });
    const storageId = await ctx.storage.store(blob);

    return JSON.stringify({
      storageId,
      sizeBytes: json.length,
    });
  },
});
