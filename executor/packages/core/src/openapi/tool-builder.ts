import { z } from "zod";
import {
  buildOpenApiArgPreviewKeys,
  buildOpenApiInputSchema,
  getPreferredContentSchema,
  getPreferredResponseSchema,
  jsonSchemaTypeHintFallback,
  responseTypeHintFromSchema,
} from "./schema-hints";
import { buildOpenApiToolPath } from "./tool-path";
import { buildCredentialSpec, buildStaticAuthHeaders, getCredentialSourceKey } from "../tool/source-auth";
import { executeOpenApiRequest } from "../tool/source-execution";
import type { OpenApiToolSourceConfig, PreparedOpenApiSpec } from "../tool/source-types";
import type { ToolDefinition } from "../types";
import type { ToolTypedRef } from "../types";
import { buildPreviewKeys, extractTopLevelRequiredKeys } from "../tool-typing/schema-utils";
import { toPlainObject } from "../utils";
import type { SerializedTool } from "../tool/source-serialization";

type OpenApiOperationParameter = {
  name: string;
  in: string;
  required: boolean;
  schema: Record<string, unknown>;
};

const stringArraySchema = z.array(z.string());
const nonEmptyTrimmedStringSchema = z.string().transform((value) => value.trim()).refine((value) => value.length > 0);

function toRecordOrEmpty(value: unknown): Record<string, unknown> {
  return toPlainObject(value) ?? {};
}

function parseNonEmptyTrimmedString(value: unknown): string | undefined {
  const parsed = nonEmptyTrimmedStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseHintKeys(value: unknown): string[] {
  const parsed = stringArraySchema.safeParse(value);
  if (!parsed.success) return [];

  return [...new Set(parsed.data
    .map((key) => key.trim())
    .filter((key) => key.length > 0))];
}

function toRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];

  const entries: Array<Record<string, unknown>> = [];
  for (const item of value) {
    const record = toPlainObject(item);
    if (record) {
      entries.push(record);
    }
  }
  return entries;
}

function buildOpenApiOperationParameters(
  sharedParameters: Array<Record<string, unknown>>,
  operation: Record<string, unknown>,
): OpenApiOperationParameter[] {
  return [
    ...sharedParameters,
    ...toRecordArray(operation.parameters),
  ].map((entry) => ({
    name: String(entry.name ?? ""),
    in: String(entry.in ?? "query"),
    required: Boolean(entry.required),
    schema: toRecordOrEmpty(entry.schema),
  }));
}

export function buildOpenApiToolsFromPrepared(
  config: OpenApiToolSourceConfig,
  prepared: PreparedOpenApiSpec,
): ToolDefinition[] {
  const baseUrl = config.baseUrl ?? prepared.servers[0] ?? "";
  if (!baseUrl) {
    throw new Error(`OpenAPI source ${config.name} has no base URL (set baseUrl)`);
  }

  const effectiveAuth = config.auth ?? prepared.inferredAuth;
  const authHeaders = buildStaticAuthHeaders(effectiveAuth);
  const sourceLabel = `openapi:${config.name}`;
  const credentialSourceKey = getCredentialSourceKey(config);
  const credentialSpec = buildCredentialSpec(credentialSourceKey, effectiveAuth);
  const sourceRefHintTable = toRecordOrEmpty(prepared.refHintTable);
  const paths = toRecordOrEmpty(prepared.paths);
  const tools: ToolDefinition[] = [];

  const methods = ["get", "post", "put", "delete", "patch", "head", "options"] as const;
  const readMethods = new Set(["get", "head", "options"]);
  const usedToolPaths = new Set<string>();

  for (const [pathTemplate, pathValue] of Object.entries(paths)) {
    const pathObject = toRecordOrEmpty(pathValue);
    const sharedParameters = toRecordArray(pathObject.parameters);

    for (const method of methods) {
      const operation = toRecordOrEmpty(pathObject[method]);
      if (Object.keys(operation).length === 0) continue;

      const tags = Array.isArray(operation.tags) ? operation.tags : [];
      const tagRaw = String(tags[0] ?? "default");
      const operationIdRaw = String(operation.operationId ?? `${method}_${pathTemplate}`);
      const parameters = buildOpenApiOperationParameters(sharedParameters, operation);

      const inputSchema = toRecordOrEmpty(operation._inputSchema);
      const outputSchema = toRecordOrEmpty(operation._outputSchema);
      const inputHint = parseNonEmptyTrimmedString(operation._argsTypeHint);
      const outputHint = parseNonEmptyTrimmedString(operation._returnsTypeHint);
      const refHintKeys = parseHintKeys(operation._refHintKeys)
        .filter((key) => typeof sourceRefHintTable[key] === "string");
      const requiredInputKeys = extractTopLevelRequiredKeys(inputSchema);
      const parsedPreviewInputKeys = stringArraySchema.safeParse(operation._previewInputKeys);
      const previewInputKeys = parsedPreviewInputKeys.success
        ? parsedPreviewInputKeys.data
        : buildPreviewKeys(inputSchema);

      const typedRef: ToolTypedRef = {
        kind: "openapi_operation",
        sourceKey: config.sourceKey ?? sourceLabel,
        operationId: operationIdRaw,
      };

      const approval = config.overrides?.[operationIdRaw]?.approval
        ?? (readMethods.has(method)
          ? config.defaultReadApproval ?? "auto"
          : config.defaultWriteApproval ?? "required");

      const runSpec: SerializedTool["runSpec"] = {
        kind: "openapi",
        baseUrl,
        method,
        pathTemplate,
        parameters,
        authHeaders,
      };

      const tool: ToolDefinition & { _runSpec: SerializedTool["runSpec"] } = {
        path: buildOpenApiToolPath(config.name, tagRaw, operationIdRaw, usedToolPaths),
        source: sourceLabel,
        approval,
        description: String(operation.summary ?? operation.description ?? `${method.toUpperCase()} ${pathTemplate}`),
        typing: {
          ...(Object.keys(inputSchema).length > 0 ? { inputSchema } : {}),
          ...(Object.keys(outputSchema).length > 0 ? { outputSchema } : {}),
          ...(inputHint ? { inputHint } : {}),
          ...(outputHint ? { outputHint } : {}),
          ...(requiredInputKeys.length > 0 ? { requiredInputKeys } : {}),
          ...(previewInputKeys.length > 0 ? { previewInputKeys } : {}),
          ...(refHintKeys.length > 0 ? { refHintKeys } : {}),
          typedRef,
        },
        credential: credentialSpec,
        _runSpec: runSpec,
        run: async (input: unknown, context) => {
          return await executeOpenApiRequest(runSpec, input, context.credential?.headers);
        },
      };
      tools.push(tool);
    }
  }

  return tools;
}
