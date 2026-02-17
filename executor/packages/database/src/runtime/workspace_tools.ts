import { z } from "zod";
import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel.d.ts";
import { buildWorkspaceTypeBundle } from "../../../core/src/tool-typing/typebundle";
import { jsonSchemaTypeHintFallback } from "../../../core/src/openapi/schema-hints";
import { buildPreviewKeys, extractTopLevelRequiredKeys } from "../../../core/src/tool-typing/schema-utils";
import {
  materializeCompiledToolSource,
  type CompiledToolSourceArtifact,
} from "./tool_source_artifact";
import { parseSerializedTool, type SerializedTool } from "../../../core/src/tool/source-serialization";
import type { ExternalToolSourceConfig } from "../../../core/src/tool/source-types";
import type {
  AccessPolicyRecord,
  JsonSchema,
  OpenApiSourceQuality,
  SourceAuthProfile,
  ToolDefinition,
  ToolDescriptor,
  ToolSourceRecord,
} from "../../../core/src/types";
import { listVisibleToolDescriptors } from "./tool_descriptors";
import { loadSourceArtifact, normalizeExternalToolSource } from "./tool_source_loading";
import { registrySignatureForWorkspace } from "./tool_registry_state";
import { normalizeToolPathForLookup } from "./tool_paths";
import { getDecisionForContext } from "./policy";
import { baseTools } from "./base_tools";

const toolHintSchema = z.object({
  inputHint: z.string().optional(),
  outputHint: z.string().optional(),
  requiredInputKeys: z.array(z.string()).optional(),
  previewInputKeys: z.array(z.string()).optional(),
});

const payloadRecordSchema = z.record(z.unknown());

function toJsonSchema(value: unknown): JsonSchema {
  const parsed = payloadRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

async function listWorkspaceToolSources(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
): Promise<ToolSourceRecord[]> {
  const sources: ToolSourceRecord[] = await ctx.runQuery(internal.database.listToolSources, { workspaceId });
  return sources;
}

async function listWorkspaceAccessPolicies(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  accountId?: Id<"accounts">,
): Promise<AccessPolicyRecord[]> {
  const policies: AccessPolicyRecord[] = await ctx.runQuery(internal.database.listAccessPolicies, { workspaceId, accountId });
  return policies;
}

interface WorkspaceToolsResult {
  tools: Map<string, ToolDefinition>;
  warnings: string[];
  typesStorageId?: Id<"_storage">;
  timedOutSources: string[];
}

export type ToolInventoryState = "initializing" | "ready" | "rebuilding" | "stale" | "failed";

export interface ToolInventoryStatus {
  state: ToolInventoryState;
  readyBuildId?: string;
  buildingBuildId?: string;
  readyToolCount: number;
  loadingSourceNames: string[];
  sourceToolCounts: Record<string, number>;
  lastBuildStartedAt?: number;
  lastBuildCompletedAt?: number;
  lastBuildFailedAt?: number;
  error?: string;
  updatedAt?: number;
}

interface GetWorkspaceToolsOptions {
  sourceTimeoutMs?: number;
  accountId?: Id<"accounts">;
}

interface WorkspaceToolInventory {
  tools: ToolDescriptor[];
  warnings: string[];
  typesUrl?: string;
  sourceQuality: Record<string, OpenApiSourceQuality>;
  sourceAuthProfiles: Record<string, SourceAuthProfile>;
  inventoryStatus: ToolInventoryStatus;
  nextCursor?: string | null;
  totalTools: number;
}

const MAX_TOOLS_IN_ACTION_RESULT = 8_000;

function truncateToolsForActionResult(
  tools: ToolDescriptor[],
  warnings: string[],
): { tools: ToolDescriptor[]; warnings: string[] } {
  if (tools.length <= MAX_TOOLS_IN_ACTION_RESULT) {
    return { tools, warnings };
  }

  return {
    tools: tools.slice(0, MAX_TOOLS_IN_ACTION_RESULT),
    warnings: [
      ...warnings,
      `Tool inventory truncated to ${MAX_TOOLS_IN_ACTION_RESULT} of ${tools.length} tools (Convex array limit). Use source filters or targeted lookups to narrow results.`,
    ],
  };
}

interface RegistryToolEntry {
  path: string;
  preferredPath: string;
  aliases: string[];
  description: string;
  approval: "auto" | "required";
  source?: string;
  displayInput?: string;
  displayOutput?: string;
  requiredInputKeys?: string[];
  previewInputKeys?: string[];
  serializedToolJson?: string;
  typedRef?: {
    kind: "openapi_operation";
    sourceKey: string;
    operationId: string;
  };
}

function toOpenApiRefHintLookup(
  items: Array<{
    sourceKey: string;
    refs: Array<{ key: string; hint: string }>;
  }>,
): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};

  for (const item of items) {
    const sourceKey = item.sourceKey.trim();
    if (!sourceKey) continue;

    const refs: Record<string, string> = {};
    for (const ref of item.refs) {
      const key = ref.key.trim();
      const hint = ref.hint.trim();
      if (!key || !hint) continue;
      refs[key] = hint;
    }

    if (Object.keys(refs).length > 0) {
      result[sourceKey] = refs;
    }
  }

  return result;
}

