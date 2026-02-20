import { z } from "zod";
import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel.d.ts";
import { buildWorkspaceTypeBundle } from "../../../core/src/tool-typing/typebundle";
import {
  displayArgTypeHint,
  compactArgTypeHintFromSchema,
  displayReturnTypeHint,
  compactReturnTypeHintFromSchema,
  isLossyTypeHint,
} from "../../../core/src/type-hints";
import { buildPreviewKeys, extractTopLevelRequiredKeys } from "../../../core/src/tool-typing/schema-utils";
import {
  type CompiledToolSourceArtifact,
} from "./tool_source_artifact";
import { parseSerializedTool, rehydrateTools, type SerializedTool } from "../../../core/src/tool/source-serialization";
import type { ExternalToolSourceConfig } from "../../../core/src/tool/source-types";
import type {
  ToolPolicyRecord,
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

type QueryRunnerCtx = Pick<ActionCtx, "runQuery">;

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

function stringifySchema(schema: JsonSchema): string | undefined {
  if (Object.keys(schema).length === 0) return undefined;
  try {
    return JSON.stringify(schema, null, 2);
  } catch {
    return undefined;
  }
}

async function listWorkspaceToolSources(
  ctx: QueryRunnerCtx,
  workspaceId: Id<"workspaces">,
): Promise<ToolSourceRecord[]> {
  const sources = await ctx.runQuery(internal.database.listToolSources, { workspaceId });
  return sources;
}

async function listWorkspaceToolPolicies(
  ctx: QueryRunnerCtx,
  workspaceId: Id<"workspaces">,
  accountId?: Id<"accounts">,
): Promise<ToolPolicyRecord[]> {
  const policies = await ctx.runQuery(internal.database.listToolPolicies, { workspaceId, accountId });
  return policies;
}

export type ToolInventoryState = "initializing" | "ready" | "rebuilding" | "failed";

export interface ToolInventoryStatus {
  state: ToolInventoryState;
  readyToolCount: number;
  loadingSourceNames: string[];
  sourceToolCounts: Record<string, number>;
  error?: string;
  updatedAt?: number;
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

export type ToolDetailDescriptor = Pick<ToolDescriptor, "path" | "description" | "typing" | "display">;

const MAX_TOOLS_IN_ACTION_RESULT = 8_000;
const MAX_TOOL_DETAILS_LOOKUP_PATHS = 100;
const MAX_REF_HINTS_PER_SOURCE = 300;
const MAX_REF_HINT_HINT_CHARS = 240;
const MAX_REF_HINT_METADATA_BYTES = 220_000;
const SOURCE_LOAD_HEARTBEAT_MS = 5_000;

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

function buildBoundedOpenApiRefHintTables(
  externalArtifacts: CompiledToolSourceArtifact[],
): Array<{ sourceKey: string; refs: Array<{ key: string; hint: string }> }> {
  let remainingBudget = MAX_REF_HINT_METADATA_BYTES;

  const tables = externalArtifacts
    .filter(
      (
        artifact,
      ): artifact is CompiledToolSourceArtifact & { openApiSourceKey: string; openApiRefHintTable: Record<string, string> } => (
        typeof artifact.openApiSourceKey === "string"
        && artifact.openApiRefHintTable !== undefined
      ),
    )
    .map((artifact) => {
      const sourceKey = artifact.openApiSourceKey;
      const refs: Array<{ key: string; hint: string }> = [];

      const rawEntries = Object.entries(artifact.openApiRefHintTable)
        .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string");

      for (const [key, rawHint] of rawEntries) {
        if (refs.length >= MAX_REF_HINTS_PER_SOURCE || remainingBudget <= 0) break;

        const trimmedKey = key.trim();
        const trimmedHint = rawHint.trim();
        if (!trimmedKey || !trimmedHint) continue;

        const boundedHint = trimmedHint.length > MAX_REF_HINT_HINT_CHARS
          ? `${trimmedHint.slice(0, MAX_REF_HINT_HINT_CHARS)}...`
          : trimmedHint;

        const entryBytes = trimmedKey.length + boundedHint.length + 16;
        if (entryBytes > remainingBudget) {
          break;
        }

        refs.push({ key: trimmedKey, hint: boundedHint });
        remainingBudget -= entryBytes;
      }

      return {
        sourceKey,
        refs,
      };
    })
    .filter((entry) => entry.refs.length > 0);

  return tables;
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

  const fallbackDisplayInput = displayArgTypeHint(entry.displayInput ?? "{}");
  const fallbackDisplayOutput = displayReturnTypeHint(entry.displayOutput ?? "unknown");

  let resolvedDisplayInput = fallbackDisplayInput;
  let resolvedDisplayOutput = fallbackDisplayOutput;
  let inputSchemaJson: string | undefined;
  let outputSchemaJson: string | undefined;

  if (entry.serializedToolJson) {
    try {
      const parsedJson = JSON.parse(entry.serializedToolJson);
      const parsedSerializedTool = parseSerializedTool(parsedJson);
      if (parsedSerializedTool.isOk()) {
        const serializedTool = parsedSerializedTool.value;
        const inputSchema = toJsonSchema(serializedTool.typing?.inputSchema);
        const outputSchema = toJsonSchema(serializedTool.typing?.outputSchema);
        inputSchemaJson = stringifySchema(inputSchema);
        outputSchemaJson = stringifySchema(outputSchema);
        const typedInputHint = serializedTool.typing?.inputHint?.trim();
        const typedOutputHint = serializedTool.typing?.outputHint?.trim();
        const hasInputSchema = Object.keys(inputSchema).length > 0;
        const hasOutputSchema = Object.keys(outputSchema).length > 0;
        const useTypedInputHint = Boolean(typedInputHint && (!isLossyTypeHint(typedInputHint) || !hasInputSchema));
        const useTypedOutputHint = Boolean(typedOutputHint && (!isLossyTypeHint(typedOutputHint) || !hasOutputSchema));

        resolvedDisplayInput = useTypedInputHint && typedInputHint
          ? displayArgTypeHint(typedInputHint)
          : (hasInputSchema ? compactArgTypeHintFromSchema(inputSchema) : fallbackDisplayInput);

        resolvedDisplayOutput = useTypedOutputHint && typedOutputHint
          ? displayReturnTypeHint(typedOutputHint)
          : (hasOutputSchema ? compactReturnTypeHintFromSchema(outputSchema) : fallbackDisplayOutput);
      }
    } catch {
      // Keep fallback display hints.
    }
  }

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
          ...(inputSchemaJson ? { inputSchemaJson } : {}),
          ...(outputSchemaJson ? { outputSchemaJson } : {}),
          ...(refHintResolution.refHintKeys.length > 0 ? { refHintKeys: refHintResolution.refHintKeys } : {}),
          ...(Object.keys(refHintResolution.refHints).length > 0 ? { refHints: refHintResolution.refHints } : {}),
          typedRef: entry.typedRef,
        },
        display: {
          input: resolvedDisplayInput,
          output: resolvedDisplayOutput,
        },
      }
      : {}),
  };
}

