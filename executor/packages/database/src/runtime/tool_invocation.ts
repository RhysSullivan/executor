import { z } from "zod";
import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import type {
  ToolPolicyRecord,
  PolicyDecision,
  ResolvedToolCredential,
  TaskRecord,
  ToolDefinition,
  ToolCallRecord,
  ToolCallRequest,
  ToolRunContext,
} from "../../../core/src/types";
import { executeSerializedTool, parseSerializedTool } from "../../../core/src/tool/source-serialization";
import {
  compactArgTypeHintFromSchema,
  compactReturnTypeHintFromSchema,
} from "../../../core/src/type-hints";
import { describeError } from "../../../core/src/utils";
import {
  decodeToolCallControlSignal,
  ToolCallControlError,
} from "../../../core/src/tool-call-control";
import { getToolDecision, getDecisionForContext } from "./policy";
import { baseTools } from "./base_tools";
import { publishTaskEvent } from "./events";
import { completeToolCall, denyToolCall, failToolCall } from "./tool_call_lifecycle";
import { resolveCredentialHeadersResult, validatePersistedCallRunnable } from "./tool_call_credentials";
import { getGraphqlDecision, resolveToolForCall } from "./tool_call_resolution";
import { getReadyRegistryBuildIdResult } from "./tool_registry_state";
import {
  catalogNamespaceSchema,
  catalogNamespacesInputSchema,
  catalogNamespacesOutputSchema,
  catalogToolsInputSchema,
  catalogToolsOutputSchema,
  type CatalogNamespace,
  type DiscoveryTypingPayload,
  discoverInputSchema,
  discoverOutputSchema,
  toolApprovalSchema,
} from "./discovery_tool_contracts";
import { isStorageSystemToolPath, runStorageSystemTool } from "./storage_tools";

const payloadRecordSchema = z.record(z.unknown());

function createApprovalId(): string {
  return `approval_${crypto.randomUUID()}`;
}

const registryToolEntrySchema = z.object({
  path: z.string(),
  preferredPath: z.string().optional(),
  source: z.string().optional(),
  approval: toolApprovalSchema,
  description: z.string().optional(),
  displayInput: z.string().optional(),
  displayOutput: z.string().optional(),
  typedRef: z.object({
    kind: z.literal("openapi_operation"),
    sourceKey: z.string(),
    operationId: z.string(),
  }).optional(),
  serializedToolJson: z.string().optional(),
});

type RegistryToolEntry = z.infer<typeof registryToolEntrySchema>;

const registryToolPayloadEntrySchema = z.object({
  path: z.string(),
  serializedToolJson: z.string(),
});

const openApiRefHintTablesSchema = z.array(z.object({
  sourceKey: z.string(),
  refs: z.array(z.object({ key: z.string(), hint: z.string() })),
}));

function toSchemaJson(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function buildOpenApiRefHintLookup(value: unknown): Record<string, Record<string, string>> {
  const parsed = openApiRefHintTablesSchema.safeParse(value);
  if (!parsed.success) return {};

  const lookup: Record<string, Record<string, string>> = {};
  for (const table of parsed.data) {
    const refs: Record<string, string> = {};
    for (const entry of table.refs) {
      const key = entry.key.trim();
      const hint = entry.hint.trim();
      if (!key || !hint) continue;
      refs[key] = hint;
    }
    if (Object.keys(refs).length > 0) {
      lookup[table.sourceKey] = refs;
    }
  }

  return lookup;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0))];
}

