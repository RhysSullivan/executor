"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";
import { InProcessExecutionAdapter } from "../lib/adapters/in_process_execution_adapter";
import { resolveCredentialPayload } from "../lib/credential_providers";
import { APPROVAL_DENIED_PREFIX } from "../lib/execution_constants";
import { runCodeWithAdapter } from "../lib/runtimes/runtime_core";
import { createDiscoverTool } from "../lib/tool_discovery";
import {
  buildOpenApiToolsFromPrepared,
  loadExternalTools,
  parseGraphqlOperationPaths,
  prepareOpenApiSpec,
  rehydrateTools,
  serializeTools,
  type PreparedOpenApiSpec,
  type ExternalToolSourceConfig,
  type WorkspaceToolSnapshot,
} from "../lib/tool_sources";
import { DEFAULT_TOOLS } from "../lib/tools";
import type {
  AccessPolicyRecord,
  CredentialScope,
  PolicyDecision,
  ResolvedToolCredential,
  TaskRecord,
  ToolCallRequest,
  ToolCallResult,
  ToolCredentialSpec,
  ToolDefinition,
  ToolDescriptor,
  OpenApiSourceQuality,
  ToolSourceRecord,
  ToolRunContext,
} from "../lib/types";
import { asPayload, describeError } from "../lib/utils";

function createApprovalId(): string {
  return `approval_${crypto.randomUUID()}`;
}

function matchesToolPath(pattern: string, toolPath: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(toolPath);
}

function policySpecificity(policy: AccessPolicyRecord, actorId?: string, clientId?: string): number {
  let score = 0;
  if (policy.actorId && actorId && policy.actorId === actorId) score += 4;
  if (policy.clientId && clientId && policy.clientId === clientId) score += 2;
  score += Math.max(1, policy.toolPathPattern.replace(/\*/g, "").length);
  score += policy.priority;
  return score;
}

function sourceSignature(workspaceId: string, sources: Array<{ id: string; updatedAt: number; enabled: boolean }>): string {
  const signatureVersion = "v8";
  const parts = sources
    .map((source) => `${source.id}:${source.updatedAt}:${source.enabled ? 1 : 0}`)
    .sort();
  return `${signatureVersion}|${workspaceId}|${parts.join(",")}`;
}