function toToolDetailDescriptor(tool: ToolDescriptor): ToolDetailDescriptor {
  return {
    path: tool.path,
    description: tool.description,
    ...(tool.typing ? { typing: tool.typing } : {}),
    ...(tool.display ? { display: tool.display } : {}),
  };
}

function listVisibleRegistryToolDescriptors(
  entries: RegistryToolEntry[],
  context: { workspaceId: string; accountId?: string; clientId?: string },
  policies: ToolPolicyRecord[],
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
      const hasInputSchema = Object.keys(inputSchema).length > 0;
      const hasOutputSchema = Object.keys(outputSchema).length > 0;
      const useInputHint = Boolean(inputHint && (!isLossyTypeHint(inputHint) || !hasInputSchema));
      const useOutputHint = Boolean(outputHint && (!isLossyTypeHint(outputHint) || !hasOutputSchema));

      return {
        path: tool.path,
        description: tool.description,
        approval: tool.approval,
        source: tool.source,
        display: {
          input: useInputHint && inputHint
            ? displayArgTypeHint(inputHint)
            : compactArgTypeHintFromSchema(inputSchema),
          output: useOutputHint && outputHint
            ? displayReturnTypeHint(outputHint)
            : compactReturnTypeHintFromSchema(outputSchema),
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

type RegistryWriteEntry = {
  path: string;
  preferredPath: string;
  namespace: string;
  normalizedPath: string;
  aliases: string[];
  description: string;
  approval: "auto" | "required";
  source?: string;
  searchText: string;
  displayInput?: string;
  displayOutput?: string;
  requiredInputKeys?: string[];
  previewInputKeys?: string[];
  typedRef?: {
    kind: "openapi_operation";
    sourceKey: string;
    operationId: string;
  };
  serializedToolJson: string;
};

type MaterializedSourceStateRecord = {
  sourceId: string;
  sourceName: string;
  sourceKey: string;
  signature: string;
  state: "queued" | "loading" | "indexing" | "ready" | "failed";
  toolCount: number;
  processedTools?: number;
  message?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  updatedAt: number;
  sourceQuality?: OpenApiSourceQuality;
  openApiRefHints?: Array<{ key: string; hint: string }>;
};

function sourceStateSignature(workspaceId: Id<"workspaces">, source: ToolSourceRecord): string {
  return registrySignatureForWorkspace(workspaceId, [{
    id: source.id,
    updatedAt: source.updatedAt,
    enabled: source.enabled,
  }]);
}

function sourceStateSourceKey(source: Pick<ToolSourceRecord, "type" | "name">): string {
  return `${source.type}:${source.name}`;
}

function sourceLoadingMessage(source: ExternalToolSourceConfig, elapsedSeconds: number): string {
  if (source.type === "openapi") {
    let hostSuffix = "";
    if (typeof source.spec === "string") {
      try {
        const host = new URL(source.spec).host;
        if (host) {
          hostSuffix = ` from ${host}`;
        }
      } catch {
        hostSuffix = "";
      }
    }

    if (elapsedSeconds < 10) {
      return `Downloading OpenAPI document${hostSuffix}`;
    }
    if (elapsedSeconds < 40) {
      return `Parsing and resolving $ref links${hostSuffix}`;
    }
    return `Resolving a large OpenAPI document${hostSuffix} (can take 1-2m)`;
  }

  if (source.type === "graphql") {
    return elapsedSeconds < 12
      ? "Loading GraphQL schema"
      : "Building GraphQL operations";
  }

  return elapsedSeconds < 12
    ? "Connecting to MCP source"
    : "Discovering MCP tools";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function registryWriteEntriesFromSerializedTools(serializedTools: SerializedTool[]): RegistryWriteEntry[] {
  const entries: RegistryWriteEntry[] = [];

  for (const st of serializedTools) {
    if (st.path === "discover" || st.path.startsWith("catalog.")) {
      continue;
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
    const hasInputSchema = Object.keys(inputSchema).length > 0;
    const hasOutputSchema = Object.keys(outputSchema).length > 0;
    const useInputHint = Boolean(inputHint && (!isLossyTypeHint(inputHint) || !hasInputSchema));
    const useOutputHint = Boolean(outputHint && (!isLossyTypeHint(outputHint) || !hasOutputSchema));

    const displayInput = useInputHint && inputHint
      ? displayArgTypeHint(inputHint)
      : compactArgTypeHintFromSchema(inputSchema);

    const displayOutput = useOutputHint && outputHint
      ? displayReturnTypeHint(outputHint)
      : compactReturnTypeHintFromSchema(outputSchema);

    const typedRef = st.typing?.typedRef && st.typing.typedRef.kind === "openapi_operation"
      ? {
        kind: "openapi_operation" as const,
        sourceKey: st.typing.typedRef.sourceKey,
        operationId: st.typing.typedRef.operationId,
      }
      : undefined;

    entries.push({
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
    });
  }

  return entries;
}


function toSourceStateRows(
  items: Iterable<MaterializedSourceStateRecord>,
): MaterializedSourceStateRecord[] {
  return [...items]
    .sort((left, right) => left.sourceName.localeCompare(right.sourceName))
    .map((item) => ({ ...item }));
}

async function persistSourceStates(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  sourceStates: Iterable<MaterializedSourceStateRecord>,
  signature?: string,
): Promise<void> {
  await ctx.runMutation(internal.toolRegistry.setSourceStates, {
    workspaceId,
    sourceStates: toSourceStateRows(sourceStates),
    signature,
  });
}

async function listAllRegistryEntries(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
): Promise<RegistryToolEntry[]> {
  const entries: RegistryToolEntry[] = [];
  let cursor: string | undefined;

  while (true) {
    const page: {
      continueCursor: string | null;
      items: RegistryToolEntry[];
    } = await ctx.runQuery(internal.toolRegistry.listToolsPage, {
      workspaceId,
      cursor,
      limit: 250,
    });

    entries.push(...page.items);
    if (page.continueCursor === null) {
      break;
    }
    cursor = page.continueCursor;
  }

  return entries;
}

async function listAllSerializedTools(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
): Promise<SerializedTool[]> {
  const serializedTools: SerializedTool[] = [];
  let cursor: string | undefined;

  while (true) {
    const page: {
      continueCursor: string | null;
      items: Array<{ path: string; serializedToolJson: string }>;
    } = await ctx.runQuery(internal.toolRegistry.listSerializedToolsPage, {
      workspaceId,
      cursor,
      limit: 250,
    });

    for (const item of page.items) {
      try {
        const parsed = JSON.parse(item.serializedToolJson);
        const parsedTool = parseSerializedTool(parsed);
        if (parsedTool.isOk()) {
          serializedTools.push(parsedTool.value);
        }
      } catch {
        // Ignore malformed payloads; they are surfaced as warnings elsewhere.
      }
    }

    if (page.continueCursor === null) {
      break;
    }
    cursor = page.continueCursor;
  }

  return serializedTools;
}

async function rebuildNamespaceSummaries(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  entries: RegistryToolEntry[],
): Promise<void> {
  let cursor: string | undefined;
  while (true) {
    const page: { continueCursor: string | null } = await ctx.runMutation(
      internal.toolRegistry.deleteToolRegistryNamespacesPage,
      {
        workspaceId,
        cursor,
      },
    );
    if (page.continueCursor === null) {
      break;
    }
    cursor = page.continueCursor;
  }

  const namespaceMap = new Map<string, { toolCount: number; samplePaths: string[] }>();
  for (const entry of entries) {
    const namespace = (entry.preferredPath.split(".")[0] ?? "default").toLowerCase();
    const current = namespaceMap.get(namespace) ?? { toolCount: 0, samplePaths: [] };
    current.toolCount += 1;
    if (current.samplePaths.length < 6) {
      current.samplePaths.push(entry.preferredPath);
    }
    namespaceMap.set(namespace, current);
  }

  const namespaces = [...namespaceMap.entries()]
    .map(([namespace, meta]) => ({
      namespace,
      toolCount: meta.toolCount,
      samplePaths: [...meta.samplePaths].sort((a, b) => a.localeCompare(b)).slice(0, 3),
    }))
    .sort((a, b) => a.namespace.localeCompare(b.namespace));

  const NS_BATCH = 100;
  for (let i = 0; i < namespaces.length; i += NS_BATCH) {
    await ctx.runMutation(internal.toolRegistry.putNamespacesBatch, {
      workspaceId,
      namespaces: namespaces.slice(i, i + NS_BATCH),
    });
  }
}

async function refreshWorkspaceToolRegistryIncremental(
  ctx: ActionCtx,
  context: { workspaceId: Id<"workspaces">; accountId?: Id<"accounts">; clientId?: string },
): Promise<void> {
  const workspaceId = context.workspaceId;
  const sources = (await listWorkspaceToolSources(ctx, workspaceId))
    .filter((source) => source.enabled);

  const existingState = await ctx.runQuery(internal.toolRegistry.getState, {
    workspaceId,
  }) as WorkspaceRegistryStateRecord;

  const sourceStatesById = new Map<string, MaterializedSourceStateRecord>(
    (existingState?.sourceStates ?? []).map((sourceState) => [sourceState.sourceId, sourceState]),
  );

  const enabledSourceIds = new Set(sources.map((source) => source.id));
  for (const [sourceId, sourceState] of sourceStatesById.entries()) {
    if (enabledSourceIds.has(sourceId)) {
      continue;
    }
    await ctx.runAction(internal.toolRegistry.deleteToolsBySource, {
      workspaceId,
      source: sourceState.sourceKey,
    });
    sourceStatesById.delete(sourceId);
  }

  await persistSourceStates(ctx, workspaceId, sourceStatesById.values());

  const warnings: string[] = [];

  for (const source of sources) {
    const sourceKey = sourceStateSourceKey(source);
    const signature = sourceStateSignature(workspaceId, source);
    const previous = sourceStatesById.get(source.id);
    if (previous && previous.signature === signature && previous.state === "ready") {
      continue;
    }

    const startedAt = Date.now();
    sourceStatesById.set(source.id, {
      sourceId: source.id,
      sourceName: source.name,
      sourceKey,
      signature,
      state: "loading",
      toolCount: previous?.toolCount ?? 0,
      processedTools: 0,
      message: "Starting source load",
      startedAt,
      updatedAt: startedAt,
    });
    await persistSourceStates(ctx, workspaceId, sourceStatesById.values());

    const normalizedResult = normalizeExternalToolSource(source);
    if (normalizedResult.isErr()) {
      const message = normalizedResult.error.message;
      const failedAt = Date.now();
      warnings.push(`Source '${source.name}': ${message}`);
      sourceStatesById.set(source.id, {
        sourceId: source.id,
        sourceName: source.name,
        sourceKey,
        signature,
        state: "failed",
        toolCount: previous?.toolCount ?? 0,
        processedTools: 0,
        message: "Failed",
        error: message,
        startedAt,
        updatedAt: failedAt,
      });
      await persistSourceStates(ctx, workspaceId, sourceStatesById.values());
      continue;
    }

    const initialLoadMessage = sourceLoadingMessage(normalizedResult.value, 0);
    sourceStatesById.set(source.id, {
      sourceId: source.id,
      sourceName: source.name,
      sourceKey,
      signature,
      state: "loading",
      toolCount: previous?.toolCount ?? 0,
      processedTools: 0,
      message: initialLoadMessage,
      startedAt,
      updatedAt: Date.now(),
    });
    await persistSourceStates(ctx, workspaceId, sourceStatesById.values());

    let keepHeartbeatRunning = true;
    const heartbeat = (async () => {
      while (keepHeartbeatRunning) {
        await sleep(SOURCE_LOAD_HEARTBEAT_MS);
        if (!keepHeartbeatRunning) {
          break;
        }

        const elapsedMs = Date.now() - startedAt;
        const elapsedSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
        const loadingMessage = `${sourceLoadingMessage(normalizedResult.value, elapsedSeconds)} (${elapsedSeconds}s)`;
        sourceStatesById.set(source.id, {
          sourceId: source.id,
          sourceName: source.name,
          sourceKey,
          signature,
          state: "loading",
          toolCount: previous?.toolCount ?? 0,
          processedTools: 0,
          message: loadingMessage,
          startedAt,
          updatedAt: Date.now(),
        });
        await persistSourceStates(ctx, workspaceId, sourceStatesById.values());
      }
    })();

    let loaded:
      | {
        artifact?: CompiledToolSourceArtifact;
        warnings: string[];
        openApiDts?: string;
        openApiSourceKey?: string;
      }
      | undefined;

    try {
      loaded = await loadSourceArtifact(ctx, normalizedResult.value, {
        includeDts: false,
        workspaceId,
        accountId: context.accountId,
      });
    } catch (error) {
      keepHeartbeatRunning = false;
      await heartbeat;

      const message = error instanceof Error ? error.message : String(error);
      const failedAt = Date.now();
      sourceStatesById.set(source.id, {
        sourceId: source.id,
        sourceName: source.name,
        sourceKey,
        signature,
        state: "failed",
        toolCount: previous?.toolCount ?? 0,
        processedTools: 0,
        message: "Failed",
        error: message,
        startedAt,
        updatedAt: failedAt,
      });
      warnings.push(`Source '${source.name}': ${message}`);
      await persistSourceStates(ctx, workspaceId, sourceStatesById.values());
      continue;
    }

    keepHeartbeatRunning = false;
    await heartbeat;

    if (!loaded.artifact) {
      const message = loaded.warnings[0] ?? `No tools generated for source '${source.name}'`;
      const failedAt = Date.now();
      sourceStatesById.set(source.id, {
        sourceId: source.id,
        sourceName: source.name,
        sourceKey,
        signature,
        state: "failed",
        toolCount: previous?.toolCount ?? 0,
        processedTools: 0,
        message: "Failed",
        error: message,
        startedAt,
        updatedAt: failedAt,
      });
      warnings.push(`Source '${source.name}': ${message}`);
      await persistSourceStates(ctx, workspaceId, sourceStatesById.values());
      continue;
    }
    warnings.push(...loaded.warnings);

    const serializedTools = loaded.artifact.tools;
    const entries = registryWriteEntriesFromSerializedTools(serializedTools);

    sourceStatesById.set(source.id, {
      sourceId: source.id,
      sourceName: source.name,
      sourceKey,
      signature,
      state: "indexing",
      toolCount: entries.length,
      processedTools: 0,
      message: `Indexing 0/${entries.length} tools`,
      startedAt,
      updatedAt: Date.now(),
    });
    await persistSourceStates(ctx, workspaceId, sourceStatesById.values());

    if (previous?.sourceKey && previous.sourceKey !== sourceKey) {
      await ctx.runAction(internal.toolRegistry.deleteToolsBySource, {
        workspaceId,
        source: previous.sourceKey,
      });
    }

    await ctx.runAction(internal.toolRegistry.deleteToolsBySource, {
      workspaceId,
      source: sourceKey,
    });

    const TOOL_BATCH = 100;
    let processedTools = 0;
    for (let i = 0; i < entries.length; i += TOOL_BATCH) {
      await ctx.runMutation(internal.toolRegistry.putToolsBatch, {
        workspaceId,
        tools: entries.slice(i, i + TOOL_BATCH),
      });

      processedTools = Math.min(entries.length, processedTools + TOOL_BATCH);
      sourceStatesById.set(source.id, {
        sourceId: source.id,
        sourceName: source.name,
        sourceKey,
        signature,
        state: "indexing",
        toolCount: entries.length,
        processedTools,
        message: `Indexing ${processedTools}/${entries.length} tools`,
        startedAt,
        updatedAt: Date.now(),
      });
      await persistSourceStates(ctx, workspaceId, sourceStatesById.values());
    }

    const sourceQuality = source.type === "openapi"
      ? computeOpenApiSourceQualityFromSerializedTools(serializedTools)[sourceKey]
      : undefined;
    const openApiRefHints = buildBoundedOpenApiRefHintTables([loaded.artifact])[0]?.refs;
    const completedAt = Date.now();
    sourceStatesById.set(source.id, {
      sourceId: source.id,
      sourceName: source.name,
      sourceKey,
      signature,
      state: "ready",
      toolCount: entries.length,
      processedTools: entries.length,
      message: "Ready",
      startedAt,
      completedAt,
      updatedAt: completedAt,
      ...(sourceQuality ? { sourceQuality } : {}),
      ...(openApiRefHints ? { openApiRefHints } : {}),
    });
    await persistSourceStates(ctx, workspaceId, sourceStatesById.values());
  }

  const allRegistryEntries = await listAllRegistryEntries(ctx, workspaceId);
  await rebuildNamespaceSummaries(ctx, workspaceId, allRegistryEntries);

  const serializedTools = await listAllSerializedTools(ctx, workspaceId);
  const hydratedTools = rehydrateTools(serializedTools, baseTools);
  const merged = mergeTools(hydratedTools);
  const typeBundle = buildWorkspaceTypeBundle({
    tools: [...merged.values()],
    openApiDtsBySource: {},
  });

  let typesStorageId: Id<"_storage"> | undefined;
  try {
    typesStorageId = await ctx.storage.store(new Blob([typeBundle], { type: "text/plain" }));
  } catch {
    typesStorageId = undefined;
  }

  const sourceToolCountsByName = new Map<string, number>();
  for (const source of sources) {
    sourceToolCountsByName.set(source.name, 0);
  }
  for (const entry of allRegistryEntries) {
    const sourceName = toSourceName(entry.source);
    if (!sourceName) {
      continue;
    }
    sourceToolCountsByName.set(sourceName, (sourceToolCountsByName.get(sourceName) ?? 0) + 1);
  }

  const sourceStates = toSourceStateRows(sourceStatesById.values());
  const sourceQuality = sourceStates
    .filter((state): state is MaterializedSourceStateRecord & { sourceQuality: OpenApiSourceQuality } => Boolean(state.sourceQuality))
    .map((state) => state.sourceQuality);
  const openApiRefHintTables = sourceStates
    .filter((state): state is MaterializedSourceStateRecord & { openApiRefHints: Array<{ key: string; hint: string }> } => (
      Array.isArray(state.openApiRefHints) && state.openApiRefHints.length > 0
    ))
    .map((state) => ({
      sourceKey: state.sourceKey,
      refs: state.openApiRefHints,
    }));

  await ctx.runMutation(internal.toolRegistry.updateRegistryMetadata, {
    workspaceId,
    typesStorageId,
    warnings,
    toolCount: baseTools.size + allRegistryEntries.length,
    sourceToolCounts: [...sourceToolCountsByName.entries()].map(([sourceName, toolCount]) => ({
      sourceName,
      toolCount,
    })),
    sourceQuality,
    sourceAuthProfiles: Object.entries(computeSourceAuthProfilesFromSources(sources)).map(([sourceKey, profile]) => ({
      sourceKey,
      type: profile.type,
      mode: profile.mode,
      header: profile.header,
      inferred: profile.inferred,
    })),
    openApiRefHintTables,
  } as never);

  await persistSourceStates(
    ctx,
    workspaceId,
    sourceStatesById.values(),
    registrySignatureForWorkspace(workspaceId, sources),
  );
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

export type ToolSourceGenerationState = "queued" | "loading" | "indexing" | "ready" | "failed";

export interface ToolSourceGenerationStatus {
  state: ToolSourceGenerationState;
  toolCount: number;
  processedTools?: number;
  message?: string;
  error?: string;
  updatedAt?: number;
}

export interface WorkspaceInventoryProgress {
  inventoryStatus: ToolInventoryStatus;
  warnings: string[];
  sourceStates: Record<string, ToolSourceGenerationStatus>;
  reactiveKey: string;
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

type WorkspaceRegistryStateRecord = {
  signature?: string;
  lastRefreshError?: string;
  typesStorageId?: Id<"_storage">;
  warnings?: string[];
  toolCount?: number;
  sourceToolCounts?: Array<{ sourceName: string; toolCount: number }>;
  sourceStates?: Array<{
    sourceId: string;
    sourceName: string;
    sourceKey: string;
    signature: string;
    state: "queued" | "loading" | "indexing" | "ready" | "failed";
    toolCount: number;
    processedTools?: number;
    message?: string;
    error?: string;
    startedAt?: number;
    completedAt?: number;
    updatedAt: number;
    sourceQuality?: OpenApiSourceQuality;
    openApiRefHints?: Array<{ key: string; hint: string }>;
  }>;
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
} | null;

type WorkspaceSourceStateRow = NonNullable<Exclude<WorkspaceRegistryStateRecord, null>["sourceStates"]>[number];

function toSourceStateRecord(
  items: Exclude<WorkspaceRegistryStateRecord, null>["sourceStates"] | undefined,
): WorkspaceSourceStateRow[] {
  const result: WorkspaceSourceStateRow[] = [];
  for (const item of items ?? []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const state = (item as { state?: unknown }).state;
    if (
      state !== "queued"
      && state !== "loading"
      && state !== "indexing"
      && state !== "ready"
      && state !== "failed"
    ) {
      continue;
    }
    const sourceId = (item as { sourceId?: unknown }).sourceId;
    const sourceName = (item as { sourceName?: unknown }).sourceName;
    const sourceKey = (item as { sourceKey?: unknown }).sourceKey;
    const signature = (item as { signature?: unknown }).signature;
    const toolCount = (item as { toolCount?: unknown }).toolCount;
    const updatedAt = (item as { updatedAt?: unknown }).updatedAt;
    if (
      typeof sourceId !== "string"
      || typeof sourceName !== "string"
      || typeof sourceKey !== "string"
      || typeof signature !== "string"
      || typeof toolCount !== "number"
      || typeof updatedAt !== "number"
    ) {
      continue;
    }

    result.push(item as WorkspaceSourceStateRow);
  }

  return result;
}

function computeWorkspaceInventoryProgress(
  workspaceId: Id<"workspaces">,
  sources: ToolSourceRecord[],
  registryState: WorkspaceRegistryStateRecord,
): WorkspaceInventoryProgress {
  const expectedRegistrySignature = registrySignatureForWorkspace(workspaceId, sources);
  const isFresh = Boolean(registryState?.signature && registryState.signature === expectedRegistrySignature);
  const sourceCounts = toSourceToolCountRecord(registryState?.sourceToolCounts ?? []);
  const sourceStateById = new Map(toSourceStateRecord(registryState?.sourceStates).map((sourceState) => [sourceState.sourceId, sourceState]));

  const loadingSourceNames: string[] = [];
  const sourceStates: Record<string, ToolSourceGenerationStatus> = {};
  let failedSourceError: string | undefined;

  for (const source of sources) {
    const sourceState = sourceStateById.get(source.id);
    const expectedSourceSignature = registrySignatureForWorkspace(workspaceId, [{
      id: source.id,
      updatedAt: source.updatedAt,
      enabled: source.enabled,
    }]);

    const status = sourceState
      ? sourceState.state
      : "queued";
    const signatureMismatch = !sourceState || sourceState.signature !== expectedSourceSignature;
    const sourceStateValue: ToolSourceGenerationState = signatureMismatch
      ? "queued"
      : status;

    if (sourceStateValue === "queued" || sourceStateValue === "loading" || sourceStateValue === "indexing") {
      loadingSourceNames.push(source.name);
    }

    if (!failedSourceError && sourceStateValue === "failed" && sourceState?.error) {
      failedSourceError = sourceState.error;
    }

    sourceStates[source.name] = {
      state: sourceStateValue,
      toolCount: sourceState?.toolCount ?? sourceCounts[source.name] ?? 0,
      ...(typeof sourceState?.processedTools === "number" ? { processedTools: sourceState.processedTools } : {}),
      ...(
        typeof sourceState?.message === "string"
          ? { message: sourceState.message }
          : sourceStateValue === "queued"
            ? { message: "Queued" }
            : {}
      ),
      ...(sourceState?.error ? { error: sourceState.error } : {}),
      ...(typeof sourceState?.updatedAt === "number" ? { updatedAt: sourceState.updatedAt } : {}),
    };
  }

  let state: ToolInventoryState;
  if (loadingSourceNames.length > 0 && (registryState?.toolCount ?? 0) > 0) {
    state = "rebuilding";
  } else if (loadingSourceNames.length > 0) {
    state = "initializing";
  } else if (failedSourceError || registryState?.lastRefreshError) {
    state = "failed";
  } else if (isFresh) {
    state = "ready";
  } else {
    state = "ready";
  }

  const warnings = [...(registryState?.warnings ?? [])];
  for (const [sourceName, sourceStatus] of Object.entries(sourceStates)) {
    if (sourceStatus.state === "failed" && sourceStatus.error) {
      warnings.push(`Source '${sourceName}' failed: ${sourceStatus.error}`);
      continue;
    }
  }
  if (state === "failed" && registryState?.lastRefreshError) {
    warnings.push(`Tool inventory refresh failed: ${registryState.lastRefreshError}`);
  }

  const inventoryStatus: ToolInventoryStatus = {
    state,
    readyToolCount: registryState?.toolCount ?? 0,
    loadingSourceNames,
    sourceToolCounts: {
      ...sourceCounts,
      // Ensure system tools are always visible even for pre-existing registry states.
      system: sourceCounts["system"] ?? baseTools.size,
    },
    ...(failedSourceError || registryState?.lastRefreshError
      ? { error: failedSourceError ?? registryState?.lastRefreshError }
      : {}),
    updatedAt: registryState?.updatedAt,
  };

  const sourceTokens = Object.entries(sourceStates)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, item]) => `${name}:${item.state}:${item.toolCount}:${item.processedTools ?? 0}:${item.error ?? ""}`)
    .join(",");

  const reactiveKey = [
    inventoryStatus.state,
    String(inventoryStatus.updatedAt ?? 0),
    sourceTokens,
  ].join("|");

  return {
    inventoryStatus,
    warnings,
    sourceStates,
    reactiveKey,
  };
}

export async function getWorkspaceInventoryProgressForContext(
  ctx: QueryRunnerCtx,
  workspaceId: Id<"workspaces">,
): Promise<WorkspaceInventoryProgress> {
  const [sources, registryState, policies] = await Promise.all([
    listWorkspaceToolSources(ctx, workspaceId),
    ctx.runQuery(internal.toolRegistry.getState, { workspaceId }),
    // Read policies so Convex tracks this reactive dependency — any policy
    // change will invalidate the query and produce a new reactiveKey, which
    // in turn causes the client-side TanStack query to re-fetch tool data.
    listWorkspaceToolPolicies(ctx, workspaceId),
  ]);

  const progress = computeWorkspaceInventoryProgress(
    workspaceId,
    sources.filter((source: ToolSourceRecord) => source.enabled),
    registryState,
  );

  // Append a lightweight policy fingerprint so the reactive key changes
  // whenever any policy is created, updated, or deleted.
  const policyToken = policies
    .map((p: ToolPolicyRecord) => `${p.id}:${p.effect}:${p.approvalMode}:${p.resourcePattern}:${p.priority}`)
    .sort()
    .join(",");

  return {
    ...progress,
    reactiveKey: `${progress.reactiveKey}|p:${policyToken}`,
  };
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
    fetchAll?: boolean;
  } = {},
): Promise<WorkspaceRegistryReadResult> {
  const sources = (await listWorkspaceToolSources(ctx, workspaceId))
    .filter((source: ToolSourceRecord) => source.enabled);

  const registryState = await ctx.runQuery(internal.toolRegistry.getState, {
    workspaceId,
  });

  const progress = computeWorkspaceInventoryProgress(workspaceId, sources, registryState);
  const sourceCounts = progress.inventoryStatus.sourceToolCounts;
  const sourceQuality = toSourceQualityRecord(registryState?.sourceQuality ?? []);
  const sourceAuthProfiles = toSourceAuthProfileRecord(registryState?.sourceAuthProfiles ?? []);
  const openApiRefHintLookup = toOpenApiRefHintLookup(registryState?.openApiRefHintTables ?? []);
  const warnings = [...progress.warnings];
  const scopedSourceName = options.sourceName ?? toSourceName(options.source) ?? undefined;
  const sourceKeyFilter = options.source?.trim()
    || (scopedSourceName
      ? (() => {
        const source = sources.find((item) => item.name === scopedSourceName);
        return source ? sourceStateSourceKey(source) : undefined;
      })()
      : undefined);
  const allSourceNames = sources.map((source) => source.name);
  const relevantSourceNames = scopedSourceName
    ? allSourceNames.filter((name) => name === scopedSourceName)
    : allSourceNames;
  const baseLoadingSourceSet = new Set(progress.inventoryStatus.loadingSourceNames);

  const loadingSourceNames = scopedSourceName
    ? (baseLoadingSourceSet.has(scopedSourceName) ? [scopedSourceName] : [])
    : progress.inventoryStatus.loadingSourceNames;

  const inventoryStatus: ToolInventoryStatus = {
    ...progress.inventoryStatus,
    loadingSourceNames,
  };

  const totalTools = scopedSourceName
    ? (sourceCounts[scopedSourceName] ?? 0)
    : inventoryStatus.readyToolCount;

  const registryTools: RegistryToolEntry[] = [];
  const requestedPaths = [...new Set((options.toolPaths ?? []).map((path) => path.trim()).filter((path) => path.length > 0))];
  let nextCursor: string | null | undefined;

  if (requestedPaths.length > 0) {
    const entries = await Promise.all(requestedPaths.map(async (path) => {
      const entry = await ctx.runQuery(internal.toolRegistry.getToolByPath, {
        workspaceId,
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
        } = sourceKeyFilter
            ? await ctx.runQuery(internal.toolRegistry.listToolsBySourcePage, {
              workspaceId,
              source: sourceKeyFilter,
              cursor,
              limit: 100,
            })
            : await ctx.runQuery(internal.toolRegistry.listToolsPage, {
              workspaceId,
              cursor,
              limit: 100,
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
      } = sourceKeyFilter
          ? await ctx.runQuery(internal.toolRegistry.listToolsBySourcePage, {
            workspaceId,
            source: sourceKeyFilter,
            cursor: options.cursor,
            limit: Math.max(1, Math.min(250, Math.floor(options.limit ?? 100))),
          })
          : await ctx.runQuery(internal.toolRegistry.listToolsPage, {
            workspaceId,
            cursor: options.cursor,
            limit: Math.max(1, Math.min(250, Math.floor(options.limit ?? 100))),
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
    fetchAll?: boolean;
  } = {},
): Promise<WorkspaceToolInventory> {
  const requestedPaths = [...new Set((options.toolPaths ?? [])
    .map((path) => path.trim())
    .filter((path) => path.length > 0))];
  const boundedRequestedPaths = requestedPaths.slice(0, MAX_TOOL_DETAILS_LOOKUP_PATHS);
  const includeDetailsRequested = options.includeDetails ?? false;
  const includeDetails = includeDetailsRequested && boundedRequestedPaths.length > 0;
  const includeSourceMeta = options.includeSourceMeta ?? true;
  const [result, policies] = await Promise.all([
    getWorkspaceToolsFromRegistry(ctx, context.workspaceId, {
      toolPaths: boundedRequestedPaths,
      source: options.source,
      sourceName: options.sourceName,
      cursor: options.cursor,
      limit: options.limit,
      fetchAll: options.fetchAll,
    }),
    listWorkspaceToolPolicies(ctx, context.workspaceId, context.accountId),
  ]);

  const warnings = [...result.warnings];
  if (includeDetailsRequested && requestedPaths.length === 0) {
    warnings.push("Detailed tool signatures are only available for targeted tool path lookups.");
  }
  if (requestedPaths.length > MAX_TOOL_DETAILS_LOOKUP_PATHS) {
    warnings.push(
      `Tool detail lookup capped to ${MAX_TOOL_DETAILS_LOOKUP_PATHS} tool paths per request (requested ${requestedPaths.length}).`,
    );
  }

  const includeBaseTools = options.source || options.sourceName
    ? false
    : boundedRequestedPaths.length > 0
      ? true
      : Boolean(options.fetchAll || !options.cursor);
  const baseDescriptors = includeBaseTools
    ? listVisibleToolDescriptors(baseTools, context, policies, {
      includeDetails,
      toolPaths: boundedRequestedPaths,
    })
    : [];
  const registryDescriptors = listVisibleRegistryToolDescriptors(result.registryTools, context, policies, {
    includeDetails,
    toolPaths: boundedRequestedPaths,
    openApiRefHintLookup: result.openApiRefHintLookup,
  });
  const toolsByPath = new Map<string, ToolDescriptor>();
  for (const tool of baseDescriptors) toolsByPath.set(tool.path, tool);
  for (const tool of registryDescriptors) {
    if (baseTools.has(tool.path)) continue;
    toolsByPath.set(tool.path, tool);
  }
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

  const { tools: boundedTools, warnings: boundedWarnings } = truncateToolsForActionResult(tools, warnings);

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
  } = {},
): Promise<ToolDescriptor[]> {
  const inventory = await loadWorkspaceToolInventoryForContext(ctx, context, {
    ...options,
    includeDetails: options.includeDetails ?? true,
    includeSourceMeta: options.includeSourceMeta ?? false,
    fetchAll: true,
  });
  return inventory.tools;
}

export async function listToolDetailsForContext(
  ctx: QueryRunnerCtx,
  context: { workspaceId: Id<"workspaces">; accountId?: Id<"accounts">; clientId?: string },
  options: { toolPaths?: string[] } = {},
): Promise<Record<string, ToolDetailDescriptor>> {
  const requestedPaths = [...new Set((options.toolPaths ?? [])
    .map((path) => path.trim())
    .filter((path) => path.length > 0))];
  if (requestedPaths.length === 0) {
    return {};
  }
  const boundedRequestedPaths = requestedPaths.slice(0, MAX_TOOL_DETAILS_LOOKUP_PATHS);

  const [registryState, policies] = await Promise.all([
    ctx.runQuery(internal.toolRegistry.getState, {
      workspaceId: context.workspaceId,
    }),
    listWorkspaceToolPolicies(ctx, context.workspaceId, context.accountId),
  ]);

  const result: Record<string, ToolDetailDescriptor> = {};
  const policyContext = {
    workspaceId: context.workspaceId,
    accountId: context.accountId,
    clientId: context.clientId,
  };

  const basePaths = boundedRequestedPaths.filter((path) => baseTools.has(path));
  if (basePaths.length > 0) {
    const baseDescriptors = listVisibleToolDescriptors(baseTools, policyContext, policies, {
      includeDetails: true,
      toolPaths: basePaths,
    });

    for (const descriptor of baseDescriptors) {
      result[descriptor.path] = toToolDetailDescriptor(descriptor);
    }
  }

  const openApiRefHintLookup = toOpenApiRefHintLookup(registryState?.openApiRefHintTables ?? []);
  const registryPaths = boundedRequestedPaths.filter((path) => !baseTools.has(path));
  const entries = await Promise.all(registryPaths.map((path) =>
    ctx.runQuery(internal.toolRegistry.getToolByPath, {
      workspaceId: context.workspaceId,
      path,
    })
  ));

  for (const entry of entries) {
    if (!entry) {
      continue;
    }

    const decision = getDecisionForContext(entry, policyContext, policies);
    if (decision === "deny") {
      continue;
    }

    const descriptor = toDescriptorFromRegistryEntry(
      {
        path: entry.path,
        preferredPath: entry.preferredPath,
        aliases: entry.aliases,
        description: entry.description,
        approval: decision === "require_approval" ? "required" : "auto",
        source: entry.source,
        displayInput: entry.displayInput,
        displayOutput: entry.displayOutput,
        requiredInputKeys: entry.requiredInputKeys,
        previewInputKeys: entry.previewInputKeys,
        serializedToolJson: entry.serializedToolJson,
        typedRef: entry.typedRef,
      },
      {
        includeDetails: true,
        openApiRefHintLookup,
      },
    );

    result[descriptor.path] = toToolDetailDescriptor(descriptor);
  }

  return result;
}

export async function rebuildWorkspaceToolInventoryForContext(
  ctx: ActionCtx,
  context: { workspaceId: Id<"workspaces">; accountId?: Id<"accounts">; clientId?: string },
): Promise<{ rebuilt: boolean }> {
  try {
    await refreshWorkspaceToolRegistryIncremental(ctx, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.runMutation(internal.toolRegistry.setRefreshError, {
      workspaceId: context.workspaceId,
      error: message,
    });
    throw error;
  }

  return { rebuilt: true };
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
