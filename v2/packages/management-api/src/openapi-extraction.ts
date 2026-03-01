import { createHash } from "node:crypto";

import {
  ToolArtifactStoreError,
  type ToolArtifactStore,
} from "@executor-v2/persistence-ports";
import {
  OPEN_API_HTTP_METHODS,
  OPEN_API_PARAMETER_LOCATIONS,
  OpenApiExtractedToolSchema,
  OpenApiInvocationPayloadSchema,
  OpenApiToolManifestSchema,
  OpenApiToolParameterSchema,
  OpenApiToolRequestBodySchema,
  ToolArtifactIdSchema,
  type DiscoveryTypingPayload,
  type OpenApiExtractedTool,
  type OpenApiHttpMethod,
  type OpenApiInvocationPayload,
  type OpenApiToolManifest,
  type OpenApiToolParameter,
  type OpenApiToolRequestBody,
  type Source,
  type ToolArtifact,
} from "@executor-v2/schema";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

const HTTP_METHODS = OPEN_API_HTTP_METHODS;

type HttpMethod = OpenApiHttpMethod;

type OpenApiExtractionStage =
  | "validate"
  | "extract"
  | "encode_manifest";

export class OpenApiExtractionError extends Data.TaggedError("OpenApiExtractionError")<{
  sourceName: string;
  stage: OpenApiExtractionStage;
  message: string;
  details: string | null;
}> {}

const ExtractedToolParameterSchema = OpenApiToolParameterSchema;
const ExtractedToolRequestBodySchema = OpenApiToolRequestBodySchema;
const ExtractedToolInvocationSchema = OpenApiInvocationPayloadSchema;
const ExtractedToolSchema = OpenApiExtractedToolSchema;
const ToolManifestSchema = OpenApiToolManifestSchema;

type ExtractedToolParameter = OpenApiToolParameter;
type ExtractedToolRequestBody = OpenApiToolRequestBody;
type ExtractedToolInvocation = OpenApiInvocationPayload;
type ExtractedTool = OpenApiExtractedTool;
type ToolManifest = OpenApiToolManifest;
type DiscoveryTyping = DiscoveryTypingPayload;

const ToolManifestFromJsonSchema = Schema.parseJson(ToolManifestSchema);
const encodeManifestToJson = Schema.encode(ToolManifestFromJsonSchema);
const decodeToolArtifactId = Schema.decodeUnknownSync(ToolArtifactIdSchema);

export type ToolManifestDiff = {
  added: Array<string>;
  changed: Array<string>;
  removed: Array<string>;
  unchangedCount: number;
};

export type RefreshOpenApiArtifactResult = {
  artifact: ToolArtifact;
  manifest: ToolManifest;
  diff: ToolManifestDiff;
  reused: boolean;
};

type RefreshOpenApiArtifactInput = {
  source: Source;
  openApiSpec: unknown;
  artifactStore: ToolArtifactStore;
  now?: () => number;
};

const UnknownRecordSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

type UnknownRecord = typeof UnknownRecordSchema.Type;

const isUnknownRecord = Schema.is(UnknownRecordSchema);

const OpenApiParameterInputSchema = Schema.Struct({
  name: Schema.String,
  in: Schema.Literal(...OPEN_API_PARAMETER_LOCATIONS),
  required: Schema.optional(Schema.Boolean),
});

type OpenApiParameterInput = typeof OpenApiParameterInputSchema.Type;

const isOpenApiParameterInput = Schema.is(OpenApiParameterInputSchema);

const OpenApiRequestBodyInputSchema = Schema.Struct({
  required: Schema.optional(Schema.Boolean),
  content: Schema.optional(UnknownRecordSchema),
});

type OpenApiRequestBodyInput = typeof OpenApiRequestBodyInputSchema.Type;

const isOpenApiRequestBodyInput = Schema.is(OpenApiRequestBodyInputSchema);

const toExtractedToolParameter = (
  value: unknown,
): ExtractedToolParameter | null => {
  if (!isOpenApiParameterInput(value)) {
    return null;
  }

  const parameter: OpenApiParameterInput = value;
  const name = parameter.name.trim();

  if (name.length === 0) {
    return null;
  }

  return {
    name,
    location: parameter.in,
    required: parameter.in === "path" || parameter.required === true,
  };
};

const mergeParameters = (
  pathItem: UnknownRecord,
  operation: UnknownRecord,
): Array<ExtractedToolParameter> => {
  const byKey = new Map<string, ExtractedToolParameter>();

  const addParameters = (candidate: unknown) => {
    if (!Array.isArray(candidate)) {
      return;
    }

    for (const item of candidate) {
      const parameter = toExtractedToolParameter(item);
      if (!parameter) {
        continue;
      }
      byKey.set(`${parameter.location}:${parameter.name}`, parameter);
    }
  };

  addParameters(pathItem.parameters);
  addParameters(operation.parameters);

  return Array.from(byKey.values()).sort((left, right) => {
    if (left.location === right.location) {
      return left.name.localeCompare(right.name);
    }

    return left.location.localeCompare(right.location);
  });
};