function normalizeExternalToolSource(raw: {
  type: ToolSourceRecord["type"];
  name: string;
  config: Record<string, unknown>;
}): ExternalToolSourceConfig {
  const merged = {
    type: raw.type,
    name: raw.name,
    ...raw.config,
  } as Record<string, unknown>;

  if (raw.type === "mcp") {
    if (typeof merged.url !== "string" || merged.url.trim().length === 0) {
      throw new Error(`MCP source '${raw.name}' missing url`);
    }

    if (
      merged.transport !== undefined
      && merged.transport !== "sse"
      && merged.transport !== "streamable-http"
    ) {
      throw new Error(`MCP source '${raw.name}' has invalid transport`);
    }

    if (merged.queryParams !== undefined) {
      const queryParams = merged.queryParams;
      if (!queryParams || typeof queryParams !== "object" || Array.isArray(queryParams)) {
        throw new Error(`MCP source '${raw.name}' queryParams must be an object`);
      }

      for (const value of Object.values(queryParams as Record<string, unknown>)) {
        if (typeof value !== "string") {
          throw new Error(`MCP source '${raw.name}' queryParams values must be strings`);
        }
      }
    }

    return merged as unknown as ExternalToolSourceConfig;
  }

  if (raw.type === "graphql") {
    if (typeof merged.endpoint !== "string" || merged.endpoint.trim().length === 0) {
      throw new Error(`GraphQL source '${raw.name}' missing endpoint`);
    }
    return merged as unknown as ExternalToolSourceConfig;
  }

  const spec = merged.spec;
  if (typeof spec !== "string" && typeof spec !== "object") {
    throw new Error(`OpenAPI source '${raw.name}' missing spec`);
  }

  return merged as unknown as ExternalToolSourceConfig;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const baseTools = new Map<string, ToolDefinition>(DEFAULT_TOOLS.map((tool) => [tool.path, tool]));
interface DtsStorageEntry {
  sourceKey: string;
  storageId: string;
}

const OPENAPI_SPEC_CACHE_TTL_MS = 5 * 60 * 60_000;

/** Cache version — bump when PreparedOpenApiSpec shape changes. */
const OPENAPI_CACHE_VERSION = "v11";

async function publish(
  ctx: any,
  taskId: string,
  eventName: "task" | "approval",
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await ctx.runMutation(internal.database.createTaskEvent, {
    taskId,
    eventName,
    type,
    payload,
  });
}

async function waitForApproval(ctx: any, approvalId: string): Promise<"approved" | "denied"> {
  while (true) {
    const approval = await ctx.runQuery(internal.database.getApproval, { approvalId });
    if (!approval) {
      throw new Error(`Approval ${approvalId} not found`);
    }

    if (approval.status !== "pending") {
      return approval.status as "approved" | "denied";
    }

    await sleep(500);
  }
}

/**
 * Load a prepared OpenAPI spec, using Convex file storage as a persistent cache.
 *
 * Flow:
 * 1. Check the `openApiSpecCache` table for a valid entry → fetch blob from storage.
 * 2. On miss: prepare the spec from scratch, store the JSON blob, write the metadata row.
 *
 * No size limits — Convex file storage handles multi-MB specs without issue.
 */
async function loadCachedOpenApiSpec(
  ctx: any,
  specUrl: string,
  sourceName: string,
): Promise<PreparedOpenApiSpec> {
  // 1. Persistent cache (Convex table + file storage)
  try {
    const entry = await ctx.runQuery(internal.openApiSpecCache.getEntry, {
      specUrl,
      version: OPENAPI_CACHE_VERSION,
      maxAgeMs: OPENAPI_SPEC_CACHE_TTL_MS,
    });

    if (entry) {
      const blob = await ctx.storage.get(entry.storageId);
      if (blob) {
        const json = await blob.text();
        return JSON.parse(json) as PreparedOpenApiSpec;
      }
      // Blob missing (deleted externally?) — fall through to re-prepare
    }
  } catch (error) {
    // Cache read failed — log and fall through to fresh preparation
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[executor] OpenAPI cache read failed for '${sourceName}': ${message}`);
  }

  // 2. Cache miss — prepare from scratch
  const prepared = await prepareOpenApiSpec(specUrl, sourceName);

  // Store in file storage + metadata table (best-effort, don't block on failure)
  try {
    const json = JSON.stringify(prepared);
    const blob = new Blob([json], { type: "application/json" });
    const storageId = await ctx.storage.store(blob);
    await ctx.runMutation(internal.openApiSpecCache.putEntry, {
      specUrl,
      version: OPENAPI_CACHE_VERSION,
      storageId,
      sizeBytes: json.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[executor] OpenAPI cache write failed for '${sourceName}': ${message}`);
  }

  return prepared;
}

async function loadSourceTools(
  ctx: any,
  source: ExternalToolSourceConfig,
): Promise<{ tools: ToolDefinition[]; warnings: string[] }> {
  if (source.type === "openapi" && typeof source.spec === "string") {
    try {
      const prepared = await loadCachedOpenApiSpec(ctx, source.spec, source.name);
      const tools = buildOpenApiToolsFromPrepared(source, prepared);
      const warnings = (prepared.warnings ?? []).map(
        (warning) => `Source '${source.name}': ${warning}`,
      );
      return { tools, warnings };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        tools: [],
        warnings: [`Failed to load openapi source '${source.name}': ${message}`],
      };
    }
  }

  return await loadExternalTools([source]);
}

interface WorkspaceToolsResult {
  tools: Map<string, ToolDefinition>;
  warnings: string[];
  dtsStorageIds: DtsStorageEntry[];
}

