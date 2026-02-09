"use node";

import { v } from "convex/values";
import { ActionCache } from "@convex-dev/action-cache";
import { api, components, internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";
import { InProcessExecutionAdapter } from "./lib/adapters/in_process_execution_adapter";
import { APPROVAL_DENIED_PREFIX } from "./lib/execution_constants";
import { runCodeWithAdapter } from "./lib/runtimes/runtime_core";
import { createDiscoverTool } from "./lib/tool_discovery";
import {
  buildOpenApiToolsFromPrepared,
  loadExternalTools,
  parseGraphqlOperationPaths,
  prepareOpenApiSpec,
  type PreparedOpenApiSpec,
  type ExternalToolSourceConfig,
} from "./lib/tool_sources";
import { DEFAULT_TOOLS } from "./lib/tools";
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
  ToolSourceRecord,
  ToolRunContext,
} from "./lib/types";
import { asPayload, describeError } from "./lib/utils";

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
  const signatureVersion = "v2";
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
const workspaceToolCache = new Map<
  string,
  { signature: string; loadedAt: number; tools: Map<string, ToolDefinition>; warnings: string[] }
>();
const workspaceToolLoadsInFlight = new Map<
  string,
  {
    signature: string;
    promise: Promise<{ tools: Map<string, ToolDefinition>; warnings: string[] }>;
  }
>();
const OPENAPI_SPEC_CACHE_TTL_MS = 5 * 60 * 60_000;
const WORKSPACE_TOOL_CACHE_TTL_MS = 5 * 60 * 60_000;
const WORKSPACE_TOOL_CACHE_RETRY_TTL_MS = 5 * 60 * 60_000;

const actionCacheComponent = components as unknown as { actionCache: unknown };
const openApiSpecCache = new ActionCache(actionCacheComponent.actionCache as never, {
  action: internal.executorNode.prepareOpenApiSpecForCache,
  name: "openapi-spec-transform-v1",
  ttl: OPENAPI_SPEC_CACHE_TTL_MS,
});
const MAX_ACTION_CACHE_VALUE_BYTES = 900_000;
const OVERSIZED_OPENAPI_LOCAL_CACHE_TTL_MS = 5 * 60 * 60_000;
const oversizedOpenApiSpecCache = new Map<
  string,
  { loadedAt: number; prepared: PreparedOpenApiSpec }
>();

interface PreparedOpenApiSpecCacheValue {
  preparedJson: string;
  oversized?: boolean;
}

function isWorkspaceToolCacheFresh(
  cached: { signature: string; loadedAt: number; warnings: string[] },
  signature: string,
  now: number,
): boolean {
  if (cached.signature !== signature) {
    return false;
  }

  const ageMs = now - cached.loadedAt;
  const ttlMs = cached.warnings.length > 0
    ? WORKSPACE_TOOL_CACHE_RETRY_TTL_MS
    : WORKSPACE_TOOL_CACHE_TTL_MS;

  return ageMs < ttlMs;
}

async function publish(
  ctx: any,
  taskId: string,
  eventName: "task" | "approval",
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await ctx.runMutation(api.database.createTaskEvent, {
    taskId,
    eventName,
    type,
    payload,
  });
}

async function waitForApproval(ctx: any, approvalId: string): Promise<"approved" | "denied"> {
  while (true) {
    const approval = await ctx.runQuery(api.database.getApproval, { approvalId });
    if (!approval) {
      throw new Error(`Approval ${approvalId} not found`);
    }

    if (approval.status !== "pending") {
      return approval.status as "approved" | "denied";
    }

    await sleep(500);
  }
}