const extractRequestBody = (
  operation: UnknownRecord,
): ExtractedToolRequestBody | null => {
  const requestBody = operation.requestBody;

  if (!isOpenApiRequestBodyInput(requestBody)) {
    return null;
  }

  const openApiRequestBody: OpenApiRequestBodyInput = requestBody;
  const contentTypes = openApiRequestBody.content
    ? Object.keys(openApiRequestBody.content).sort()
    : [];

  return {
    required: openApiRequestBody.required === true,
    contentTypes,
  };
};

const buildInvocationMetadata = (
  method: HttpMethod,
  pathValue: string,
  pathItem: UnknownRecord,
  operation: UnknownRecord,
): ExtractedToolInvocation => ({
  method,
  pathTemplate: pathValue,
  parameters: mergeParameters(pathItem, operation),
  requestBody: extractRequestBody(operation),
});

const collectRefKeys = (value: unknown, refs: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefKeys(item, refs);
    }
    return;
  }

  if (!isUnknownRecord(value)) {
    return;
  }

  const reference = value.$ref;
  if (typeof reference === "string" && reference.startsWith("#/")) {
    refs.add(reference);
  }

  for (const nestedValue of Object.values(value)) {
    collectRefKeys(nestedValue, refs);
  }
};

const resolveJsonPointer = (
  root: UnknownRecord,
  pointer: string,
): unknown | null => {
  if (!pointer.startsWith("#/")) {
    return null;
  }

  const parts = pointer
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));

  let current: unknown = root;

  for (const part of parts) {
    if (!isUnknownRecord(current)) {
      return null;
    }

    current = current[part];
    if (current === undefined) {
      return null;
    }
  }

  return current;
};

const pickSchemaFromContent = (content: unknown): unknown | null => {
  if (!isUnknownRecord(content)) {
    return null;
  }

  const preferred = ["application/json", ...Object.keys(content).sort()];
  const seen = new Set<string>();

  for (const mediaType of preferred) {
    if (seen.has(mediaType)) {
      continue;
    }
    seen.add(mediaType);

    const mediaTypeValue = content[mediaType];
    if (!isUnknownRecord(mediaTypeValue)) {
      continue;
    }

    if (mediaTypeValue.schema !== undefined) {
      return mediaTypeValue.schema;
    }
  }

  return null;
};

const extractRequestBodySchema = (operation: UnknownRecord): unknown | null => {
  const requestBody = operation.requestBody;
  if (!isOpenApiRequestBodyInput(requestBody)) {
    return null;
  }

  return pickSchemaFromContent(requestBody.content);
};

const responseStatusRank = (statusCode: string): number => {
  if (/^2\d\d$/.test(statusCode)) {
    return 0;
  }

  if (statusCode === "default") {
    return 1;
  }

  return 2;
};

const extractResponseSchema = (operation: UnknownRecord): unknown | null => {
  if (!isUnknownRecord(operation.responses)) {
    return null;
  }

  const responseCodes = Object.keys(operation.responses).sort(
    (left, right) => responseStatusRank(left) - responseStatusRank(right),
  );

  for (const responseCode of responseCodes) {
    const response = operation.responses[responseCode];
    if (!isUnknownRecord(response)) {
      continue;
    }

    const schema = pickSchemaFromContent(response.content);
    if (schema !== null) {
      return schema;
    }
  }

  return null;
};

const collectParameterSchemaByKey = (
  pathItem: UnknownRecord,
  operation: UnknownRecord,
): Map<string, unknown> => {
  const schemasByKey = new Map<string, unknown>();

  const addParameters = (candidate: unknown) => {
    if (!Array.isArray(candidate)) {
      return;
    }

    for (const item of candidate) {
      if (!isUnknownRecord(item)) {
        continue;
      }

      const parameter = toExtractedToolParameter(item);
      if (!parameter || item.schema === undefined) {
        continue;
      }

      schemasByKey.set(`${parameter.location}:${parameter.name}`, item.schema);
    }
  };

  addParameters(pathItem.parameters);
  addParameters(operation.parameters);

  return schemasByKey;
};