function resolveDescriptorRefHints(
  entry: RegistryToolEntry,
  openApiRefHintLookup: Record<string, Record<string, string>>,
): { refHintKeys: string[]; refHints: Record<string, string> } {
  if (!entry.serializedToolJson || Object.keys(openApiRefHintLookup).length === 0) {
    return { refHintKeys: [], refHints: {} };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(entry.serializedToolJson);
  } catch {
    return { refHintKeys: [], refHints: {} };
  }

  const parsedSerializedTool = parseSerializedTool(parsedJson);
  if (parsedSerializedTool.isErr()) {
    return { refHintKeys: [], refHints: {} };
  }

  const serializedTool = parsedSerializedTool.value;
  const refHintKeys = Array.isArray(serializedTool.typing?.refHintKeys)
    ? [...new Set(serializedTool.typing.refHintKeys
      .map((key) => key.trim())
      .filter((key) => key.length > 0))]
    : [];
  if (refHintKeys.length === 0) {
    return { refHintKeys: [], refHints: {} };
  }

  const sourceKey = serializedTool.typing?.typedRef?.kind === "openapi_operation"
    ? serializedTool.typing.typedRef.sourceKey
    : entry.typedRef?.sourceKey;
  if (!sourceKey) {
    return { refHintKeys, refHints: {} };
  }

  const table = openApiRefHintLookup[sourceKey];
  if (!table) {
    return { refHintKeys, refHints: {} };
  }

  const refHints: Record<string, string> = {};
  for (const key of refHintKeys) {
    const hint = table[key];
    if (typeof hint === "string" && hint.length > 0) {
      refHints[key] = hint;
    }
  }

  return { refHintKeys, refHints };
}

function toSourceName(source?: string): string | null {
  if (!source) return null;
  const index = source.indexOf(":");
  if (index < 0) return source;
  const name = source.slice(index + 1).trim();
  return name.length > 0 ? name : null;
}

function toDescriptorFromRegistryEntry(
  entry: RegistryToolEntry,
  options: { includeDetails?: boolean; openApiRefHintLookup?: Record<string, Record<string, string>> } = {},
): ToolDescriptor {
  const includeDetails = options.includeDetails ?? true;
  const openApiRefHintLookup = options.openApiRefHintLookup ?? {};
  const refHintResolution = includeDetails
    ? resolveDescriptorRefHints(entry, openApiRefHintLookup)
    : { refHintKeys: [], refHints: {} };

  return {
    path: entry.path,
    description: includeDetails ? entry.description : "",
    approval: entry.approval,
    source: entry.source,
    ...(includeDetails
      ? {
          typing: {
            requiredInputKeys: entry.requiredInputKeys,
            previewInputKeys: entry.previewInputKeys,
            ...(refHintResolution.refHintKeys.length > 0 ? { refHintKeys: refHintResolution.refHintKeys } : {}),
            ...(Object.keys(refHintResolution.refHints).length > 0 ? { refHints: refHintResolution.refHints } : {}),
            typedRef: entry.typedRef,
          },
          display: {
            input: entry.displayInput,
            output: entry.displayOutput,
          },
        }
      : {}),
  };
}

function listVisibleRegistryToolDescriptors(
  entries: RegistryToolEntry[],
  context: { workspaceId: string; accountId?: string; clientId?: string },
  policies: AccessPolicyRecord[],
  options: {
    includeDetails?: boolean;
    toolPaths?: string[];
    openApiRefHintLookup?: Record<string, Record<string, string>>;
  } = {},
): ToolDescriptor[] {
  const requestedPaths = options.toolPaths ?? [];
  const includeDetails = options.includeDetails ?? true;

  let candidates = entries;
  if (requestedPaths.length > 0) {
    const requestedSet = new Set(requestedPaths);
    candidates = entries.filter((entry) => requestedSet.has(entry.path));
  }

  return candidates
    .filter((entry) => {
      const decision = getDecisionForContext(entry, context, policies);
      return decision !== "deny";
    })
    .map((entry) => {
      const decision = getDecisionForContext(entry, context, policies);
      return toDescriptorFromRegistryEntry(
        {
          ...entry,
          approval: decision === "require_approval" ? "required" : "auto",
        },
        {
          includeDetails,
          openApiRefHintLookup: options.openApiRefHintLookup,
        },
      );
    });
}

function computeOpenApiSourceQualityFromDescriptors(
  tools: ToolDescriptor[],
): Record<string, OpenApiSourceQuality> {
  const grouped = new Map<string, ToolDescriptor[]>();

  for (const tool of tools) {
    const sourceKey = tool.source;
    if (!sourceKey || !sourceKey.startsWith("openapi:")) continue;
    const list = grouped.get(sourceKey) ?? [];
    list.push(tool);
    grouped.set(sourceKey, list);
  }

  const qualityBySource: Record<string, OpenApiSourceQuality> = {};
  for (const [sourceKey, sourceTools] of grouped.entries()) {
    const toolCount = sourceTools.length;
    let unknownArgsCount = 0;
    let unknownReturnsCount = 0;
    let partialUnknownArgsCount = 0;
    let partialUnknownReturnsCount = 0;

    for (const tool of sourceTools) {
      const input = tool.display?.input?.toLowerCase() ?? "";
      const output = tool.display?.output?.toLowerCase() ?? "";

      if (input.length === 0 || input === "{}" || input === "unknown") unknownArgsCount += 1;
      if (output.length === 0 || output === "unknown") unknownReturnsCount += 1;
      if (input.includes("unknown")) partialUnknownArgsCount += 1;
      if (output.includes("unknown")) partialUnknownReturnsCount += 1;
    }

    const argsQuality = toolCount > 0 ? (toolCount - unknownArgsCount) / toolCount : 1;
    const returnsQuality = toolCount > 0 ? (toolCount - unknownReturnsCount) / toolCount : 1;
    qualityBySource[sourceKey] = {
      sourceKey,
      toolCount,
      unknownArgsCount,
      unknownReturnsCount,
      partialUnknownArgsCount,
      partialUnknownReturnsCount,
      argsQuality,
      returnsQuality,
      overallQuality: (argsQuality + returnsQuality) / 2,
    };
  }

  return qualityBySource;
}