function resolveEntryDiscoveryTyping(
  entry: RegistryToolEntry,
  refHintLookup: Record<string, Record<string, string>>,
): { typing: DiscoveryTypingPayload; refHints?: Record<string, string> } {
  if (!entry.serializedToolJson) {
    return { typing: {} };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(entry.serializedToolJson);
  } catch {
    return { typing: {} };
  }

  const serializedTool = parseSerializedTool(parsedJson);
  if (serializedTool.isErr()) {
    return { typing: {} };
  }

  const typing = serializedTool.value.typing;
  const refHintKeys = toStringArray(typing?.refHintKeys);
  const inputSchemaJson = toSchemaJson((typing as { inputSchema?: unknown } | undefined)?.inputSchema);
  const outputSchemaJson = toSchemaJson((typing as { outputSchema?: unknown } | undefined)?.outputSchema);

  const discoveryTyping: DiscoveryTypingPayload = {
    ...(inputSchemaJson ? { inputSchemaJson } : {}),
    ...(outputSchemaJson ? { outputSchemaJson } : {}),
    ...(refHintKeys.length > 0 ? { refHintKeys } : {}),
  };

  if (refHintKeys.length === 0) {
    return { typing: discoveryTyping };
  }

  const sourceKey = serializedTool.value.typing?.typedRef?.kind === "openapi_operation"
    ? serializedTool.value.typing.typedRef.sourceKey
    : entry.typedRef?.sourceKey;
  if (!sourceKey) {
    return { typing: discoveryTyping };
  }

  const table = refHintLookup[sourceKey];
  if (!table) {
    return { typing: discoveryTyping };
  }

  const refHints: Record<string, string> = {};
  for (const key of refHintKeys) {
    const hint = table[key];
    if (typeof hint === "string" && hint.length > 0) {
      refHints[key] = hint;
    }
  }

  if (Object.keys(refHints).length > 0) {
    return { typing: discoveryTyping, refHints };
  }

  return { typing: discoveryTyping };
}

function mergeRefHintsIntoTable(target: Record<string, string>, refHints: Record<string, string>): void {
  for (const [key, value] of Object.entries(refHints)) {
    if (!target[key]) {
      target[key] = value;
    }
  }
}

function toInputPayload(value: unknown): Record<string, unknown> {
  const parsed = payloadRecordSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  return value === undefined ? {} : { value };
}

async function upsertRequestedToolCall(
  ctx: ActionCtx,
  args: { taskId: string; callId: string; workspaceId: TaskRecord["workspaceId"]; toolPath: string },
): Promise<ToolCallRecord> {
  const persistedCall = await ctx.runMutation(internal.database.upsertToolCallRequested, args);
  return persistedCall;
}

async function listWorkspaceToolPolicies(
  ctx: ActionCtx,
  task: Pick<TaskRecord, "workspaceId" | "accountId">,
): Promise<ToolPolicyRecord[]> {
  const policies = await ctx.runQuery(internal.database.listToolPolicies, {
    workspaceId: task.workspaceId,
    accountId: task.accountId,
  });
  return policies as ToolPolicyRecord[];
}

async function listRegistryNamespaces(
  ctx: ActionCtx,
  args: { workspaceId: TaskRecord["workspaceId"]; buildId: string; limit: number },
): Promise<CatalogNamespace[]> {
  const namespaces = await ctx.runQuery(internal.toolRegistry.listNamespaces, args);
  const parsed = z.array(catalogNamespaceSchema).safeParse(namespaces);
  return parsed.success ? parsed.data : [];
}

function toolNamespace(path: string): string {
  const normalized = path.trim().toLowerCase();
  if (!normalized) return "default";
  const [head] = normalized.split(".");
  return head && head.length > 0 ? head : "default";
}

function matchesToolQuery(
  query: string,
  args: { path: string; description?: string; source?: string },
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  const haystack = `${args.path} ${args.description ?? ""} ${args.source ?? ""}`.toLowerCase();
  return normalizedQuery
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .every((token) => haystack.includes(token));
}

function getToolHints(tool: ToolDefinition): { inputHint: string; outputHint: string } {
  const hintedInput = typeof tool.typing?.inputHint === "string" ? tool.typing.inputHint.trim() : "";
  const hintedOutput = typeof tool.typing?.outputHint === "string" ? tool.typing.outputHint.trim() : "";

  const inputHint = hintedInput.length > 0
    ? hintedInput
    : compactArgTypeHintFromSchema(tool.typing?.inputSchema ?? {});
  const outputHint = hintedOutput.length > 0
    ? hintedOutput
    : compactReturnTypeHintFromSchema(tool.typing?.outputSchema ?? {});

  return {
    inputHint: inputHint.trim().length > 0 ? inputHint : "{}",
    outputHint: outputHint.trim().length > 0 ? outputHint : "unknown",
  };
}

function toBaseDiscoveryTyping(tool: ToolDefinition): DiscoveryTypingPayload {
  const inputSchemaJson = toSchemaJson(tool.typing?.inputSchema);
  const outputSchemaJson = toSchemaJson(tool.typing?.outputSchema);
  return {
    ...(inputSchemaJson ? { inputSchemaJson } : {}),
    ...(outputSchemaJson ? { outputSchemaJson } : {}),
  };
}

