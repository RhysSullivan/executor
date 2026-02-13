import {
  buildOpenApiArgPreviewKeys,
  buildOpenApiInputSchema,
  getPreferredContentSchema,
  getPreferredResponseSchema,
  jsonSchemaTypeHintFallback,
  responseTypeHintFromSchema,
} from "./openapi-schema-hints";
import { buildOpenApiToolPath } from "./openapi-tool-path";
import { buildCredentialSpec, buildStaticAuthHeaders, getCredentialSourceKey } from "./tool-source-auth";
import { executeOpenApiRequest } from "./tool-source-execution";
import { compactArgDisplayHint, compactReturnTypeHint } from "./type-hints";
import type { OpenApiToolSourceConfig, PreparedOpenApiSpec } from "./tool-source-types";
import type { ToolDefinition } from "./types";
import { asRecord } from "./utils";
import type { SerializedTool } from "./tool-source-serialization";

type OpenApiOperationParameter = {
  name: string;
  in: string;
  required: boolean;
  schema: Record<string, unknown>;
};

type OpenApiOperationTypeHints = {
  argsType: string;
  returnsType: string;
  argPreviewKeys: string[];
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

function buildOpenApiOperationTypeHints(
  operation: Record<string, unknown>,
  parameters: OpenApiOperationParameter[],
): OpenApiOperationTypeHints {
  let argPreviewKeys: string[] = Array.isArray(operation._argPreviewKeys)
    ? operation._argPreviewKeys.filter((value): value is string => typeof value === "string")
    : [];

  if (typeof operation._argsTypeHint === "string" && typeof operation._returnsTypeHint === "string") {
    return {
      argsType: operation._argsTypeHint,
      returnsType: operation._returnsTypeHint,
      argPreviewKeys,
    };
  }

  const requestBody = asRecord(operation.requestBody);
  const requestBodyContent = asRecord(requestBody.content);
  const requestBodySchema = getPreferredContentSchema(requestBodyContent);

  const responses = asRecord(operation.responses);
  let responseSchema: Record<string, unknown> = {};
  let responseStatus = "";
  for (const [status, responseValue] of Object.entries(responses)) {
    if (!status.startsWith("2")) continue;
    responseSchema = getPreferredResponseSchema(asRecord(responseValue));
    responseStatus = status;
    if (Object.keys(responseSchema).length > 0) break;
  }

  const hasInputSchema = parameters.length > 0 || Object.keys(requestBodySchema).length > 0;
  const combinedSchema = buildOpenApiInputSchema(parameters, requestBodySchema);
  const argsType = hasInputSchema ? jsonSchemaTypeHintFallback(combinedSchema) : "{}";
  const returnsType = responseTypeHintFromSchema(responseSchema, responseStatus);
  if (argPreviewKeys.length === 0) {
    argPreviewKeys = buildOpenApiArgPreviewKeys(parameters, requestBodySchema);
  }

  return {
    argsType,
    returnsType,
    argPreviewKeys,
  };
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

  // The raw .d.ts is attached to the first tool only (one per source to avoid duplication).
  // The typechecker/Monaco use this directly via indexed access types.
  const sourceDts = prepared.dts
    ? prepared.dts.replace(/^export /gm, "")
    : undefined;
  let sourceDtsEmitted = false;

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

      const { argsType, returnsType, argPreviewKeys } = buildOpenApiOperationTypeHints(operation, parameters);

      const displayArgsType = compactArgDisplayHint(argsType, argPreviewKeys);
      const displayReturnsType = compactReturnTypeHint(returnsType);

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
        metadata: {
          argsType,
          returnsType,
          displayArgsType,
          displayReturnsType,
          ...(argPreviewKeys.length > 0 ? { argPreviewKeys } : {}),
          operationId: operationIdRaw,
          ...(sourceDts && !sourceDtsEmitted ? { sourceDts } : {}),
        },
        credential: credentialSpec,
        _runSpec: runSpec,
        run: async (input: unknown, context) => {
          return await executeOpenApiRequest(runSpec, input, context.credential?.headers);
        },
      };
      tools.push(tool);

      if (sourceDts && !sourceDtsEmitted) {
        sourceDtsEmitted = true;
      }
    }
  }

  return tools;
}