function computeOpenApiSourceQualityFromSerializedTools(
  serializedTools: SerializedTool[],
): Record<string, OpenApiSourceQuality> {
  const descriptors: ToolDescriptor[] = serializedTools
    .filter((tool) => typeof tool.source === "string" && tool.source.startsWith("openapi:"))
    .map((tool) => {
      const typing = tool.typing;
      const inputHint = typing?.inputHint?.trim();
      const outputHint = typing?.outputHint?.trim();
      const inputSchema = toJsonSchema(typing?.inputSchema);
      const outputSchema = toJsonSchema(typing?.outputSchema);

      return {
        path: tool.path,
        description: tool.description,
        approval: tool.approval,
        source: tool.source,
        display: {
          input: inputHint && inputHint.length > 0
            ? inputHint
            : (Object.keys(inputSchema).length === 0 ? "{}" : normalizeHint(jsonSchemaTypeHintFallback(inputSchema))),
          output: outputHint && outputHint.length > 0
            ? outputHint
            : (Object.keys(outputSchema).length === 0 ? "unknown" : normalizeHint(jsonSchemaTypeHintFallback(outputSchema))),
        },
      };
    });

  return computeOpenApiSourceQualityFromDescriptors(descriptors);
}

function computeSourceAuthProfilesFromSources(sources: ToolSourceRecord[]): Record<string, SourceAuthProfile> {
  const profiles: Record<string, SourceAuthProfile> = {};

  for (const source of sources) {
    const sourceKey = `source:${source.id}`;
    const auth = source.config.auth as Record<string, unknown> | undefined;
    const rawType = typeof auth?.type === "string" ? auth.type : "none";
    const type = rawType === "bearer"
      || rawType === "apiKey"
      || rawType === "basic"
      || rawType === "mixed"
      ? rawType
      : "none";
    const mode = auth?.mode === "workspace" || auth?.mode === "organization" || auth?.mode === "account"
      ? auth.mode
      : undefined;
    const header = typeof auth?.header === "string" && auth.header.trim().length > 0
      ? auth.header.trim()
      : undefined;

    profiles[sourceKey] = {
      type,
      ...(mode ? { mode } : {}),
      ...(header ? { header } : {}),
      inferred: false,
    };
  }

  return profiles;
}

function mergeTools(externalTools: Iterable<ToolDefinition>): Map<string, ToolDefinition> {
  const merged = new Map<string, ToolDefinition>();

  for (const tool of baseTools.values()) {
    merged.set(tool.path, tool);
  }

  for (const tool of externalTools) {
    merged.set(tool.path, tool);
  }
  return merged;
}

