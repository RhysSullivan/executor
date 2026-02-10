"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { generateToolDeclarations, typecheckCode } from "../lib/typechecker";
import type { ToolDescriptor } from "../lib/types";

const dtsUrlCache = new Map<string, Promise<string | null>>();

async function loadSourceDtsByUrl(dtsUrls: Record<string, string>): Promise<Record<string, string>> {
  const entries = Object.entries(dtsUrls);
  if (entries.length === 0) {
    return {};
  }

  const results = await Promise.all(entries.map(async ([sourceKey, url]) => {
    if (!url) return [sourceKey, null] as const;

    if (!dtsUrlCache.has(url)) {
      dtsUrlCache.set(url, (async () => {
        try {
          const response = await fetch(url);
          if (!response.ok) {
            console.warn(`[executor] failed to fetch source .d.ts from ${url}: HTTP ${response.status}`);
            return null;
          }
          return await response.text();
        } catch (error) {
          console.warn(
            `[executor] failed to fetch source .d.ts from ${url}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      })());
    }

    const content = await dtsUrlCache.get(url)!;
    return [sourceKey, content] as const;
  }));

  const sourceDtsBySource: Record<string, string> = {};
  for (const [sourceKey, dts] of results) {
    if (dts) {
      sourceDtsBySource[sourceKey] = dts;
    }
  }
  return sourceDtsBySource;
}

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