async function searchRegistryTools(
  ctx: ActionCtx,
  args: {
    workspaceId: TaskRecord["workspaceId"];
    buildId: string;
    query: string;
    limit: number;
    includeSchemas?: boolean;
  },
): Promise<RegistryToolEntry[]> {
  const entries = await ctx.runQuery(internal.toolRegistry.searchTools, {
    workspaceId: args.workspaceId,
    buildId: args.buildId,
    query: args.query,
    limit: args.limit,
  });
  const parsed = z.array(registryToolEntrySchema).safeParse(entries);
  if (!parsed.success) return [];
  if (!args.includeSchemas) return parsed.data;

  const payloads = await ctx.runQuery(internal.toolRegistry.getSerializedToolsByPaths, {
    workspaceId: args.workspaceId,
    buildId: args.buildId,
    paths: parsed.data.map((entry) => entry.path),
  });
  const parsedPayloads = z.array(registryToolPayloadEntrySchema).safeParse(payloads);
  const payloadByPath = new Map<string, string>(
    parsedPayloads.success
      ? parsedPayloads.data.map((payload) => [payload.path, payload.serializedToolJson])
      : [],
  );

  return parsed.data.map((entry) => ({
    ...entry,
    serializedToolJson: payloadByPath.get(entry.path),
  }));
}

async function listRegistryToolsByNamespace(
  ctx: ActionCtx,
  args: {
    workspaceId: TaskRecord["workspaceId"];
    buildId: string;
    namespace: string;
    limit: number;
    includeSchemas?: boolean;
  },
): Promise<RegistryToolEntry[]> {
  const entries = await ctx.runQuery(internal.toolRegistry.listToolsByNamespace, {
    workspaceId: args.workspaceId,
    buildId: args.buildId,
    namespace: args.namespace,
    limit: args.limit,
  });
  const parsed = z.array(registryToolEntrySchema).safeParse(entries);
  if (!parsed.success) return [];
  if (!args.includeSchemas) return parsed.data;

  const payloads = await ctx.runQuery(internal.toolRegistry.getSerializedToolsByPaths, {
    workspaceId: args.workspaceId,
    buildId: args.buildId,
    paths: parsed.data.map((entry) => entry.path),
  });
  const parsedPayloads = z.array(registryToolPayloadEntrySchema).safeParse(payloads);
  const payloadByPath = new Map<string, string>(
    parsedPayloads.success
      ? parsedPayloads.data.map((payload) => [payload.path, payload.serializedToolJson])
      : [],
  );

  return parsed.data.map((entry) => ({
    ...entry,
    serializedToolJson: payloadByPath.get(entry.path),
  }));
}

async function denyToolCallForApproval(
  ctx: ActionCtx,
  args: {
    task: TaskRecord;
    callId: string;
    toolPath: string;
    approvalId: string;
  },
): Promise<never> {
  const deniedMessage = `${args.toolPath} (${args.approvalId})`;
  return denyToolCall(ctx, {
    task: args.task,
    callId: args.callId,
    toolPath: args.toolPath,
    deniedMessage,
    approvalId: args.approvalId,
  });
}