function tokenizePathSegment(value: string): string[] {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();

  return normalized
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

const GENERIC_NAMESPACE_SUFFIXES = new Set([
  "api",
  "apis",
  "openapi",
  "sdk",
  "service",
  "services",
]);

function simplifyNamespaceSegment(segment: string): string {
  const tokens = tokenizePathSegment(segment);
  if (tokens.length === 0) return segment;

  const collapsed: string[] = [];
  for (const token of tokens) {
    if (collapsed[collapsed.length - 1] === token) continue;
    collapsed.push(token);
  }

  while (collapsed.length > 1) {
    const last = collapsed[collapsed.length - 1];
    if (!last || !GENERIC_NAMESPACE_SUFFIXES.has(last)) break;
    collapsed.pop();
  }

  return collapsed.join("_");
}

function preferredToolPath(path: string): string {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return path;

  const simplifiedNamespace = simplifyNamespaceSegment(segments[0]!);
  if (!simplifiedNamespace || simplifiedNamespace === segments[0]) {
    return path;
  }

  return [simplifiedNamespace, ...segments.slice(1)].join(".");
}

function toCamelSegment(segment: string): string {
  return segment.replace(/_+([a-z0-9])/g, (_m, char: string) => char.toUpperCase());
}

function getPathAliases(path: string): string[] {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return [];

  const canonicalPath = path;
  const publicPath = preferredToolPath(path);

  const aliases = new Set<string>();
  const publicSegments = publicPath.split(".").filter(Boolean);
  const camelPath = publicSegments.map(toCamelSegment).join(".");
  const compactPath = publicSegments.map((segment) => segment.replace(/[_-]/g, "")).join(".");
  const lowerPath = publicPath.toLowerCase();

  if (publicPath !== canonicalPath) aliases.add(publicPath);
  if (camelPath !== publicPath) aliases.add(camelPath);
  if (compactPath !== publicPath) aliases.add(compactPath);
  if (lowerPath !== publicPath) aliases.add(lowerPath);

  return [...aliases].slice(0, 4);
}


function normalizeHint(type?: string): string {
  return type && type.trim().length > 0 ? type : "unknown";
}

async function buildWorkspaceToolRegistry(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    registrySignature: string;
    serializedTools: SerializedTool[];
  },
): Promise<{ buildId: string }> {
  const buildId = `toolreg_${crypto.randomUUID()}`;
  await ctx.runMutation(internal.toolRegistry.beginBuild, {
    workspaceId: args.workspaceId,
    signature: args.registrySignature,
    buildId,
  });

  try {
    const entries = args.serializedTools.map((st) => {
      if (st.path === "discover" || st.path.startsWith("catalog.")) {
        return null;
      }
      const preferredPath = preferredToolPath(st.path);
      const aliases = getPathAliases(st.path);
      const namespace = (preferredPath.split(".")[0] ?? "default").toLowerCase();
      const normalizedPath = normalizeToolPathForLookup(st.path);
      const searchText = `${st.path} ${preferredPath} ${aliases.join(" ")} ${st.description} ${st.source ?? ""}`.toLowerCase();

      const inputSchema = toJsonSchema(st.typing?.inputSchema);
      const outputSchema = toJsonSchema(st.typing?.outputSchema);
      const parsedTyping = toolHintSchema.safeParse(st.typing);
      const typing = parsedTyping.success ? parsedTyping.data : {};

      const requiredInputKeys = typing.requiredInputKeys ?? extractTopLevelRequiredKeys(inputSchema);
      const previewInputKeys = typing.previewInputKeys ?? buildPreviewKeys(inputSchema);
      const inputHint = typing.inputHint?.trim();
      const outputHint = typing.outputHint?.trim();

      const displayInput = inputHint && inputHint.length > 0
        ? inputHint
        : (Object.keys(inputSchema).length === 0
          ? "{}"
          : normalizeHint(jsonSchemaTypeHintFallback(inputSchema)));

      const displayOutput = outputHint && outputHint.length > 0
        ? outputHint
        : (Object.keys(outputSchema).length === 0
          ? "unknown"
          : normalizeHint(jsonSchemaTypeHintFallback(outputSchema)));

      const typedRef = st.typing?.typedRef && st.typing.typedRef.kind === "openapi_operation"
        ? {
            kind: "openapi_operation" as const,
            sourceKey: st.typing.typedRef.sourceKey,
            operationId: st.typing.typedRef.operationId,
          }
        : undefined;

      return {
        path: st.path,
        preferredPath,
        namespace,
        normalizedPath,
        aliases,
        description: st.description,
        approval: st.approval,
        source: st.source,
        searchText,
        displayInput,
        displayOutput,
        requiredInputKeys,
        previewInputKeys,
        typedRef,
        serializedToolJson: JSON.stringify(st),
      };
    });

    const filteredEntries = entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    const namespaceMap = new Map<string, { toolCount: number; samplePaths: string[] }>();
    for (const entry of filteredEntries) {
      const current = namespaceMap.get(entry.namespace) ?? { toolCount: 0, samplePaths: [] };
      current.toolCount += 1;
      if (current.samplePaths.length < 6) {
        current.samplePaths.push(entry.preferredPath);
      }
      namespaceMap.set(entry.namespace, current);
    }

    const namespaces = [...namespaceMap.entries()]
      .map(([namespace, meta]) => ({
        namespace,
        toolCount: meta.toolCount,
        samplePaths: [...meta.samplePaths].sort((a, b) => a.localeCompare(b)).slice(0, 3),
      }))
      .sort((a, b) => a.namespace.localeCompare(b.namespace));

    const TOOL_BATCH = 100;
    for (let i = 0; i < filteredEntries.length; i += TOOL_BATCH) {
      await ctx.runMutation(internal.toolRegistry.putToolsBatch, {
        workspaceId: args.workspaceId,
        buildId,
        tools: filteredEntries.slice(i, i + TOOL_BATCH),
      });
    }

    const NS_BATCH = 100;
    for (let i = 0; i < namespaces.length; i += NS_BATCH) {
      await ctx.runMutation(internal.toolRegistry.putNamespacesBatch, {
        workspaceId: args.workspaceId,
        buildId,
        namespaces: namespaces.slice(i, i + NS_BATCH),
      });
    }

    await ctx.runMutation(internal.toolRegistry.finishBuild, {
      workspaceId: args.workspaceId,
      buildId,
      signature: args.registrySignature,
    });

    await ctx.runAction(internal.toolRegistry.pruneBuilds, {
      workspaceId: args.workspaceId,
      maxRetainedBuilds: 2,
    });

    return { buildId };
  } catch (error) {
    await ctx.runMutation(internal.toolRegistry.failBuild, {
      workspaceId: args.workspaceId,
      buildId,
    });
    throw error;
  }
}

// No implicit "ensure"/backfill on reads: the registry is built on writes.

