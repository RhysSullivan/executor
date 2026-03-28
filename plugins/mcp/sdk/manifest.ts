import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ToolPath } from "@executor/codemode-core";

export type McpToolAnnotations = {
  title: string | null;
  readOnlyHint: boolean | null;
  destructiveHint: boolean | null;
  idempotentHint: boolean | null;
  openWorldHint: boolean | null;
};

export type McpToolExecution = {
  taskSupport: "forbidden" | "optional" | "required" | null;
};

export type McpServerInfo = {
  name: string;
  version: string;
  title: string | null;
  description: string | null;
  websiteUrl: string | null;
  icons: unknown[] | null;
};

export type McpServerCapabilities = {
  experimental: Record<string, unknown> | null;
  logging: boolean;
  completions: boolean;
  prompts: {
    listChanged: boolean;
  } | null;
  resources: {
    subscribe: boolean;
    listChanged: boolean;
  } | null;
  tools: {
    listChanged: boolean;
  } | null;
  tasks: {
    list: boolean;
    cancel: boolean;
    toolCall: boolean;
  } | null;
};

export type McpServerMetadata = {
  info: McpServerInfo | null;
  capabilities: McpServerCapabilities | null;
  instructions: string | null;
  rawInfo: unknown;
  rawCapabilities: unknown;
};

export type McpListToolsMetadata = {
  nextCursor: string | null;
  meta: unknown;
  rawResult: unknown;
};

export type McpToolManifestEntry = {
  toolId: string;
  toolName: string;
  description: string | null;
  title?: string | null;
  displayTitle?: string | null;
  annotations?: McpToolAnnotations | null;
  execution?: McpToolExecution | null;
  icons?: unknown[] | null;
  meta?: unknown;
  rawTool?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

export type McpToolManifest = {
  version: 2;
  server?: McpServerMetadata | null;
  listTools?: McpListToolsMetadata | null;
  tools: readonly McpToolManifestEntry[];
};

const sanitizeToolId = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length > 0 ? normalized : "tool";
};

const uniqueToolId = (value: string, byBase: Map<string, number>): string => {
  const base = sanitizeToolId(value);
  const count = (byBase.get(base) ?? 0) + 1;
  byBase.set(base, count);

  return count === 1 ? base : `${base}_${count}`;
};

const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asOptionalObject = (value: unknown): Record<string, unknown> | null => {
  const objectValue = asObject(value);
  return Object.keys(objectValue).length > 0 ? objectValue : null;
};

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const asBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const asUnknownArray = (value: unknown): unknown[] | null =>
  Array.isArray(value) ? value : null;

const ToolAnnotationsSchema = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  readOnlyHint: Schema.optional(Schema.Boolean),
  destructiveHint: Schema.optional(Schema.Boolean),
  idempotentHint: Schema.optional(Schema.Boolean),
  openWorldHint: Schema.optional(Schema.Boolean),
});

const ToolExecutionSchema = Schema.Struct({
  taskSupport: Schema.optional(
    Schema.Literal("forbidden", "optional", "required"),
  ),
});

const ListedMcpToolSchema = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  inputSchema: Schema.optional(Schema.Unknown),
  parameters: Schema.optional(Schema.Unknown),
  outputSchema: Schema.optional(Schema.Unknown),
  annotations: Schema.optional(ToolAnnotationsSchema),
  execution: Schema.optional(ToolExecutionSchema),
  icons: Schema.optional(Schema.Unknown),
  _meta: Schema.optional(Schema.Unknown),
});

const ListToolsResultSchema = Schema.Struct({
  tools: Schema.Array(ListedMcpToolSchema),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
  _meta: Schema.optional(Schema.Unknown),
});

const decodeListToolsResultOption = Schema.decodeUnknownOption(ListToolsResultSchema);

const readListedTools = (value: unknown): ReadonlyArray<typeof ListedMcpToolSchema.Type> => {
  const decoded = decodeListToolsResultOption(value);
  if (Option.isNone(decoded)) {
    return [];
  }

  return decoded.value.tools;
};

const normalizeToolAnnotations = (value: unknown): McpToolAnnotations | null => {
  const objectValue = asOptionalObject(value);
  if (objectValue === null) {
    return null;
  }

  const annotations = {
    title: asString(objectValue.title),
    readOnlyHint: asBoolean(objectValue.readOnlyHint),
    destructiveHint: asBoolean(objectValue.destructiveHint),
    idempotentHint: asBoolean(objectValue.idempotentHint),
    openWorldHint: asBoolean(objectValue.openWorldHint),
  } satisfies McpToolAnnotations;

  return Object.values(annotations).some((entry) => entry !== null)
    ? annotations
    : null;
};