async function getWorkspaceTools(ctx: any, workspaceId: string): Promise<WorkspaceToolsResult> {
  const sources = (await ctx.runQuery(internal.database.listToolSources, { workspaceId }))
    .filter((source: { enabled: boolean }) => source.enabled);
  const signature = sourceSignature(workspaceId, sources);

  // ── Layer 1: Persistent workspace cache (Convex file storage) ──────
  try {
    const cacheEntry = await ctx.runQuery(internal.workspaceToolCache.getEntry, {
      workspaceId,
      signature,
    });

    if (cacheEntry) {
      const blob = await ctx.storage.get(cacheEntry.storageId);
      if (blob) {
        const snapshot = JSON.parse(await blob.text()) as WorkspaceToolSnapshot;
        const rehydrated = rehydrateTools(snapshot.tools, baseTools);

        const merged = new Map<string, ToolDefinition>();
        for (const tool of rehydrated) {
          merged.set(tool.path, tool);
        }
        // Recreate discover tool (it captures the full tool list in a closure)
        const discover = createDiscoverTool([...merged.values()]);
        merged.set(discover.path, discover);

        const dtsStorageIds = (cacheEntry.dtsStorageIds ?? []) as DtsStorageEntry[];

        return { tools: merged, warnings: snapshot.warnings, dtsStorageIds };
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[executor] workspace tool cache read failed for '${workspaceId}': ${msg}`);
  }

  // ── Layer 2: Full rebuild from sources ─────────────────────────────
  const configs: ExternalToolSourceConfig[] = [];
  const warnings: string[] = [];
  for (const source of sources) {
    try {
      configs.push(normalizeExternalToolSource(source));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Source '${source.name}': ${message}`);
    }
  }

  const loadedSources = await Promise.all(configs.map((config) => loadSourceTools(ctx, config)));
  const externalTools = loadedSources.flatMap((loaded) => loaded.tools);
  warnings.push(...loadedSources.flatMap((loaded) => loaded.warnings));

  const merged = new Map<string, ToolDefinition>();
  for (const tool of baseTools.values()) {
    if (tool.path === "discover") continue;
    merged.set(tool.path, tool);
  }
  for (const tool of externalTools) {
    merged.set(tool.path, tool);
  }

  const discover = createDiscoverTool([...merged.values()]);
  merged.set(discover.path, discover);

  // ── Write to persistent workspace cache (best-effort) ─────────────
  let dtsStorageIds: DtsStorageEntry[] = [];
  try {
    const allTools = [...merged.values()];

    // Extract and store .d.ts blobs per source (too large for action responses)
    const seenDtsSources = new Set<string>();
    const dtsEntries: { sourceKey: string; content: string }[] = [];
    for (const tool of allTools) {
      if (tool.metadata?.sourceDts && tool.source && !seenDtsSources.has(tool.source)) {
        seenDtsSources.add(tool.source);
        dtsEntries.push({ sourceKey: tool.source, content: tool.metadata.sourceDts });
      }
    }

    // Store .d.ts blobs in parallel
    const storedDts = await Promise.all(
      dtsEntries.map(async (entry) => {
        const dtsBlob = new Blob([entry.content], { type: "text/plain" });
        const sid = await ctx.storage.store(dtsBlob);
        return { sourceKey: entry.sourceKey, storageId: String(sid) };
      }),
    );
    dtsStorageIds = storedDts;

    // Strip sourceDts from serialized tools (it's stored separately)
    const snapshot: WorkspaceToolSnapshot = {
      tools: serializeTools(allTools),
      warnings,
    };
    for (const st of snapshot.tools) {
      if (st.metadata?.sourceDts) {
        delete (st.metadata as Record<string, unknown>).sourceDts;
      }
    }

    const json = JSON.stringify(snapshot);
    const blob = new Blob([json], { type: "application/json" });
    const storageId = await ctx.storage.store(blob);
    await ctx.runMutation(internal.workspaceToolCache.putEntry, {
      workspaceId,
      signature,
      storageId,
      dtsStorageIds: storedDts.map((e) => ({ sourceKey: e.sourceKey, storageId: e.storageId as any })),
      toolCount: allTools.length,
      sizeBytes: json.length,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[executor] workspace tool cache write failed for '${workspaceId}': ${msg}`);
  }

  return { tools: merged, warnings, dtsStorageIds };
}

function getDecisionForContext(
  tool: ToolDefinition,
  context: { workspaceId: string; actorId?: string; clientId?: string },
  policies: AccessPolicyRecord[],
): PolicyDecision {
  const defaultDecision: PolicyDecision = tool.approval === "required" ? "require_approval" : "allow";
  const candidates = policies
    .filter((policy) => {
      if (policy.actorId && policy.actorId !== context.actorId) return false;
      if (policy.clientId && policy.clientId !== context.clientId) return false;
      return matchesToolPath(policy.toolPathPattern, tool.path);
    })
    .sort(
      (a, b) =>
        policySpecificity(b, context.actorId, context.clientId)
        - policySpecificity(a, context.actorId, context.clientId),
    );

  return candidates[0]?.decision ?? defaultDecision;
}

function getToolDecision(task: TaskRecord, tool: ToolDefinition, policies: AccessPolicyRecord[]): PolicyDecision {
  return getDecisionForContext(
    tool,
    {
      workspaceId: task.workspaceId,
      actorId: task.actorId,
      clientId: task.clientId,
    },
    policies,
  );
}

function toToolDescriptor(tool: ToolDefinition, approval: "auto" | "required"): ToolDescriptor {
  return {
    path: tool.path,
    description: tool.description,
    approval,
    source: tool.source,
    argsType: tool.metadata?.argsType,
    returnsType: tool.metadata?.returnsType,
    operationId: tool.metadata?.operationId,
    // Note: sourceDts is NOT included — it's too large to send over the wire.
    // Monaco fetches .d.ts blobs separately via Convex storage URLs.
    // Legacy compat
    schemaTypes: tool.metadata?.schemaTypes,
  };
}

function computeOpenApiSourceQuality(
  workspaceTools: Map<string, ToolDefinition>,
): Record<string, OpenApiSourceQuality> {
  const grouped = new Map<string, ToolDefinition[]>();

  for (const tool of workspaceTools.values()) {
    const sourceKey = tool.source;
    if (!sourceKey || !sourceKey.startsWith("openapi:")) continue;
    const list = grouped.get(sourceKey) ?? [];
    list.push(tool);
    grouped.set(sourceKey, list);
  }

  const qualityBySource: Record<string, OpenApiSourceQuality> = {};

  for (const [sourceKey, tools] of grouped.entries()) {
    const toolCount = tools.length;

    let unknownArgsCount = 0;
    let unknownReturnsCount = 0;
    let partialUnknownArgsCount = 0;
    let partialUnknownReturnsCount = 0;

    for (const tool of tools) {
      const argsType = tool.metadata?.argsType?.trim() ?? "";
      const returnsType = tool.metadata?.returnsType?.trim() ?? "";

      if (!argsType || argsType === "Record<string, unknown>") {
        unknownArgsCount += 1;
      }
      if (!returnsType || returnsType === "unknown") {
        unknownReturnsCount += 1;
      }
      if (argsType.includes("unknown")) {
        partialUnknownArgsCount += 1;
      }
      if (returnsType.includes("unknown")) {
        partialUnknownReturnsCount += 1;
      }
    }

    const argsQuality = toolCount > 0 ? (toolCount - unknownArgsCount) / toolCount : 1;
    const returnsQuality = toolCount > 0 ? (toolCount - unknownReturnsCount) / toolCount : 1;
    const overallQuality = (argsQuality + returnsQuality) / 2;

    qualityBySource[sourceKey] = {
      sourceKey,
      toolCount,
      unknownArgsCount,
      unknownReturnsCount,
      partialUnknownArgsCount,
      partialUnknownReturnsCount,
      argsQuality,
      returnsQuality,
      overallQuality,
    };
  }

  return qualityBySource;
}

function listVisibleToolDescriptors(
  workspaceTools: Map<string, ToolDefinition>,
  context: { workspaceId: string; actorId?: string; clientId?: string },
  policies: AccessPolicyRecord[],
): ToolDescriptor[] {
  const all = [...workspaceTools.values()];

  return all
    .filter((tool) => {
      const decision = getDecisionForContext(tool, context, policies);
      return decision !== "deny";
    })
    .map((tool) => {
      const decision = getDecisionForContext(tool, context, policies);
      return toToolDescriptor(tool, decision === "require_approval" ? "required" : "auto");
    });
}

async function listToolsForContext(
  ctx: any,
  context: { workspaceId: string; actorId?: string; clientId?: string },
): Promise<ToolDescriptor[]> {
  const [result, policies] = await Promise.all([
    getWorkspaceTools(ctx, context.workspaceId),
    ctx.runQuery(internal.database.listAccessPolicies, { workspaceId: context.workspaceId }),
  ]);
  const typedPolicies = policies as AccessPolicyRecord[];

  return listVisibleToolDescriptors(result.tools, context, typedPolicies);
}

async function listToolsWithWarningsForContext(
  ctx: any,
  context: { workspaceId: string; actorId?: string; clientId?: string },
): Promise<{
  tools: ToolDescriptor[];
  warnings: string[];
  dtsUrls: Record<string, string>;
  sourceQuality: Record<string, OpenApiSourceQuality>;
}> {
  const [result, policies] = await Promise.all([
    getWorkspaceTools(ctx, context.workspaceId),
    ctx.runQuery(internal.database.listAccessPolicies, { workspaceId: context.workspaceId }),
  ]);
  const typedPolicies = policies as AccessPolicyRecord[];
  const tools = listVisibleToolDescriptors(result.tools, context, typedPolicies);
  const sourceQuality = computeOpenApiSourceQuality(result.tools);

  // Generate download URLs for .d.ts blobs
  const dtsUrls: Record<string, string> = {};
  for (const entry of result.dtsStorageIds) {
    try {
      const url = await ctx.storage.getUrl(entry.storageId);
      if (url) dtsUrls[entry.sourceKey] = url;
    } catch {
      // Storage ID may be stale — skip
    }
  }

  return {
    tools,
    warnings: result.warnings,
    dtsUrls,
    sourceQuality,
  };
}

function actorIdForAccount(account: { _id: string; provider: string; providerAccountId: string }): string {
  return account.provider === "anonymous" ? account.providerAccountId : account._id;
}

function isToolAllowedForTask(
  task: TaskRecord,
  toolPath: string,
  workspaceTools: Map<string, ToolDefinition>,
  policies: AccessPolicyRecord[],
): boolean {
  const tool = workspaceTools.get(toolPath);
  if (!tool) return false;
  return getToolDecision(task, tool, policies) !== "deny";
}

async function resolveCredentialHeaders(
  ctx: any,
  spec: ToolCredentialSpec,
  task: TaskRecord,
): Promise<ResolvedToolCredential | null> {
  const record = await ctx.runQuery(internal.database.resolveCredential, {
    workspaceId: task.workspaceId,
    sourceKey: spec.sourceKey,
    scope: spec.mode as CredentialScope,
    actorId: task.actorId,
  });

  const source = record
    ? await resolveCredentialPayload(record)
    : spec.staticSecretJson ?? null;
  if (!source) {
    return null;
  }

  const headers: Record<string, string> = {};
  if (spec.authType === "bearer") {
    const token = String((source as Record<string, unknown>).token ?? "").trim();
    if (token) headers.authorization = `Bearer ${token}`;
  } else if (spec.authType === "apiKey") {
    const headerName = spec.headerName ?? String((source as Record<string, unknown>).headerName ?? "x-api-key");
    const value = String((source as Record<string, unknown>).value ?? (source as Record<string, unknown>).token ?? "").trim();
    if (value) headers[headerName] = value;
  } else if (spec.authType === "basic") {
    const username = String((source as Record<string, unknown>).username ?? "");
    const password = String((source as Record<string, unknown>).password ?? "");
    if (username || password) {
      const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
      headers.authorization = `Basic ${encoded}`;
    }
  }

  if (Object.keys(headers).length === 0) {
    return null;
  }

  return {
    sourceKey: spec.sourceKey,
    mode: spec.mode,
    headers,
  };
}

function getGraphqlDecision(
  task: TaskRecord,
  tool: ToolDefinition,
  input: unknown,
  workspaceTools: Map<string, ToolDefinition>,
  policies: AccessPolicyRecord[],
): { decision: PolicyDecision; effectivePaths: string[] } {
  const sourceName = tool._graphqlSource!;
  const payload = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const queryString = typeof payload.query === "string" ? payload.query : "";

  if (!queryString.trim()) {
    return { decision: getToolDecision(task, tool, policies), effectivePaths: [tool.path] };
  }

  const { fieldPaths } = parseGraphqlOperationPaths(sourceName, queryString);
  if (fieldPaths.length === 0) {
    return { decision: getToolDecision(task, tool, policies), effectivePaths: [tool.path] };
  }

  let worstDecision: PolicyDecision = "allow";

  for (const fieldPath of fieldPaths) {
    const pseudoTool = workspaceTools.get(fieldPath);
    const fieldDecision = pseudoTool
      ? getDecisionForContext(
          pseudoTool,
          {
            workspaceId: task.workspaceId,
            actorId: task.actorId,
            clientId: task.clientId,
          },
          policies,
        )
      : getDecisionForContext(
          { ...tool, path: fieldPath, approval: fieldPath.includes(".mutation.") ? "required" : "auto" },
          {
            workspaceId: task.workspaceId,
            actorId: task.actorId,
            clientId: task.clientId,
          },
          policies,
        );

    if (fieldDecision === "deny") {
      worstDecision = "deny";
      break;
    }
    if (fieldDecision === "require_approval") {
      worstDecision = "require_approval";
    }
  }

  return { decision: worstDecision, effectivePaths: fieldPaths };
}

async function invokeTool(ctx: any, task: TaskRecord, call: ToolCallRequest): Promise<unknown> {
  const { toolPath, input, callId } = call;
  const policies = await ctx.runQuery(internal.database.listAccessPolicies, { workspaceId: task.workspaceId });
  const typedPolicies = policies as AccessPolicyRecord[];

  let workspaceTools: Map<string, ToolDefinition> | undefined;
  let tool = baseTools.get(toolPath);
  if (!tool) {
    const result = await getWorkspaceTools(ctx, task.workspaceId);
    workspaceTools = result.tools;
    tool = workspaceTools.get(toolPath);
  }

  if (!tool) {
    throw new Error(`Unknown tool: ${toolPath}`);
  }

  let decision: PolicyDecision;
  let effectiveToolPath = toolPath;
  if (tool._graphqlSource) {
    if (!workspaceTools) {
      const result = await getWorkspaceTools(ctx, task.workspaceId);
      workspaceTools = result.tools;
    }
    const result = getGraphqlDecision(task, tool, input, workspaceTools, typedPolicies);
    decision = result.decision;
    if (result.effectivePaths.length > 0) {
      effectiveToolPath = result.effectivePaths.join(", ");
    }
  } else {
    decision = getToolDecision(task, tool, typedPolicies);
  }

  if (decision === "deny") {
    await publish(ctx, task.id, "task", "tool.call.denied", {
      taskId: task.id,
      callId,
      toolPath: effectiveToolPath,
      reason: "policy_deny",
    });
    throw new Error(`${APPROVAL_DENIED_PREFIX}${effectiveToolPath} (policy denied)`);
  }

  let credential: ResolvedToolCredential | undefined;
  if (tool.credential) {
    const resolved = await resolveCredentialHeaders(ctx, tool.credential, task);
    if (!resolved) {
      throw new Error(`Missing credential for source '${tool.credential.sourceKey}' (${tool.credential.mode} scope)`);
    }
    credential = resolved;
  }

  await publish(ctx, task.id, "task", "tool.call.started", {
    taskId: task.id,
    callId,
    toolPath: effectiveToolPath,
    approval: decision === "require_approval" ? "required" : "auto",
    input: asPayload(input),
  });

  if (decision === "require_approval") {
    const approval = await ctx.runMutation(internal.database.createApproval, {
      id: createApprovalId(),
      taskId: task.id,
      toolPath: effectiveToolPath,
      input,
    });

    await publish(ctx, task.id, "approval", "approval.requested", {
      approvalId: approval.id,
      taskId: task.id,
      callId,
      toolPath: approval.toolPath,
      input: asPayload(approval.input),
      createdAt: approval.createdAt,
    });

    const approvalDecision = await waitForApproval(ctx, approval.id);
    if (approvalDecision === "denied") {
      await publish(ctx, task.id, "task", "tool.call.denied", {
        taskId: task.id,
        callId,
        toolPath: effectiveToolPath,
        approvalId: approval.id,
      });
      throw new Error(`${APPROVAL_DENIED_PREFIX}${effectiveToolPath} (${approval.id})`);
    }
  }

  try {
    const context: ToolRunContext = {
      taskId: task.id,
      workspaceId: task.workspaceId,
      actorId: task.actorId,
      clientId: task.clientId,
      credential,
      isToolAllowed: (path) => isToolAllowedForTask(task, path, workspaceTools ?? baseTools, typedPolicies),
    };
    const value = await tool.run(input, context);
    await publish(ctx, task.id, "task", "tool.call.completed", {
      taskId: task.id,
      callId,
      toolPath: effectiveToolPath,
      output: asPayload(value),
    });
    return value;
  } catch (error) {
    const message = describeError(error);
    await publish(ctx, task.id, "task", "tool.call.failed", {
      taskId: task.id,
      callId,
      toolPath: effectiveToolPath,
      error: message,
    });
    throw error;
  }
}

export const listTools = action({
  args: {
    workspaceId: v.string(),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ToolDescriptor[]> => {
    const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForRequest, {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
    });
    const canonicalActorId = actorIdForAccount({
      _id: access.accountId,
      provider: access.provider,
      providerAccountId: access.providerAccountId,
    });
    if (args.actorId && args.actorId !== canonicalActorId) {
      throw new Error("actorId must match the authenticated workspace actor");
    }

    return await listToolsForContext(ctx, {
      workspaceId: args.workspaceId,
      actorId: canonicalActorId,
      clientId: args.clientId,
    });
  },
});

export const listToolsWithWarnings = action({
  args: {
    workspaceId: v.string(),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    tools: ToolDescriptor[];
    warnings: string[];
    dtsUrls: Record<string, string>;
    sourceQuality: Record<string, OpenApiSourceQuality>;
  }> => {
    const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForRequest, {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
    });
    const canonicalActorId = actorIdForAccount({
      _id: access.accountId,
      provider: access.provider,
      providerAccountId: access.providerAccountId,
    });
    if (args.actorId && args.actorId !== canonicalActorId) {
      throw new Error("actorId must match the authenticated workspace actor");
    }

    return await listToolsWithWarningsForContext(ctx, {
      workspaceId: args.workspaceId,
      actorId: canonicalActorId,
      clientId: args.clientId,
    });
  },
});

export const listToolsInternal = internalAction({
  args: {
    workspaceId: v.string(),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ToolDescriptor[]> => {
    return await listToolsForContext(ctx, args);
  },
});

export const listToolsWithWarningsInternal = internalAction({
  args: {
    workspaceId: v.string(),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    tools: ToolDescriptor[];
    warnings: string[];
    dtsUrls: Record<string, string>;
    sourceQuality: Record<string, OpenApiSourceQuality>;
  }> => {
    return await listToolsWithWarningsForContext(ctx, args);
  },
});

export const handleExternalToolCall = internalAction({
  args: {
    runId: v.string(),
    callId: v.string(),
    toolPath: v.string(),
    input: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<ToolCallResult> => {
    const task = (await ctx.runQuery(internal.database.getTask, {
      taskId: args.runId,
    })) as TaskRecord | null;
    if (!task) {
      return {
        ok: false,
        error: `Run not found: ${args.runId}`,
      };
    }

    try {
      const value = await invokeTool(ctx, task, {
        runId: args.runId,
        callId: args.callId,
        toolPath: args.toolPath,
        input: args.input ?? {},
      });
      return { ok: true, value };
    } catch (error) {
      const message = describeError(error);
      if (message.startsWith(APPROVAL_DENIED_PREFIX)) {
        return {
          ok: false,
          denied: true,
          error: message.replace(APPROVAL_DENIED_PREFIX, "").trim(),
        };
      }

      return {
        ok: false,
        error: message,
      };
    }
  },
});

export const runTask = internalAction({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const task = (await ctx.runQuery(internal.database.getTask, { taskId: args.taskId })) as TaskRecord | null;
    if (!task || task.status !== "queued") {
      return null;
    }

    if (task.runtimeId !== "local-bun") {
      const failed = await ctx.runMutation(internal.database.markTaskFinished, {
        taskId: args.taskId,
        status: "failed",
        stdout: "",
        stderr: "",
        error: `Runtime not found: ${task.runtimeId}`,
      });

      if (failed) {
        await publish(ctx, args.taskId, "task", "task.failed", {
          taskId: args.taskId,
          status: failed.status,
          error: failed.error,
        });
      }
      return null;
    }

    try {
      const running = (await ctx.runMutation(internal.database.markTaskRunning, {
        taskId: args.taskId,
      })) as TaskRecord | null;
      if (!running) {
        return null;
      }

      await publish(ctx, args.taskId, "task", "task.running", {
        taskId: args.taskId,
        status: running.status,
        startedAt: running.startedAt,
      });

      const adapter = new InProcessExecutionAdapter({
        runId: args.taskId,
        invokeTool: async (call) => await invokeTool(ctx, running, call),
        emitOutput: async (event) => {
          await ctx.runMutation(internal.executor.appendRuntimeOutput, {
            runId: event.runId,
            stream: event.stream,
            line: event.line,
            timestamp: event.timestamp,
          });
        },
      });

      const runtimeResult = await runCodeWithAdapter(
        {
          taskId: args.taskId,
          code: running.code,
          timeoutMs: running.timeoutMs,
        },
        adapter,
      );

      const finished = await ctx.runMutation(internal.database.markTaskFinished, {
        taskId: args.taskId,
        status: runtimeResult.status,
        stdout: runtimeResult.stdout,
        stderr: runtimeResult.stderr,
        exitCode: runtimeResult.exitCode,
        error: runtimeResult.error,
      });

      if (!finished) {
        return null;
      }

      const terminalEvent =
        runtimeResult.status === "completed"
          ? "task.completed"
          : runtimeResult.status === "timed_out"
            ? "task.timed_out"
            : runtimeResult.status === "denied"
              ? "task.denied"
              : "task.failed";

      await publish(ctx, args.taskId, "task", terminalEvent, {
        taskId: args.taskId,
        status: finished.status,
        exitCode: finished.exitCode,
        durationMs: runtimeResult.durationMs,
        error: finished.error,
        completedAt: finished.completedAt,
      });
    } catch (error) {
      const message = describeError(error);
      const denied = message.startsWith(APPROVAL_DENIED_PREFIX);
      const finished = await ctx.runMutation(internal.database.markTaskFinished, {
        taskId: args.taskId,
        status: denied ? "denied" : "failed",
        stdout: "",
        stderr: "",
        error: denied ? message.replace(APPROVAL_DENIED_PREFIX, "") : message,
      });

      if (finished) {
        await publish(ctx, args.taskId, "task", denied ? "task.denied" : "task.failed", {
          taskId: args.taskId,
          status: finished.status,
          error: finished.error,
          completedAt: finished.completedAt,
        });
      }
    }

    return null;
  },
});