const buildInputSchema = (
  pathItem: UnknownRecord,
  operation: UnknownRecord,
  invocation: ExtractedToolInvocation,
): unknown | null => {
  const parameterSchemaByKey = collectParameterSchemaByKey(pathItem, operation);

  const properties: Record<string, unknown> = {};
  const required = new Set<string>();

  for (const parameter of invocation.parameters) {
    const key = `${parameter.location}:${parameter.name}`;
    properties[parameter.name] = parameterSchemaByKey.get(key) ?? { type: "string" };
    if (parameter.required) {
      required.add(parameter.name);
    }
  }

  const requestBodySchema = extractRequestBodySchema(operation);
  if (requestBodySchema !== null) {
    properties.body = requestBodySchema;
    if (invocation.requestBody?.required) {
      required.add("body");
    }
  }

  if (Object.keys(properties).length === 0) {
    return null;
  }

  return {
    type: "object",
    properties,
    required: [...required].sort(),
    additionalProperties: false,
  };
};

const encodeStableJson = (value: unknown): string =>
  JSON.stringify(toStableValue(value));

const buildToolTyping = (
  pathItem: UnknownRecord,
  operation: UnknownRecord,
  invocation: ExtractedToolInvocation,
): DiscoveryTyping | undefined => {
  const inputSchema = buildInputSchema(pathItem, operation, invocation);
  const outputSchema = extractResponseSchema(operation);

  if (inputSchema === null && outputSchema === null) {
    return undefined;
  }

  const refs = new Set<string>();
  if (inputSchema !== null) {
    collectRefKeys(inputSchema, refs);
  }

  if (outputSchema !== null) {
    collectRefKeys(outputSchema, refs);
  }

  const refHintKeys = [...refs].sort();

  return {
    inputSchemaJson: inputSchema ? encodeStableJson(inputSchema) : undefined,
    outputSchemaJson: outputSchema ? encodeStableJson(outputSchema) : undefined,
    refHintKeys: refHintKeys.length > 0 ? refHintKeys : undefined,
  };
};

const buildRefHintTable = (
  openApiSpec: UnknownRecord,
  initialRefKeys: ReadonlyArray<string>,
): Record<string, string> => {
  const queue = [...new Set(initialRefKeys)];
  const seen = new Set<string>();
  const table: Record<string, string> = {};

  while (queue.length > 0) {
    const refKey = queue.shift();
    if (!refKey || seen.has(refKey)) {
      continue;
    }

    seen.add(refKey);

    const resolved = resolveJsonPointer(openApiSpec, refKey);
    if (resolved === null) {
      continue;
    }

    table[refKey] = encodeStableJson(resolved);

    const nested = new Set<string>();
    collectRefKeys(resolved, nested);
    for (const nestedRef of nested) {
      if (!seen.has(nestedRef)) {
        queue.push(nestedRef);
      }
    }
  }

  return table;
};

const toStableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(toStableValue);
  }

  if (isUnknownRecord(value)) {
    const stableRecord: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      stableRecord[key] = toStableValue(value[key]);
    }
    return stableRecord;
  }

  return value;
};

const hashUnknown = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(toStableValue(value))).digest("hex");