const normalizeToolExecution = (value: unknown): McpToolExecution | null => {
  const objectValue = asOptionalObject(value);
  if (objectValue === null) {
    return null;
  }

  const taskSupport = objectValue.taskSupport;
  if (
    taskSupport !== "forbidden"
    && taskSupport !== "optional"
    && taskSupport !== "required"
  ) {
    return null;
  }

  return {
    taskSupport,
  };
};

const normalizeServerInfo = (value: unknown): McpServerInfo | null => {
  const objectValue = asOptionalObject(value);
  const name = objectValue ? asString(objectValue.name) : null;
  const version = objectValue ? asString(objectValue.version) : null;
  if (name === null || version === null) {
    return null;
  }

  return {
    name,
    version,
    title: asString(objectValue?.title),
    description: asString(objectValue?.description),
    websiteUrl: asString(objectValue?.websiteUrl),
    icons: asUnknownArray(objectValue?.icons),
  };
};

const normalizeServerCapabilities = (value: unknown): McpServerCapabilities | null => {
  const objectValue = asOptionalObject(value);
  if (objectValue === null) {
    return null;
  }

  const prompts = asObject(objectValue.prompts);
  const resources = asObject(objectValue.resources);
  const tools = asObject(objectValue.tools);
  const tasks = asObject(objectValue.tasks);
  const taskRequests = asObject(tasks.requests);
  const taskToolRequests = asObject(taskRequests.tools);

  return {
    experimental:
      hasOwn(objectValue, "experimental")
        ? asObject(objectValue.experimental)
        : null,
    logging: hasOwn(objectValue, "logging"),
    completions: hasOwn(objectValue, "completions"),
    prompts:
      !hasOwn(objectValue, "prompts")
        ? null
        : {
            listChanged: asBoolean(prompts.listChanged) ?? false,
          },
    resources:
      !hasOwn(objectValue, "resources")
        ? null
        : {
            subscribe: asBoolean(resources.subscribe) ?? false,
            listChanged: asBoolean(resources.listChanged) ?? false,
          },
    tools:
      !hasOwn(objectValue, "tools")
        ? null
        : {
            listChanged: asBoolean(tools.listChanged) ?? false,
          },
    tasks:
      !hasOwn(objectValue, "tasks")
        ? null
        : {
            list: hasOwn(tasks, "list"),
            cancel: hasOwn(tasks, "cancel"),
            toolCall: hasOwn(taskToolRequests, "call"),
          },
  };
};

const normalizeServerMetadata = (input?: {
  serverInfo?: unknown;
  serverCapabilities?: unknown;
  instructions?: string | null | undefined;
}): McpServerMetadata | null => {
  const info = normalizeServerInfo(input?.serverInfo);
  const capabilities = normalizeServerCapabilities(input?.serverCapabilities);
  const instructions = asString(input?.instructions);
  const rawInfo = input?.serverInfo ?? null;
  const rawCapabilities = input?.serverCapabilities ?? null;

  if (
    info === null
    && capabilities === null
    && instructions === null
    && rawInfo === null
    && rawCapabilities === null
  ) {
    return null;
  }

  return {
    info,
    capabilities,
    instructions,
    rawInfo,
    rawCapabilities,
  };
};

export const extractMcpToolManifestFromListToolsResult = (
  listToolsResult: unknown,
  metadata?: {
    serverInfo?: unknown;
    serverCapabilities?: unknown;
    instructions?: string | null | undefined;
  },
): McpToolManifest => {
  const byBase = new Map<string, number>();
  const rawListTools = asObject(listToolsResult);
  const rawListedTools = Array.isArray(rawListTools.tools) ? rawListTools.tools : [];

  const tools = readListedTools(listToolsResult)
    .map((tool, index): McpToolManifestEntry | null => {
      const toolName = tool.name.trim();
      if (toolName.length === 0) {
        return null;
      }

      const title = asString(tool.title);
      const annotations = normalizeToolAnnotations(tool.annotations);
      const displayTitle = title ?? annotations?.title ?? toolName;

      return {
        toolId: uniqueToolId(toolName, byBase),
        toolName,
        title,
        displayTitle,
        description: tool.description ?? null,
        annotations,
        execution: normalizeToolExecution(tool.execution),
        icons: asUnknownArray(tool.icons),
        meta: tool._meta ?? null,
        rawTool: rawListedTools[index] ?? null,
        inputSchema: tool.inputSchema ?? tool.parameters,
        outputSchema: tool.outputSchema,
      };
    })
    .filter((tool): tool is McpToolManifestEntry => tool !== null);

  return {
    version: 2,
    server: normalizeServerMetadata(metadata),
    listTools: {
      nextCursor: asString(rawListTools.nextCursor),
      meta: rawListTools._meta ?? null,
      rawResult: listToolsResult,
    },
    tools,
  };
};

export const joinToolPath = (namespace: string | undefined, toolId: string): ToolPath => {
  if (!namespace || namespace.trim().length === 0) {
    return toolId as ToolPath;
  }

  return `${namespace}.${toolId}` as ToolPath;
};