export async function enforceToolApproval(
  ctx: ActionCtx,
  args: {
    task: TaskRecord;
    callId: string;
    toolPath: string;
    input: unknown;
    requireApproval: boolean;
    existingApprovalId?: string;
  },
): Promise<void> {
  let approvalSatisfied = false;
  if (args.existingApprovalId) {
    const existingApproval = await ctx.runQuery(internal.database.getApproval, {
      approvalId: args.existingApprovalId,
    });
    if (!existingApproval) {
      throw new Error(`Approval ${args.existingApprovalId} not found for call ${args.callId}`);
    }

    if (existingApproval.status === "pending") {
      throw new ToolCallControlError({
        kind: "approval_pending",
        approvalId: existingApproval.id,
      });
    }

    if (existingApproval.status === "denied") {
      await denyToolCallForApproval(ctx, {
        task: args.task,
        callId: args.callId,
        toolPath: args.toolPath,
        approvalId: existingApproval.id,
      });
    }

    approvalSatisfied = existingApproval.status === "approved";
  }

  if (!args.requireApproval || approvalSatisfied) {
    return;
  }

  const approvalId = args.existingApprovalId ?? createApprovalId();
  let approval = await ctx.runQuery(internal.database.getApproval, {
    approvalId,
  });

  if (!approval) {
    approval = await ctx.runMutation(internal.database.createApproval, {
      id: approvalId,
      taskId: args.task.id,
      toolPath: args.toolPath,
      input: toInputPayload(args.input),
    });

    await publishTaskEvent(ctx, args.task.id, "approval", "approval.requested", {
      approvalId: approval.id,
      taskId: args.task.id,
      callId: args.callId,
      toolPath: approval.toolPath,
      input: toInputPayload(approval.input),
      createdAt: approval.createdAt,
    });
  }

  await ctx.runMutation(internal.database.setToolCallPendingApproval, {
    taskId: args.task.id,
    callId: args.callId,
    approvalId: approval.id,
  });

  if (approval.status === "pending") {
    throw new ToolCallControlError({
      kind: "approval_pending",
      approvalId: approval.id,
    });
  }

  if (approval.status === "denied") {
    await denyToolCallForApproval(ctx, {
      task: args.task,
      callId: args.callId,
      toolPath: args.toolPath,
      approvalId: approval.id,
    });
  }
}