export const prepareOpenApiSpecForCache = internalAction({
  args: {
    specUrl: v.string(),
  },
  handler: async (_ctx, args): Promise<PreparedOpenApiSpecCacheValue> => {
    const prepared = await prepareOpenApiSpec(args.specUrl, args.specUrl);
    // Action cache values must be valid Convex values. Raw OpenAPI objects can
    // contain keys like "$ref", which Convex object fields disallow, so we
    // store the prepared payload as a JSON string.
    let preparedJson = JSON.stringify(prepared);

    if (preparedJson.length > MAX_ACTION_CACHE_VALUE_BYTES) {
      const reduced: PreparedOpenApiSpec = {
        servers: prepared.servers,
        paths: prepared.paths,
        warnings: [
          ...(prepared.warnings ?? []),
          "OpenAPI type metadata omitted due cache size limits.",
        ],
      };
      preparedJson = JSON.stringify(reduced);
    }

    if (preparedJson.length > MAX_ACTION_CACHE_VALUE_BYTES) {
      return { preparedJson: "", oversized: true };
    }

    return { preparedJson };
  },
});

async function loadSourceTools(
  ctx: any,
  source: ExternalToolSourceConfig,
): Promise<{ tools: ToolDefinition[]; warnings: string[] }> {
  const loadOpenApiDirect = async (extraWarnings: string[] = []) => {
    const specUrl = source.spec;
    const now = Date.now();
    const cached = oversizedOpenApiSpecCache.get(specUrl);
    const prepared = (cached && (now - cached.loadedAt) < OVERSIZED_OPENAPI_LOCAL_CACHE_TTL_MS)
      ? cached.prepared
      : await prepareOpenApiSpec(specUrl, source.name);

    if (!cached || (now - cached.loadedAt) >= OVERSIZED_OPENAPI_LOCAL_CACHE_TTL_MS) {
      oversizedOpenApiSpecCache.set(specUrl, { loadedAt: now, prepared });
    }

    const tools = buildOpenApiToolsFromPrepared(source, prepared);
    return {
      tools,
      warnings: [
        ...extraWarnings,
        ...(prepared.warnings ?? []).map((warning) => `Source '${source.name}': ${warning}`),
      ],
    };
  };

  if (source.type === "openapi" && typeof source.spec === "string") {
    try {
      const cached = await openApiSpecCache.fetch(ctx, { specUrl: source.spec }) as PreparedOpenApiSpecCacheValue;
      if (cached.oversized || !cached.preparedJson) {
        return await loadOpenApiDirect([
          `Source '${source.name}': OpenAPI metadata is too large for global cache; using direct load.`,
        ]);
      }
      const prepared = JSON.parse(cached.preparedJson) as PreparedOpenApiSpec;
      const tools = buildOpenApiToolsFromPrepared(source, prepared);
      const warnings = (prepared.warnings ?? []).map((warning) => `Source '${source.name}': ${warning}`);
      return { tools, warnings };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (/Value is too large/i.test(message)) {
        try {
          return await loadOpenApiDirect([
            `Source '${source.name}': OpenAPI metadata exceeded global cache limits; using direct load.`,
          ]);
        } catch (fallbackError) {
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          return {
            tools: [],
            warnings: [`Failed to load openapi source '${source.name}': ${fallbackMessage}`],
          };
        }
      }

      return {
        tools: [],
        warnings: [`Failed to load openapi source '${source.name}': ${message}`],
      };
    }
  }

  return await loadExternalTools([source]);
}

