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
import { asRecord } from "../utils";
import type { SerializedTool } from "../tool/source-serialization";

type OpenApiOperationParameter = {
  name: string;
  in: string;
  required: boolean;
  schema: Record<string, unknown>;
};

function buildOpenApiOperationParameters(
  sharedParameters: Array<Record<string, unknown>>,
  operation: Record<string, unknown>,
): OpenApiOperationParameter[] {
  return [
    ...sharedParameters,
    ...(Array.isArray(operation.parameters)
      ? (operation.parameters as Array<Record<string, unknown>>)
      : []),
  ].map((entry) => ({
    name: String(entry.name ?? ""),
    in: String(entry.in ?? "query"),
    required: Boolean(entry.required),
    schema: asRecord(entry.schema),
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
  const paths = asRecord(prepared.paths);
  const tools: ToolDefinition[] = [];

  const methods = ["get", "post", "put", "delete", "patch", "head", "options"] as const;
  const readMethods = new Set(["get", "head", "options"]);
  const usedToolPaths = new Set<string>();

  for (const [pathTemplate, pathValue] of Object.entries(paths)) {
    const pathObject = asRecord(pathValue);
    const sharedParameters = Array.isArray(pathObject.parameters)
      ? (pathObject.parameters as Array<Record<string, unknown>>)
      : [];

    for (const method of methods) {
      const operation = asRecord(pathObject[method]);
      if (Object.keys(operation).length === 0) continue;

      const tags = Array.isArray(operation.tags) ? (operation.tags as unknown[]) : [];
      const tagRaw = String(tags[0] ?? "default");
      const operationIdRaw = String(operation.operationId ?? `${method}_${pathTemplate}`);
      const parameters = buildOpenApiOperationParameters(sharedParameters, operation);

      const inputSchema = asRecord(operation._inputSchema);
      const outputSchema = asRecord(operation._outputSchema);
      const requiredInputKeys = extractTopLevelRequiredKeys(inputSchema);
      const previewInputKeys = Array.isArray(operation._previewInputKeys)
        ? operation._previewInputKeys.filter((value): value is string => typeof value === "string")
        : buildPreviewKeys(inputSchema);

      const typedRef: ToolTypedRef = {
        kind: "openapi_operation",
        sourceKey: sourceLabel,
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
          ...(requiredInputKeys.length > 0 ? { requiredInputKeys } : {}),
          ...(previewInputKeys.length > 0 ? { previewInputKeys } : {}),
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