export async function getWorkspaceTools(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  options: GetWorkspaceToolsOptions = {},
): Promise<WorkspaceToolsResult> {
  const includeDts = true;
  const sourceTimeoutMs = options.sourceTimeoutMs;
  const accountId = options.accountId;
  const sources = (await listWorkspaceToolSources(ctx, workspaceId))
    .filter((source) => source.enabled);
  const registrySignature = registrySignatureForWorkspace(workspaceId, sources);

  const configs: ExternalToolSourceConfig[] = [];
  const warnings: string[] = [];
  for (const source of sources) {
    const normalizedResult = normalizeExternalToolSource(source);
    if (normalizedResult.isErr()) {
      warnings.push(`Source '${source.name}': ${normalizedResult.error.message}`);
      continue;
    }
    configs.push(normalizedResult.value);
  }

  const loadedSources = await Promise.all(configs.map(async (config) => {
    if (!sourceTimeoutMs || sourceTimeoutMs <= 0) {
      return {
        ...(await loadSourceArtifact(ctx, config, { includeDts, workspaceId, accountId })),
        timedOut: false,
        sourceName: config.name,
      };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<{
      artifact?: CompiledToolSourceArtifact;
      warnings: string[];
      timedOut: boolean;
      sourceName: string;
      openApiDts?: string;
      openApiSourceKey?: string;
    }>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          artifact: undefined,
          warnings: [`Source '${config.name}' is still loading; showing partial results.`],
          timedOut: true,
          sourceName: config.name,
          openApiDts: undefined,
          openApiSourceKey: config.type === "openapi" ? (config.sourceKey ?? `openapi:${config.name}`) : undefined,
        });
      }, sourceTimeoutMs);
    });

    const loadResult = loadSourceArtifact(ctx, config, { includeDts, workspaceId, accountId })
      .then((result) => ({ ...result, timedOut: false, sourceName: config.name }));

    const result = await Promise.race([loadResult, timeoutResult]);
    if (timer && !result.timedOut) {
      clearTimeout(timer);
    }
    return result;
  }));
  const externalArtifacts = loadedSources
    .map((loaded) => loaded.artifact)
    .filter((artifact): artifact is CompiledToolSourceArtifact => Boolean(artifact));
  const externalTools = externalArtifacts.flatMap((artifact) => materializeCompiledToolSource(artifact));
  warnings.push(...loadedSources.flatMap((loaded) => loaded.warnings));
  const hasTimedOutSource = loadedSources.some((loaded) => loaded.timedOut);
  const timedOutSources = loadedSources
    .filter((loaded) => loaded.timedOut)
    .map((loaded) => loaded.sourceName);
  const merged = mergeTools(externalTools);

  let typesStorageId: Id<"_storage"> | undefined;
  try {
    if (hasTimedOutSource) {
      return {
        tools: merged,
        warnings,
        typesStorageId,
        timedOutSources,
      };
    }

    const allTools = [...merged.values()];

    // Build a per-tool registry for fast discover + invocation.
    const { buildId } = await buildWorkspaceToolRegistry(ctx, {
      workspaceId,
      registrySignature,
      serializedTools: externalArtifacts.flatMap((artifact) => artifact.tools),
    });

    // Build and store a workspace-wide Monaco type bundle.
    const openApiDtsBySource: Record<string, string> = {};
    for (const loaded of loadedSources) {
      if (loaded.openApiDts && loaded.openApiDts.trim().length > 0) {
        const sourceKey = loaded.openApiSourceKey ?? `openapi:${loaded.sourceName}`;
        openApiDtsBySource[sourceKey] = loaded.openApiDts;
      }
    }
    const typeBundle = buildWorkspaceTypeBundle({
      tools: allTools,
      openApiDtsBySource,
    });
    const typesBlob = new Blob([typeBundle], { type: "text/plain" });
    typesStorageId = await ctx.storage.store(typesBlob);

    const sourceToolCountsByName = new Map<string, number>();
    for (const source of sources) {
      sourceToolCountsByName.set(source.name, 0);
    }
    for (const tool of externalArtifacts.flatMap((artifact) => artifact.tools)) {
      const sourceName = toSourceName(tool.source);
      if (!sourceName) continue;
      sourceToolCountsByName.set(sourceName, (sourceToolCountsByName.get(sourceName) ?? 0) + 1);
    }

    await ctx.runMutation(internal.toolRegistry.updateBuildMetadata, {
      workspaceId,
      buildId,
      typesStorageId,
      warnings,
      toolCount: allTools.length,
      sourceToolCounts: [...sourceToolCountsByName.entries()].map(([sourceName, toolCount]) => ({
        sourceName,
        toolCount,
      })),
      sourceVersions: sources.map((source) => ({
        sourceId: source.id,
        sourceName: source.name,
        updatedAt: source.updatedAt,
      })),
      sourceQuality: Object.values(computeOpenApiSourceQualityFromSerializedTools(
        externalArtifacts.flatMap((artifact) => artifact.tools),
      )),
      sourceAuthProfiles: Object.entries(computeSourceAuthProfilesFromSources(sources)).map(([sourceKey, profile]) => ({
        sourceKey,
        type: profile.type,
        mode: profile.mode,
        header: profile.header,
        inferred: profile.inferred,
      })),
      openApiRefHintTables: externalArtifacts
        .filter((artifact) => typeof artifact.openApiSourceKey === "string" && typeof artifact.openApiRefHintTable === "object")
        .map((artifact) => ({
          sourceKey: artifact.openApiSourceKey!,
          refs: Object.entries(artifact.openApiRefHintTable ?? {})
            .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
            .map(([key, hint]) => ({ key, hint })),
        }))
        .filter((entry) => entry.refs.length > 0),
    } as never);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[executor] workspace tool registry metadata write failed for '${workspaceId}': ${msg}`);
  }

  return {
    tools: merged,
    warnings,
    typesStorageId,
    timedOutSources,
  };
}

interface WorkspaceRegistryReadResult {
  sources: ToolSourceRecord[];
  registryTools: RegistryToolEntry[];
  warnings: string[];
  typesStorageId?: Id<"_storage">;
  inventoryStatus: ToolInventoryStatus;
  nextCursor?: string | null;
  totalTools: number;
  sourceQuality: Record<string, OpenApiSourceQuality>;
  sourceAuthProfiles: Record<string, SourceAuthProfile>;
  openApiRefHintLookup: Record<string, Record<string, string>>;
}

function toSourceToolCountRecord(items: Array<{ sourceName: string; toolCount: number }>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    result[item.sourceName] = item.toolCount;
  }
  return result;
}

function toSourceQualityRecord(items: OpenApiSourceQuality[]): Record<string, OpenApiSourceQuality> {
  const result: Record<string, OpenApiSourceQuality> = {};
  for (const item of items) {
    result[item.sourceKey] = item;
  }
  return result;
}

function toSourceAuthProfileRecord(
  items: Array<{
    sourceKey: string;
    type: SourceAuthProfile["type"];
    mode?: SourceAuthProfile["mode"];
    header?: string;
    inferred: boolean;
  }>,
): Record<string, SourceAuthProfile> {
  const result: Record<string, SourceAuthProfile> = {};
  for (const item of items) {
    result[item.sourceKey] = {
      type: item.type,
      ...(item.mode ? { mode: item.mode } : {}),
      ...(item.header ? { header: item.header } : {}),
      inferred: item.inferred,
    };
  }
  return result;
}

function changedSourceNames(
  currentSources: ToolSourceRecord[],
  previousVersions: Array<{ sourceId: string; sourceName: string; updatedAt: number }>,
): string[] {
  const previousById = new Map(previousVersions.map((source) => [source.sourceId, source]));
  const changed = new Set<string>();

  for (const source of currentSources) {
    const previous = previousById.get(source.id);
    if (!previous || previous.updatedAt !== source.updatedAt || previous.sourceName !== source.name) {
      changed.add(source.name);
    }
  }

  return [...changed].sort((a, b) => a.localeCompare(b));
}

async function getWorkspaceToolsFromRegistry(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  options: {
    toolPaths?: string[];
    source?: string;
    sourceName?: string;
    cursor?: string;
    limit?: number;
    buildId?: string;
    fetchAll?: boolean;
  } = {},
): Promise<WorkspaceRegistryReadResult> {
  const sources = (await listWorkspaceToolSources(ctx, workspaceId))
    .filter((source) => source.enabled);
  const expectedRegistrySignature = registrySignatureForWorkspace(workspaceId, sources);

  const registryState: {
    signature?: string;
    readyBuildId?: string;
    buildingBuildId?: string;
    buildingSignature?: string;
    buildingStartedAt?: number;
    lastBuildCompletedAt?: number;
    lastBuildFailedAt?: number;
    lastBuildError?: string;
    typesStorageId?: Id<"_storage">;
    warnings?: string[];
    toolCount?: number;
    sourceToolCounts?: Array<{ sourceName: string; toolCount: number }>;
    sourceVersions?: Array<{ sourceId: string; sourceName: string; updatedAt: number }>;
    sourceQuality?: OpenApiSourceQuality[];
    sourceAuthProfiles?: Array<{
      sourceKey: string;
      type: SourceAuthProfile["type"];
      mode?: SourceAuthProfile["mode"];
      header?: string;
      inferred: boolean;
    }>;
    openApiRefHintTables?: Array<{
      sourceKey: string;
      refs: Array<{ key: string; hint: string }>;
    }>;
    updatedAt?: number;
  } | null = await ctx.runQuery(internal.toolRegistry.getState, {
    workspaceId,
  });

  const readyBuildId = registryState?.readyBuildId;
  const activeBuildId = options.buildId ?? readyBuildId;
  const building = Boolean(registryState?.buildingBuildId);
  const isFresh = Boolean(registryState?.signature && registryState.signature === expectedRegistrySignature && !building);
  const sourceCounts = toSourceToolCountRecord(registryState?.sourceToolCounts ?? []);
  const sourceQuality = toSourceQualityRecord(registryState?.sourceQuality ?? []);
  const sourceAuthProfiles = toSourceAuthProfileRecord(registryState?.sourceAuthProfiles ?? []);
  const openApiRefHintLookup = toOpenApiRefHintLookup(registryState?.openApiRefHintTables ?? []);
  const changedSources = changedSourceNames(sources, registryState?.sourceVersions ?? []);

  let state: ToolInventoryState;
  if (building && readyBuildId) {
    state = "rebuilding";
  } else if (building && !readyBuildId) {
    state = "initializing";
  } else if (!readyBuildId && registryState?.lastBuildError) {
    state = "failed";
  } else if (!readyBuildId) {
    state = "initializing";
  } else if (isFresh) {
    state = "ready";
  } else if (registryState?.lastBuildError) {
    state = "failed";
  } else {
    state = "stale";
  }

  const warnings: string[] = [...(registryState?.warnings ?? [])];
  const scopedSourceName = options.sourceName ?? toSourceName(options.source) ?? undefined;
  let loadingSourceNames: string[] = [];
  const allSourceNames = sources.map((source) => source.name);
  const relevantSourceNames = scopedSourceName
    ? allSourceNames.filter((name) => name === scopedSourceName)
    : allSourceNames;

  if (state === "initializing") {
    loadingSourceNames = [...relevantSourceNames];
    if (relevantSourceNames.length > 0) {
      warnings.push("Tool inventory is still loading; showing partial results.");
    }
  } else if (state === "rebuilding" || state === "stale" || state === "failed") {
    loadingSourceNames = scopedSourceName
      ? changedSources.filter((name) => name === scopedSourceName)
      : changedSources;
  }

  if (state === "stale" || state === "rebuilding") {
    warnings.push("Tool sources changed; showing previous results while refreshing.");
  }
  if (state === "failed" && registryState?.lastBuildError) {
    warnings.push(`Tool inventory build failed: ${registryState.lastBuildError}`);
  }
  for (const sourceName of loadingSourceNames) {
    warnings.push(`Source '${sourceName}' is still loading; showing partial results.`);
  }

  const inventoryStatus: ToolInventoryStatus = {
    state,
    readyBuildId,
    buildingBuildId: registryState?.buildingBuildId,
    readyToolCount: registryState?.toolCount ?? 0,
    loadingSourceNames,
    sourceToolCounts: sourceCounts,
    lastBuildStartedAt: registryState?.buildingStartedAt,
    lastBuildCompletedAt: registryState?.lastBuildCompletedAt,
    lastBuildFailedAt: registryState?.lastBuildFailedAt,
    ...(registryState?.lastBuildError ? { error: registryState.lastBuildError } : {}),
    updatedAt: registryState?.updatedAt,
  };

  const totalTools = scopedSourceName
    ? (sourceCounts[scopedSourceName] ?? 0)
    : inventoryStatus.readyToolCount;

  if (!activeBuildId) {
    return {
      sources,
      registryTools: [],
      warnings,
      typesStorageId: registryState?.typesStorageId,
      inventoryStatus,
      nextCursor: null,
      totalTools,
      sourceQuality,
      sourceAuthProfiles,
      openApiRefHintLookup,
    };
  }

  const registryTools: RegistryToolEntry[] = [];
  const requestedPaths = [...new Set((options.toolPaths ?? []).map((path) => path.trim()).filter((path) => path.length > 0))];
  let nextCursor: string | null | undefined;

  if (requestedPaths.length > 0) {
    const entries = await Promise.all(requestedPaths.map(async (path) => {
      const entry = await ctx.runQuery(internal.toolRegistry.getToolByPath, {
        workspaceId,
        buildId: activeBuildId,
        path,
      });
      if (!entry) return null;
      return {
        path: entry.path,
        preferredPath: entry.preferredPath,
        aliases: entry.aliases,
        description: entry.description,
        approval: entry.approval,
        source: entry.source,
        displayInput: entry.displayInput,
        displayOutput: entry.displayOutput,
        requiredInputKeys: entry.requiredInputKeys,
        previewInputKeys: entry.previewInputKeys,
        serializedToolJson: entry.serializedToolJson,
        typedRef: entry.typedRef,
      } as RegistryToolEntry;
    }));
    registryTools.push(...entries.filter((entry): entry is RegistryToolEntry => Boolean(entry)));
  } else {
    if (options.fetchAll) {
      let cursor: string | undefined;
      while (true) {
        const page: {
          continueCursor: string | null;
          items: RegistryToolEntry[];
        } = options.source
          ? await ctx.runQuery(internal.toolRegistry.listToolsBySourcePage, {
            workspaceId,
            buildId: activeBuildId,
            source: options.source,
            cursor,
            limit: 500,
          })
          : await ctx.runQuery(internal.toolRegistry.listToolsPage, {
            workspaceId,
            buildId: activeBuildId,
            cursor,
            limit: 500,
          });
        for (const entry of page.items) {
          registryTools.push(entry);
        }
        if (page.continueCursor === null) {
          nextCursor = null;
          break;
        }
        cursor = page.continueCursor;
      }
    } else {
      const page: {
        continueCursor: string | null;
        items: RegistryToolEntry[];
      } = options.source
        ? await ctx.runQuery(internal.toolRegistry.listToolsBySourcePage, {
          workspaceId,
          buildId: activeBuildId,
          source: options.source,
          cursor: options.cursor,
          limit: Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 250))),
        })
        : await ctx.runQuery(internal.toolRegistry.listToolsPage, {
          workspaceId,
          buildId: activeBuildId,
          cursor: options.cursor,
          limit: Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 250))),
        });
      registryTools.push(...page.items);
      nextCursor = page.continueCursor;
    }
  }

  return {
    sources,
    registryTools,
    warnings,
    typesStorageId: registryState?.typesStorageId,
    inventoryStatus,
    nextCursor,
    totalTools,
    sourceQuality,
    sourceAuthProfiles,
    openApiRefHintLookup,
  };
}

async function loadWorkspaceToolInventoryForContext(
  ctx: ActionCtx,
  context: { workspaceId: Id<"workspaces">; accountId?: Id<"accounts">; clientId?: string },
  options: {
    includeDetails?: boolean;
    includeSourceMeta?: boolean;
    toolPaths?: string[];
    source?: string;
    sourceName?: string;
    cursor?: string;
    limit?: number;
    buildId?: string;
    fetchAll?: boolean;
  } = {},
): Promise<WorkspaceToolInventory> {
  const includeDetails = options.includeDetails ?? true;
  const includeSourceMeta = options.includeSourceMeta ?? true;
  const [result, policies] = await Promise.all([
    getWorkspaceToolsFromRegistry(ctx, context.workspaceId, {
      toolPaths: options.toolPaths,
      source: options.source,
      sourceName: options.sourceName,
      cursor: options.cursor,
      limit: options.limit,
      buildId: options.buildId,
      fetchAll: options.fetchAll,
    }),
    listWorkspaceAccessPolicies(ctx, context.workspaceId, context.accountId),
  ]);

  const includeBaseTools = options.source || options.sourceName
    ? false
    : options.toolPaths
    ? true
    : Boolean(options.fetchAll || !options.cursor);
  const baseDescriptors = includeBaseTools
    ? listVisibleToolDescriptors(baseTools, context, policies, {
      includeDetails,
      toolPaths: options.toolPaths,
    })
    : [];
  const registryDescriptors = listVisibleRegistryToolDescriptors(result.registryTools, context, policies, {
    includeDetails,
    toolPaths: options.toolPaths,
    openApiRefHintLookup: result.openApiRefHintLookup,
  });
  const toolsByPath = new Map<string, ToolDescriptor>();
  for (const tool of baseDescriptors) toolsByPath.set(tool.path, tool);
  for (const tool of registryDescriptors) toolsByPath.set(tool.path, tool);
  const tools = [...toolsByPath.values()];

  const sourceQuality = includeSourceMeta ? result.sourceQuality : {};
  const sourceAuthProfiles = includeSourceMeta ? result.sourceAuthProfiles : {};

  let typesUrl: string | undefined;
  if (result.typesStorageId) {
    try {
      typesUrl = await ctx.storage.getUrl(result.typesStorageId) ?? undefined;
    } catch {
      typesUrl = undefined;
    }
  }

  const { tools: boundedTools, warnings: boundedWarnings } = truncateToolsForActionResult(
    tools,
    result.warnings,
  );

  return {
    tools: boundedTools,
    warnings: boundedWarnings,
    typesUrl,
    sourceQuality,
    sourceAuthProfiles,
    inventoryStatus: result.inventoryStatus,
    nextCursor: result.nextCursor,
    totalTools: result.totalTools,
  };
}

export async function listToolsForContext(
  ctx: ActionCtx,
  context: { workspaceId: Id<"workspaces">; accountId?: Id<"accounts">; clientId?: string },
  options: {
    includeDetails?: boolean;
    includeSourceMeta?: boolean;
    toolPaths?: string[];
    source?: string;
    sourceName?: string;
    cursor?: string;
    limit?: number;
    buildId?: string;
  } = {},
): Promise<ToolDescriptor[]> {
  const inventory = await loadWorkspaceToolInventoryForContext(ctx, context, {
    ...options,
    includeSourceMeta: options.includeSourceMeta ?? false,
    fetchAll: true,
  });
  return inventory.tools;
}

export async function rebuildWorkspaceToolInventoryForContext(
  ctx: ActionCtx,
  context: { workspaceId: Id<"workspaces">; accountId?: Id<"accounts">; clientId?: string },
): Promise<WorkspaceToolsResult> {
  return await getWorkspaceTools(ctx, context.workspaceId, {
    accountId: context.accountId,
    sourceTimeoutMs: 20_000,
  });
}

export async function listToolsWithWarningsForContext(
  ctx: ActionCtx,
  context: { workspaceId: Id<"workspaces">; accountId?: Id<"accounts">; clientId?: string },
  options: {
    includeDetails?: boolean;
    includeSourceMeta?: boolean;
    toolPaths?: string[];
    source?: string;
    sourceName?: string;
    cursor?: string;
    limit?: number;
    buildId?: string;
    fetchAll?: boolean;
  } = {},
): Promise<{
  tools: ToolDescriptor[];
  warnings: string[];
  typesUrl?: string;
  sourceQuality: Record<string, OpenApiSourceQuality>;
  sourceAuthProfiles: Record<string, SourceAuthProfile>;
  inventoryStatus: ToolInventoryStatus;
  nextCursor?: string | null;
  totalTools: number;
}> {
  const inventory = await loadWorkspaceToolInventoryForContext(ctx, context, options);
  return {
    tools: inventory.tools,
    warnings: inventory.warnings,
    typesUrl: inventory.typesUrl,
    sourceQuality: inventory.sourceQuality,
    sourceAuthProfiles: inventory.sourceAuthProfiles,
    inventoryStatus: inventory.inventoryStatus,
    nextCursor: inventory.nextCursor,
    totalTools: inventory.totalTools,
  };
}
