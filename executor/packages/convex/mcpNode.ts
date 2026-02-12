"use node";

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { loadSourceDtsByUrl } from "../core/src/dts-loader";
import {
  analyzeToolReferences,
  generateToolDeclarations,
  sliceOpenApiOperationsDts,
  typecheckCode,
} from "../core/src/typechecker";
import type { ToolDescriptor } from "../core/src/types";
import { sourceSignature } from "./executor_node/tool_source_loading";

if (typeof (globalThis as { require?: unknown }).require !== "function") {
  (globalThis as { require?: unknown }).require = createRequire(import.meta.url);
}

const DECLARATION_CACHE_VERSION = "v1";
const DECLARATION_CACHE_TTL_MS = 24 * 60 * 60_000;
const DECLARATION_CACHE_MAX_ENTRIES_PER_WORKSPACE = 96;

function hashString(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeEnginePreference(): string {
  const value = process.env.EXECUTOR_TYPECHECK_ENGINE?.trim().toLowerCase();
  if (!value) return "auto";
  if (value === "typescript") return "typescript";
  if (value === "tsgo") return "tsgo";
  return value;
}

function toolFingerprint(tools: ToolDescriptor[]): string {
  const compact = tools
    .map((tool) => ({
      path: tool.path,
      approval: tool.approval,
      source: tool.source ?? "",
      argsType: tool.argsType ?? "",
      returnsType: tool.returnsType ?? "",
      strictArgsType: tool.strictArgsType ?? "",
      strictReturnsType: tool.strictReturnsType ?? "",
      operationId: tool.operationId ?? "",
      argPreviewKeys: Array.isArray(tool.argPreviewKeys) ? [...tool.argPreviewKeys].sort() : [],
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return hashString(JSON.stringify(compact));
}

function declarationSelectionFingerprint(
  selectiveMode: boolean,
  operationIdsBySource: Map<string, Set<string>>,
  sourcesRequiringFullDts: Set<string>,
): string {
  if (!selectiveMode) {
    return "mode:full";
  }

  const parts: string[] = [];
  for (const source of [...sourcesRequiringFullDts].sort((a, b) => a.localeCompare(b))) {
    parts.push(`${source}:*`);
  }
  for (const [source, operationIds] of [...operationIdsBySource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(`${source}:${[...operationIds].sort((a, b) => a.localeCompare(b)).join(",")}`);
  }

  return parts.length > 0 ? parts.join("|") : "mode:selective:none";
}

function declarationCacheKey(input: {
  workspaceSignature: string;
  toolsFingerprint: string;
  selectionFingerprint: string;
  enginePreference: string;
  hasDynamicToolAccess: boolean;
  hasNonCallToolAccess: boolean;
}): string {
  const payload = [
    DECLARATION_CACHE_VERSION,
    input.workspaceSignature,
    input.toolsFingerprint,
    input.selectionFingerprint,
    input.enginePreference,
    input.hasDynamicToolAccess ? "dynamic:1" : "dynamic:0",
    input.hasNonCallToolAccess ? "noncall:1" : "noncall:0",
  ].join("|");
  return `${DECLARATION_CACHE_VERSION}:${hashString(payload)}`;
}

function shouldUseSelectiveOpenApiDts(analysis: ReturnType<typeof analyzeToolReferences>): boolean {
  return !analysis.hasDynamicToolAccess && !analysis.hasNonCallToolAccess;
}

function mapOperationIdsBySource(
  tools: ToolDescriptor[],
  callPaths: readonly string[],
  availableDtsSources: ReadonlySet<string>,
): {
  operationIdsBySource: Map<string, Set<string>>;
  sourcesRequiringFullDts: Set<string>;
} {
  const toolByPath = new Map<string, ToolDescriptor>(tools.map((tool) => [tool.path, tool]));
  const operationIdsBySource = new Map<string, Set<string>>();
  const sourcesRequiringFullDts = new Set<string>();

  for (const path of callPaths) {
    const descriptor = toolByPath.get(path);
    if (!descriptor?.source || !availableDtsSources.has(descriptor.source)) continue;

    if (!descriptor.operationId) {
      sourcesRequiringFullDts.add(descriptor.source);
      continue;
    }

    const operationIds = operationIdsBySource.get(descriptor.source) ?? new Set<string>();
    operationIds.add(descriptor.operationId);
    operationIdsBySource.set(descriptor.source, operationIds);
  }

  return { operationIdsBySource, sourcesRequiringFullDts };
}

function selectToolsForTypecheck(
  tools: ToolDescriptor[],
  analysis: ReturnType<typeof analyzeToolReferences>,
): ToolDescriptor[] {
  if (!shouldUseSelectiveOpenApiDts(analysis)) {
    return tools;
  }

  if (analysis.callPaths.length === 0) {
    return [];
  }

  const wanted = new Set(analysis.callPaths);
  return tools.filter((tool) => wanted.has(tool.path));
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

    const [result, sources] = await Promise.all([
      ctx.runAction(internal.executorNode.listToolsWithWarningsInternal, toolContext) as Promise<{
        tools: ToolDescriptor[];
        dtsUrls?: Record<string, string>;
      }>,
      ctx.runQuery(internal.database.listToolSources, { workspaceId: args.workspaceId }) as Promise<Array<{
        id: string;
        updatedAt: number;
        enabled: boolean;
      }>>,
    ]);

    const enabledSources = sources.filter((source) => source.enabled);
    const workspaceSignature = sourceSignature(args.workspaceId, enabledSources);

    const dtsUrls = result.dtsUrls ?? {};
    const dtsSources = new Set(Object.keys(dtsUrls));
    const analysis = analyzeToolReferences(args.code);
    const selectiveMode = shouldUseSelectiveOpenApiDts(analysis);
    const toolsForTypecheck = selectToolsForTypecheck(result.tools, analysis);

    let dtsUrlsToLoad: Record<string, string> = {};
    let operationIdsBySource = new Map<string, Set<string>>();
    let sourcesRequiringFullDts = new Set<string>();

    if (selectiveMode) {
      const mapped = mapOperationIdsBySource(result.tools, analysis.callPaths, dtsSources);
      operationIdsBySource = mapped.operationIdsBySource;
      sourcesRequiringFullDts = mapped.sourcesRequiringFullDts;

      for (const source of mapped.sourcesRequiringFullDts) {
        const url = dtsUrls[source];
        if (url) {
          dtsUrlsToLoad[source] = url;
        }
      }
      for (const [source] of operationIdsBySource) {
        const url = dtsUrls[source];
        if (url) {
          dtsUrlsToLoad[source] = url;
        }
      }
    } else {
      dtsUrlsToLoad = dtsUrls;
    }

    const cacheKey = declarationCacheKey({
      workspaceSignature,
      toolsFingerprint: toolFingerprint(toolsForTypecheck),
      selectionFingerprint: declarationSelectionFingerprint(
        selectiveMode,
        operationIdsBySource,
        sourcesRequiringFullDts,
      ),
      enginePreference: normalizeEnginePreference(),
      hasDynamicToolAccess: analysis.hasDynamicToolAccess,
      hasNonCallToolAccess: analysis.hasNonCallToolAccess,
    });

    let declarations: string | null = null;

    try {
      const cacheEntry = await ctx.runQuery(internal.typecheckDeclarationCache.getEntry, {
        workspaceId: args.workspaceId,
        cacheKey,
        maxAgeMs: DECLARATION_CACHE_TTL_MS,
      });
      if (cacheEntry) {
        const blob = await ctx.storage.get(cacheEntry.storageId);
        if (blob) {
          declarations = await blob.text();
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[executor] declaration cache read failed for '${args.workspaceId}': ${message}`);
    }

    if (!declarations) {
      const sourceDtsBySource = await loadSourceDtsByUrl(dtsUrlsToLoad);

      if (selectiveMode) {
        for (const [source, operationIds] of operationIdsBySource.entries()) {
          const fullDts = sourceDtsBySource[source];
          if (!fullDts) continue;
          const sliced = sliceOpenApiOperationsDts(fullDts, operationIds);
          if (sliced) {
            sourceDtsBySource[source] = sliced;
          }
        }
      }

      declarations = generateToolDeclarations(toolsForTypecheck, {
        sourceDtsBySource,
      });

      try {
        const blob = new Blob([declarations], { type: "text/plain" });
        const storageId = await ctx.storage.store(blob);
        await ctx.runMutation(internal.typecheckDeclarationCache.putEntry, {
          workspaceId: args.workspaceId,
          cacheKey,
          storageId,
          sizeBytes: declarations.length,
          maxEntriesPerWorkspace: DECLARATION_CACHE_MAX_ENTRIES_PER_WORKSPACE,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[executor] declaration cache write failed for '${args.workspaceId}': ${message}`);
      }
    }

    const declarationText = declarations ?? "declare const tools: {};";
    const typecheck = typecheckCode(args.code, declarationText);

    return {
      ok: typecheck.ok,
      errors: [...typecheck.errors],
      tools: result.tools,
    };
  },
});
