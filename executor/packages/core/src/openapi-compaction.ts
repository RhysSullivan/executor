import {
  buildOpenApiArgPreviewKeys,
  buildOpenApiInputSchema,
  getPreferredContentSchema,
  getPreferredResponseSchema,
  jsonSchemaTypeHintFallback,
  parameterSchemaFromEntry,
  resolveRequestBodyRef,
  resolveResponseRef,
  resolveSchemaRef,
  responseTypeHintFromSchema,
  type OpenApiParameterHint,
} from "./openapi/schema-hints";
import { asRecord } from "./utils";

export interface CompactOpenApiPathsOptions {
  includeSchemas?: boolean;
  includeTypeHints?: boolean;
  includeParameterSchemas?: boolean;
}

export function compactOpenApiPaths(
  pathsValue: unknown,
  operationTypeIds: Set<string>,
  componentParameters?: Record<string, unknown>,
  componentSchemas?: Record<string, unknown>,
  componentResponses?: Record<string, unknown>,
  componentRequestBodies?: Record<string, unknown>,
  options: CompactOpenApiPathsOptions = {},
): Record<string, unknown> {
  const paths = asRecord(pathsValue);
  const methods = ["get", "post", "put", "delete", "patch", "head", "options"] as const;
  const compactPaths: Record<string, unknown> = {};
  const compParams = componentParameters ? asRecord(componentParameters) : {};
  const compSchemas = componentSchemas ? asRecord(componentSchemas) : {};
  const compResponses = componentResponses ? asRecord(componentResponses) : {};
  const compRequestBodies = componentRequestBodies ? asRecord(componentRequestBodies) : {};
  const includeSchemas = options.includeSchemas ?? true;
  const includeTypeHints = options.includeTypeHints ?? true;
  const includeParameterSchemas = options.includeParameterSchemas ?? true;

  const resolveParam = (entry: Record<string, unknown>): Record<string, unknown> => {
    if (typeof entry.$ref === "string") {
      const ref = entry.$ref;
      const prefix = "#/components/parameters/";
      if (ref.startsWith(prefix)) {
        const key = ref.slice(prefix.length);
        const resolved = asRecord(compParams[key]);
        if (Object.keys(resolved).length > 0) return resolved;
      }
    }
    return entry;
  };

  const normalizeParameters = (entries: unknown): Array<OpenApiParameterHint & { in: string }> => {
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry) => resolveParam(asRecord(entry)))
      .filter((entry) => typeof entry.name === "string" && typeof entry.in === "string")
      .map((entry) => ({
        name: String(entry.name),
        in: String(entry.in),
        required: Boolean(entry.required),
        schema: includeParameterSchemas ? parameterSchemaFromEntry(entry) : {},
      }));
  };

  for (const [pathTemplate, pathValue] of Object.entries(paths)) {
    const pathObject = asRecord(pathValue);
    const compactPathObject: Record<string, unknown> = {};
    const sharedParameters = normalizeParameters(pathObject.parameters);
    if (sharedParameters.length > 0) {
      compactPathObject.parameters = sharedParameters;
    }

    for (const method of methods) {
      const operation = asRecord(pathObject[method]);
      if (Object.keys(operation).length === 0) continue;

      const operationIdRaw = String(operation.operationId ?? `${method}_${pathTemplate}`);
      const hasGeneratedTypes = includeTypeHints
        && (operationTypeIds.size === 0 || operationTypeIds.has(operationIdRaw));

      const compactOperation: Record<string, unknown> = {};
      if (Array.isArray(operation.tags) && operation.tags.length > 0) {
        compactOperation.tags = operation.tags;
      }
      if (operation.operationId !== undefined) {
        compactOperation.operationId = operationIdRaw;
      }
      if (typeof operation.summary === "string") {
        compactOperation.summary = operation.summary;
      }
      if (typeof operation.description === "string") {
        compactOperation.description = operation.description;
      }

      const operationParameters = normalizeParameters(operation.parameters);
      if (operationParameters.length > 0) {
        compactOperation.parameters = operationParameters;
      }

      let requestBodySchema: Record<string, unknown> = {};
      let responseSchema: Record<string, unknown> = {};
      let responseStatus = "";
      // Always attempt to compute minimal input/output schemas. This keeps the
      // prepared spec compact while enabling schema-first tool signatures.
      if (includeSchemas || hasGeneratedTypes) {
        const requestBody = resolveRequestBodyRef(asRecord(operation.requestBody), compRequestBodies);
        const requestBodyContent = asRecord(requestBody.content);
        const rawRequestBodySchema = getPreferredContentSchema(requestBodyContent);
        requestBodySchema = resolveSchemaRef(rawRequestBodySchema, compSchemas);

        const responses = asRecord(operation.responses);
        for (const [status, responseValue] of Object.entries(responses)) {
          if (!status.startsWith("2")) continue;
          responseStatus = status;
          const resolvedResponse = resolveResponseRef(asRecord(responseValue), compResponses);
          responseSchema = resolveSchemaRef(
            getPreferredResponseSchema(resolvedResponse),
            compSchemas,
          );
          if (Object.keys(responseSchema).length > 0) break;
        }
      }

      const mergedParameters = normalizeParameters(operation.parameters).concat(sharedParameters);
      const hasInputSchema = mergedParameters.length > 0 || Object.keys(requestBodySchema).length > 0;
      if (hasInputSchema) {
        compactOperation._inputSchema = buildOpenApiInputSchema(mergedParameters, requestBodySchema);
      }
      if (Object.keys(responseSchema).length > 0 || responseStatus) {
        compactOperation._outputSchema = responseSchema;
        if (responseStatus) {
          compactOperation._successStatus = responseStatus;
        }
      }

      const previewKeys = buildOpenApiArgPreviewKeys(mergedParameters, requestBodySchema, compSchemas);
      if (previewKeys.length > 0) {
        compactOperation._previewInputKeys = [...new Set(previewKeys)];
      }

      if (hasGeneratedTypes) {
        // Keep a low-cost type hint string for optional UI usage.
        // NOTE: Not required for the schema-first agent signature.
        if (compactOperation._inputSchema) {
          compactOperation._argsTypeHint = jsonSchemaTypeHintFallback(compactOperation._inputSchema, 0, compSchemas);
        } else {
          compactOperation._argsTypeHint = "{}";
        }
        compactOperation._returnsTypeHint = responseTypeHintFromSchema(responseSchema, responseStatus, compSchemas);
      }

      compactPathObject[method] = compactOperation;
    }

    if (Object.keys(compactPathObject).length > 0) {
      compactPaths[pathTemplate] = compactPathObject;
    }
  }

  return compactPaths;
}