const normalizePathForToolId = (pathValue: string): string =>
  pathValue
    .trim()
    .replace(/^\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "root";

const buildToolId = (
  method: HttpMethod,
  pathValue: string,
  operation: Record<string, unknown>,
): string => {
  const operationId = operation.operationId;
  if (typeof operationId === "string" && operationId.trim().length > 0) {
    return operationId.trim();
  }

  return `${method}_${normalizePathForToolId(pathValue)}`;
};

const buildToolName = (
  method: HttpMethod,
  pathValue: string,
  operation: Record<string, unknown>,
): string => {
  const summary = operation.summary;
  if (typeof summary === "string" && summary.trim().length > 0) {
    return summary.trim();
  }

  const operationId = operation.operationId;
  if (typeof operationId === "string" && operationId.trim().length > 0) {
    return operationId.trim();
  }

  return `${method.toUpperCase()} ${pathValue}`;
};

const buildToolDescription = (operation: Record<string, unknown>): string | null => {
  const description = operation.description;
  if (typeof description === "string" && description.trim().length > 0) {
    return description.trim();
  }

  const summary = operation.summary;
  if (typeof summary === "string" && summary.trim().length > 0) {
    return summary.trim();
  }

  return null;
};

const ensureUniqueToolIds = (
  sourceName: string,
  tools: ReadonlyArray<ExtractedTool>,
): Effect.Effect<void, OpenApiExtractionError> =>
  Effect.gen(function* () {
    const seenToolIds = new Set<string>();

    for (const tool of tools) {
      if (seenToolIds.has(tool.toolId)) {
        return yield* new OpenApiExtractionError({
          sourceName,
          stage: "extract",
          message: `Duplicate toolId detected: ${tool.toolId}`,
          details: `${tool.method.toUpperCase()} ${tool.path}`,
        });
      }

      seenToolIds.add(tool.toolId);
    }
  });

const toExtractionError = (
  sourceName: string,
  stage: OpenApiExtractionStage,
  cause: unknown,
): OpenApiExtractionError =>
  cause instanceof OpenApiExtractionError
    ? cause
    : new OpenApiExtractionError({
        sourceName,
        stage,
        message: "OpenAPI extraction failed",
        details: ParseResult.isParseError(cause)
          ? ParseResult.TreeFormatter.formatErrorSync(cause)
          : String(cause),
      });

export const extractOpenApiManifest = (
  sourceName: string,
  openApiSpec: unknown,
): Effect.Effect<ToolManifest, OpenApiExtractionError> =>
  Effect.gen(function* () {
    if (!isUnknownRecord(openApiSpec)) {
      return yield* new OpenApiExtractionError({
        sourceName,
        stage: "validate",
        message: "OpenAPI spec must be an object",
        details: null,
      });
    }

    const specRecord: UnknownRecord = openApiSpec;
    const pathsValue = specRecord.paths;
    if (!isUnknownRecord(pathsValue)) {
      return {
        version: 1 as const,
        sourceHash: hashUnknown(specRecord),
        tools: [],
      };
    }

    const tools: Array<ExtractedTool> = [];

    for (const pathValue of Object.keys(pathsValue).sort()) {
      const pathItem = pathsValue[pathValue];
      if (!isUnknownRecord(pathItem)) {
        continue;
      }

      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (!isUnknownRecord(operation)) {
          continue;
        }

        const invocation = buildInvocationMetadata(
          method,
          pathValue,
          pathItem,
          operation,
        );
        const typing = buildToolTyping(pathItem, operation, invocation);

        tools.push({
          toolId: buildToolId(method, pathValue, operation),
          name: buildToolName(method, pathValue, operation),
          description: buildToolDescription(operation),
          method,
          path: pathValue,
          invocation,
          operationHash: hashUnknown({
            method,
            path: pathValue,
            operation,
            invocation,
          }),
          typing,
        });
      }
    }

    tools.sort((left, right) => left.toolId.localeCompare(right.toolId));
    yield* ensureUniqueToolIds(sourceName, tools);

    const directRefKeys = tools.flatMap(
      (tool) => tool.typing?.refHintKeys ?? [],
    );
    const refHintTable = buildRefHintTable(specRecord, directRefKeys);

    return {
      version: 1 as const,
      sourceHash: hashUnknown(openApiSpec),
      tools,
      refHintTable: Object.keys(refHintTable).length > 0 ? refHintTable : undefined,
    };
  }).pipe(Effect.mapError((cause) => toExtractionError(sourceName, "extract", cause)));

const makeToolArtifactId = (source: Source): ToolArtifact["id"] =>
  decodeToolArtifactId(`tool_artifact_${source.id}`);

const diffForReusedManifest = (manifest: ToolManifest): ToolManifestDiff => ({
  added: [],
  changed: [],
  removed: [],
  unchangedCount: manifest.tools.length,
});

const diffForReplacedManifest = (manifest: ToolManifest): ToolManifestDiff => ({
  added: manifest.tools.map((tool) => tool.toolId),
  changed: [],
  removed: [],
  unchangedCount: 0,
});

export const refreshOpenApiArtifact = (
  input: RefreshOpenApiArtifactInput,
): Effect.Effect<RefreshOpenApiArtifactResult, ToolArtifactStoreError | OpenApiExtractionError> =>
  Effect.gen(function* () {
    const now = input.now ?? Date.now;

    const manifest = yield* extractOpenApiManifest(input.source.name, input.openApiSpec);
    const existingArtifactOption = yield* input.artifactStore.getBySource(
      input.source.workspaceId,
      input.source.id,
    );

    const existingArtifact = Option.getOrUndefined(existingArtifactOption);

    if (existingArtifact && existingArtifact.sourceHash === manifest.sourceHash) {
      return {
        artifact: existingArtifact,
        manifest,
        diff: diffForReusedManifest(manifest),
        reused: true,
      };
    }

    const currentTime = now();
    const manifestJson = yield* pipe(
      encodeManifestToJson(manifest),
      Effect.mapError((cause) =>
        toExtractionError(input.source.name, "encode_manifest", cause),
      ),
    );

    const nextArtifact: ToolArtifact = {
      id: existingArtifact?.id ?? makeToolArtifactId(input.source),
      workspaceId: input.source.workspaceId,
      sourceId: input.source.id,
      sourceHash: manifest.sourceHash,
      toolCount: manifest.tools.length,
      manifestJson,
      createdAt: existingArtifact?.createdAt ?? currentTime,
      updatedAt: currentTime,
    };

    yield* input.artifactStore.upsert(nextArtifact);

    return {
      artifact: nextArtifact,
      manifest,
      diff: diffForReplacedManifest(manifest),
      reused: false,
    };
  });