export async function invokeTool(ctx: ActionCtx, task: TaskRecord, call: ToolCallRequest): Promise<unknown> {
  const { toolPath, input, callId } = call;
  const persistedCall = await upsertRequestedToolCall(ctx, {
    taskId: task.id,
    callId,
    workspaceId: task.workspaceId,
    toolPath,
  });
  const runnable = validatePersistedCallRunnable(persistedCall, callId);
  if (runnable.isErr()) {
    throw runnable.error;
  }

  let effectiveToolPath = toolPath;
  try {
    const typedPolicies = await listWorkspaceToolPolicies(ctx, task);
    const finalizeImmediateTool = async (value: unknown): Promise<unknown> => {
      if (persistedCall.status === "requested") {
        await publishTaskEvent(ctx, task.id, "task", "tool.call.started", {
          taskId: task.id,
          callId,
          toolPath,
          approval: "auto",
        });
      }
      await completeToolCall(ctx, {
        taskId: task.id,
        callId,
        toolPath,
      });
      return value;
    };

    // Fast system tools are handled server-side from the registry.
    if (toolPath === "discover" || toolPath === "catalog.namespaces" || toolPath === "catalog.tools" || isStorageSystemToolPath(toolPath)) {
      const baseSystemTool = baseTools.get(toolPath);
      const systemToolDecision = getDecisionForContext(
        {
          path: toolPath,
          approval: baseSystemTool?.approval ?? "auto",
        },
        {
          workspaceId: task.workspaceId,
          accountId: task.accountId,
          clientId: task.clientId,
        },
        typedPolicies,
      );
      if (systemToolDecision === "deny") {
        const deniedMessage = `${toolPath} (policy denied)`;
        await denyToolCall(ctx, {
          task,
          callId,
          toolPath,
          deniedMessage,
          reason: "policy_deny",
        });
      }

      if (isStorageSystemToolPath(toolPath)) {
        if (persistedCall.status === "requested") {
          await publishTaskEvent(ctx, task.id, "task", "tool.call.started", {
            taskId: task.id,
            callId,
            toolPath,
            approval: systemToolDecision === "require_approval" ? "required" : "auto",
          });
        }

        await enforceToolApproval(ctx, {
          task,
          callId,
          toolPath,
          input,
          requireApproval: systemToolDecision === "require_approval",
          existingApprovalId: persistedCall.approvalId,
        });

        const output = await runStorageSystemTool(ctx, task, toolPath, input);
        await completeToolCall(ctx, {
          taskId: task.id,
          callId,
          toolPath,
        });
        return output;
      }

      const buildIdResult = await getReadyRegistryBuildIdResult(ctx, {
        workspaceId: task.workspaceId,
        accountId: task.accountId,
        clientId: task.clientId,
      });
      const buildId = buildIdResult.isErr() ? undefined : buildIdResult.value;
      const state = buildId
        ? await ctx.runQuery(internal.toolRegistry.getState, {
            workspaceId: task.workspaceId,
          }) as unknown as { openApiRefHintTables?: unknown } | null
        : null;
      const refHintLookup = buildOpenApiRefHintLookup(state?.openApiRefHintTables);

      const payload = typeof input === "string"
        ? { query: input }
        : toInputPayload(input);
      const isAllowed = (path: string, approval: ToolDefinition["approval"], source?: string) => {
        const policyProbeTool: ToolDefinition = {
          path,
          approval,
          source,
          description: "",
          run: async () => null,
        };
        return getDecisionForContext(
          policyProbeTool,
          { workspaceId: task.workspaceId, accountId: task.accountId, clientId: task.clientId },
          typedPolicies,
        ) !== "deny";
      };

      const normalizeHint = (value: unknown, fallback: string) => {
        const str = typeof value === "string" ? value.trim() : "";
        return str.length > 0 ? str : fallback;
      };

      if (toolPath === "catalog.namespaces") {
        const parsedInput = catalogNamespacesInputSchema.safeParse(payload);
        const limitInput = parsedInput.success ? parsedInput.data.limit : undefined;
        const limit = Math.max(1, Math.min(200, Number(limitInput ?? 200)));
        const registryNamespaces = buildId
          ? await listRegistryNamespaces(ctx, {
              workspaceId: task.workspaceId,
              buildId,
              limit: 200,
            })
          : [];

        const namespaceMap = new Map<string, { toolCount: number; samplePaths: string[] }>();
        for (const entry of registryNamespaces) {
          namespaceMap.set(entry.namespace, {
            toolCount: entry.toolCount,
            samplePaths: [...entry.samplePaths],
          });
        }

        for (const baseTool of baseTools.values()) {
          if (!isAllowed(baseTool.path, baseTool.approval, baseTool.source)) {
            continue;
          }

          const namespace = toolNamespace(baseTool.path);
          const current = namespaceMap.get(namespace) ?? { toolCount: 0, samplePaths: [] };
          current.toolCount += 1;
          if (!current.samplePaths.includes(baseTool.path)) {
            current.samplePaths.push(baseTool.path);
          }
          namespaceMap.set(namespace, current);
        }

        const namespaces = [...namespaceMap.entries()]
          .map(([namespace, meta]) => ({
            namespace,
            toolCount: meta.toolCount,
            samplePaths: [...meta.samplePaths].sort((a, b) => a.localeCompare(b)).slice(0, 3),
          }))
          .sort((a, b) => a.namespace.localeCompare(b.namespace))
          .slice(0, limit);

        const output = catalogNamespacesOutputSchema.parse({
          namespaces,
          total: namespaces.length,
        });
        return await finalizeImmediateTool(output);
      }

      if (toolPath === "catalog.tools") {
        const parsedInput = catalogToolsInputSchema.safeParse(payload);
        const namespace = (parsedInput.success ? (parsedInput.data.namespace ?? "") : "").trim().toLowerCase();
        const query = (parsedInput.success ? (parsedInput.data.query ?? "") : "").trim();
        const limitInput = parsedInput.success ? parsedInput.data.limit : undefined;
        const limit = Math.max(1, Math.min(200, Number(limitInput ?? 50)));
        const includeSchemas = parsedInput.success ? (parsedInput.data.includeSchemas ?? false) : false;

        const raw = !buildId
          ? []
          : query
            ? await searchRegistryTools(ctx, {
                workspaceId: task.workspaceId,
                buildId,
                query,
                limit,
                includeSchemas,
              })
            : namespace
              ? await listRegistryToolsByNamespace(ctx, {
                  workspaceId: task.workspaceId,
                  buildId,
                  namespace,
                  limit,
                  includeSchemas,
                })
              : [];

        const baseMatches = [...baseTools.values()]
          .filter((baseTool) => {
            if (namespace && toolNamespace(baseTool.path) !== namespace) {
              return false;
            }
            if (query && !matchesToolQuery(query, {
              path: baseTool.path,
              description: baseTool.description,
              source: baseTool.source,
            })) {
              return false;
            }

            return isAllowed(baseTool.path, baseTool.approval, baseTool.source);
          })
          .sort((left, right) => left.path.localeCompare(right.path));

        const refHintTable: Record<string, string> = {};
        const registryResults = raw
          .filter((entry) => !namespace || String(entry.preferredPath ?? entry.path ?? "").toLowerCase().startsWith(`${namespace}.`))
          .filter((entry) => isAllowed(entry.path, entry.approval, entry.source))
          .map((entry) => {
            const preferredPath = entry.preferredPath ?? entry.path;
            const discoveryTyping = resolveEntryDiscoveryTyping(entry, refHintLookup);
            if (discoveryTyping.refHints) {
              mergeRefHintsIntoTable(refHintTable, discoveryTyping.refHints);
            }
            const inputHint = normalizeHint(entry.displayInput, "{}");
            const outputHint = normalizeHint(entry.displayOutput, "unknown");
            return {
              path: preferredPath,
              source: entry.source,
              approval: entry.approval,
              description: entry.description,
              ...(includeSchemas
                ? (Object.keys(discoveryTyping.typing).length > 0 ? { typing: discoveryTyping.typing } : {})
                : {
                    inputHint,
                    outputHint,
                  }),
            };
          });

        const baseResults = baseMatches.map((entry) => {
          const hints = getToolHints(entry);
          const typing = toBaseDiscoveryTyping(entry);
          return {
            path: entry.path,
            source: entry.source,
            approval: entry.approval,
            description: entry.description,
            ...(includeSchemas
              ? (Object.keys(typing).length > 0 ? { typing } : {})
              : {
                  inputHint: hints.inputHint,
                  outputHint: hints.outputHint,
                }),
          };
        });

        const mergedByPath = new Map<string, (typeof registryResults)[number]>();
        for (const entry of baseResults) {
          mergedByPath.set(entry.path, entry);
        }
        for (const entry of registryResults) {
          if (!mergedByPath.has(entry.path)) {
            mergedByPath.set(entry.path, entry);
          }
        }
        const results = [...mergedByPath.values()].slice(0, limit);

        const output = catalogToolsOutputSchema.parse({
          ...(Object.keys(refHintTable).length > 0 ? { refHintTable } : {}),
          results,
          total: results.length,
        });
        return await finalizeImmediateTool(output);
      }

      // discover
      const parsedInput = discoverInputSchema.safeParse(payload);
      const query = (parsedInput.success ? (parsedInput.data.query ?? "") : "").trim();
      const limitInput = parsedInput.success ? parsedInput.data.limit : undefined;
      const limit = Math.max(1, Math.min(50, Number(limitInput ?? 8)));
      const compact = parsedInput.success ? (parsedInput.data.compact ?? true) : true;
      const includeSchemas = parsedInput.success ? (parsedInput.data.includeSchemas ?? false) : false;
      const hits = buildId
        ? await searchRegistryTools(ctx, {
            workspaceId: task.workspaceId,
            buildId,
            query,
            limit: Math.max(limit * 2, limit),
            includeSchemas,
          })
        : [];

      const baseHits = [...baseTools.values()]
        .filter((baseTool) => matchesToolQuery(query, {
          path: baseTool.path,
          description: baseTool.description,
          source: baseTool.source,
        }))
        .filter((baseTool) => isAllowed(baseTool.path, baseTool.approval, baseTool.source))
        .sort((left, right) => left.path.localeCompare(right.path));

      const filtered = hits
        .filter((entry) => isAllowed(entry.path, entry.approval, entry.source))
        .slice(0, Math.max(limit * 2, limit));

      const refHintTable: Record<string, string> = {};
      const registryResults = filtered.map((entry) => {
        const preferredPath = entry.preferredPath ?? entry.path;
        const description = compact ? String(entry.description ?? "").split("\n")[0] : entry.description;
        const discoveryTyping = resolveEntryDiscoveryTyping(entry, refHintLookup);
        if (discoveryTyping.refHints) {
          mergeRefHintsIntoTable(refHintTable, discoveryTyping.refHints);
        }
        const inputHint = normalizeHint(entry.displayInput, "{}");
        const outputHint = normalizeHint(entry.displayOutput, "unknown");
        return {
          path: preferredPath,
          source: entry.source,
          approval: entry.approval,
          description,
          ...(includeSchemas
            ? (Object.keys(discoveryTyping.typing).length > 0 ? { typing: discoveryTyping.typing } : {})
            : {
                inputHint,
                outputHint,
              }),
        };
      });

      const baseResults = baseHits.map((entry) => {
        const hints = getToolHints(entry);
        const typing = toBaseDiscoveryTyping(entry);
        return {
          path: entry.path,
          source: entry.source,
          approval: entry.approval,
          description: compact ? String(entry.description ?? "").split("\n")[0] : entry.description,
          ...(includeSchemas
            ? (Object.keys(typing).length > 0 ? { typing } : {})
            : {
                inputHint: hints.inputHint,
                outputHint: hints.outputHint,
              }),
        };
      });

      const mergedByPath = new Map<string, (typeof registryResults)[number]>();
      for (const entry of baseResults) {
        mergedByPath.set(entry.path, entry);
      }
      for (const entry of registryResults) {
        if (!mergedByPath.has(entry.path)) {
          mergedByPath.set(entry.path, entry);
        }
      }
      const results = [...mergedByPath.values()].slice(0, limit);

      const bestPath = results[0]?.path ?? null;
      const output = discoverOutputSchema.parse({
        bestPath,
        ...(Object.keys(refHintTable).length > 0 ? { refHintTable } : {}),
        results,
        total: results.length,
      });
      return await finalizeImmediateTool(output);
    }

    const resolvedToolResult = await resolveToolForCall(ctx, task, toolPath);
    if (resolvedToolResult.isErr()) {
      throw resolvedToolResult.error;
    }
    const resolvedTool = resolvedToolResult.value;
    const { resolvedToolPath } = resolvedTool;
    const tool = resolvedTool.tool;
    const toolForPolicy = {
      path: tool.path,
      approval: tool.approval,
      source: tool.source,
      _graphqlSource: tool._graphqlSource,
    };

    let decision: PolicyDecision;
    effectiveToolPath = resolvedToolPath;
    if (toolForPolicy._graphqlSource) {
      const result = getGraphqlDecision(task, toolForPolicy, input, undefined, typedPolicies);
      decision = result.decision;
      if (result.effectivePaths.length > 0) {
        effectiveToolPath = result.effectivePaths.join(", ");
      }
    } else {
      const inputRecord = typeof input === "object" && input !== null && !Array.isArray(input)
        ? input as Record<string, unknown>
        : undefined;
      decision = getToolDecision(task, toolForPolicy, typedPolicies, inputRecord);
    }

    const publishToolStarted = persistedCall.status === "requested";

    if (decision === "deny") {
      const deniedMessage = `${effectiveToolPath} (policy denied)`;
      await denyToolCall(ctx, {
        task,
        callId,
        toolPath: effectiveToolPath,
        deniedMessage,
        reason: "policy_deny",
      });
    }

    let credential: ResolvedToolCredential | undefined;
    if (tool.credential) {
      const credentialResult = await resolveCredentialHeadersResult(ctx, tool.credential, task);
      if (credentialResult.isErr()) {
        throw credentialResult.error;
      }

      const resolved = credentialResult.value;
      if (!resolved) {
        throw new Error(`Missing credential for source '${tool.credential.sourceKey}' (${tool.credential.mode} scope)`);
      }
      credential = resolved;
    }

    if (publishToolStarted) {
      await publishTaskEvent(ctx, task.id, "task", "tool.call.started", {
        taskId: task.id,
        callId,
        toolPath: effectiveToolPath,
        approval: decision === "require_approval" ? "required" : "auto",
      });
    }

    await enforceToolApproval(ctx, {
      task,
      callId,
      toolPath: effectiveToolPath,
      input,
      requireApproval: decision === "require_approval",
      existingApprovalId: persistedCall.approvalId,
    });

    const context: ToolRunContext = {
      taskId: task.id,
      workspaceId: task.workspaceId,
      accountId: task.accountId,
      clientId: task.clientId,
      credential,
      // Tool visibility is enforced server-side; runtime tool implementations don't use this.
      isToolAllowed: (_path) => true,
    };
    const value = resolvedTool.kind === "builtin"
      ? await resolvedTool.tool.run(input, context)
      : await executeSerializedTool(resolvedTool.tool, input, context, baseTools);
    await completeToolCall(ctx, {
      taskId: task.id,
      callId,
      toolPath: effectiveToolPath,
    });
    return value;
  } catch (error) {
    const message = describeError(error);
    const controlSignal = decodeToolCallControlSignal(error);

    if (!controlSignal) {
      await failToolCall(ctx, {
        taskId: task.id,
        callId,
        error: message,
        toolPath: effectiveToolPath,
      });
    }

    throw error;
  }
}