async function getWorkspaceTools(ctx: any, workspaceId: string): Promise<Map<string, ToolDefinition>> {
  const sources = (await ctx.runQuery(api.database.listToolSources, { workspaceId }))
    .filter((source: { enabled: boolean }) => source.enabled);
  const now = Date.now();
  const signature = sourceSignature(workspaceId, sources);
  const cached = workspaceToolCache.get(workspaceId);
  if (cached && isWorkspaceToolCacheFresh(cached, signature, now)) {
    return cached.tools;
  }

  const inFlight = workspaceToolLoadsInFlight.get(workspaceId);
  if (inFlight && inFlight.signature === signature) {
    const loaded = await inFlight.promise;
    return loaded.tools;
  }

  const loadPromise = (async () => {
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

    workspaceToolCache.set(workspaceId, {
      signature,
      loadedAt: Date.now(),
      tools: merged,
      warnings,
    });

    return { tools: merged, warnings };
  })();

  workspaceToolLoadsInFlight.set(workspaceId, { signature, promise: loadPromise });

  try {
    const loaded = await loadPromise;
    return loaded.tools;
  } finally {
    const current = workspaceToolLoadsInFlight.get(workspaceId);
    if (current?.promise === loadPromise) {
      workspaceToolLoadsInFlight.delete(workspaceId);
    }
  }
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
    schemaTypes: tool.metadata?.schemaTypes,
  };
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
  const record = await ctx.runQuery(api.database.resolveCredential, {
    workspaceId: task.workspaceId,
    sourceKey: spec.sourceKey,
    scope: spec.mode as CredentialScope,
    actorId: task.actorId,
  });

  const source = record?.secretJson ?? spec.staticSecretJson ?? null;
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
  const policies = await ctx.runQuery(api.database.listAccessPolicies, { workspaceId: task.workspaceId });
  const typedPolicies = policies as AccessPolicyRecord[];

  let workspaceTools: Map<string, ToolDefinition> | undefined;
  let tool = baseTools.get(toolPath);
  if (!tool) {
    workspaceTools = await getWorkspaceTools(ctx, task.workspaceId);
    tool = workspaceTools.get(toolPath);
  }

  if (!tool) {
    throw new Error(`Unknown tool: ${toolPath}`);
  }

  let decision: PolicyDecision;
  let effectiveToolPath = toolPath;
  if (tool._graphqlSource) {
    if (!workspaceTools) {
      workspaceTools = await getWorkspaceTools(ctx, task.workspaceId);
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
    const approval = await ctx.runMutation(api.database.createApproval, {
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
    workspaceId: v.optional(v.string()),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ToolDescriptor[]> => {
    if (!args.workspaceId) {
      return [...baseTools.values()].map((tool) => toToolDescriptor(tool, tool.approval));
    }

    const [workspaceTools, policies] = await Promise.all([
      getWorkspaceTools(ctx, args.workspaceId),
      ctx.runQuery(api.database.listAccessPolicies, { workspaceId: args.workspaceId }),
    ]);
    const typedPolicies = policies as AccessPolicyRecord[];

    return listVisibleToolDescriptors(
      workspaceTools,
      args as { workspaceId: string; actorId?: string; clientId?: string },
      typedPolicies,
    );
  },
});

export const listToolsWithWarnings = action({
  args: {
    workspaceId: v.optional(v.string()),
    actorId: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ tools: ToolDescriptor[]; warnings: string[] }> => {
    if (!args.workspaceId) {
      return {
        tools: [...baseTools.values()].map((tool) => toToolDescriptor(tool, tool.approval)),
        warnings: [],
      };
    }

    const [workspaceTools, policies] = await Promise.all([
      getWorkspaceTools(ctx, args.workspaceId),
      ctx.runQuery(api.database.listAccessPolicies, { workspaceId: args.workspaceId }),
    ]);
    const typedPolicies = policies as AccessPolicyRecord[];

    return {
      tools: listVisibleToolDescriptors(
        workspaceTools,
        args as { workspaceId: string; actorId?: string; clientId?: string },
        typedPolicies,
      ),
      warnings: workspaceToolCache.get(args.workspaceId)?.warnings ?? [],
    };
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
    const task = (await ctx.runQuery(api.database.getTask, {
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
    const task = (await ctx.runQuery(api.database.getTask, { taskId: args.taskId })) as TaskRecord | null;
    if (!task || task.status !== "queued") {
      return null;
    }

    if (task.runtimeId !== "local-bun") {
      const failed = await ctx.runMutation(api.database.markTaskFinished, {
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
      const running = (await ctx.runMutation(api.database.markTaskRunning, {
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

      const finished = await ctx.runMutation(api.database.markTaskFinished, {
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
      const finished = await ctx.runMutation(api.database.markTaskFinished, {
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
