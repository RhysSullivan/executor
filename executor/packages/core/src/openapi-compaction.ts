import { z } from "zod";
import {
  buildComponentRefHintTable,
  buildOpenApiArgPreviewKeys,
  buildOpenApiInputSchema,
  buildOpenApiRequiredInputKeys,
  collectComponentRefKeys,
  getPreferredContentSchema,
  getPreferredResponseSchema,
  parameterSchemaFromEntry,
  resolveRequestBodyRef,
  resolveResponseRef,
  resolveSchemaRef,
  type OpenApiParameterHint,
} from "./openapi/schema-hints";
import {
  compactArgTypeHintFromSchema,
  compactReturnTypeHintFromSchema,
} from "./type-hints";
import { toPlainObject } from "./utils";

function toRecordOrEmpty(value: unknown): Record<string, unknown> {
  return toPlainObject(value) ?? {};
}

const openApiParameterEntrySchema = z.object({
  name: z.string(),
  in: z.string(),
  required: z.boolean().optional(),
  description: z.string().optional(),
  deprecated: z.boolean().optional(),
  style: z.string().optional(),
  explode: z.boolean().optional(),
  allowReserved: z.boolean().optional(),
  example: z.unknown().optional(),
  examples: z.record(z.unknown()).optional(),
}).passthrough();

export interface CompactOpenApiPathsOptions {
  includeSchemas?: boolean;
  includeTypeHints?: boolean;
  includeParameterSchemas?: boolean;
  resolveSchemaRefs?: boolean;
}

export function compactOpenApiPaths(
  pathsValue: unknown,
  operationTypeIds: Set<string>,
  componentParameters?: Record<string, unknown>,
  componentSchemas?: Record<string, unknown>,
  componentResponses?: Record<string, unknown>,
  componentRequestBodies?: Record<string, unknown>,
  options: CompactOpenApiPathsOptions = {},
): { paths: Record<string, unknown>; refHintTable: Record<string, string> } {
  const paths = toRecordOrEmpty(pathsValue);
  const methods = ["get", "post", "put", "delete", "patch", "head", "options"] as const;
  const compactPaths: Record<string, unknown> = {};
  const compParams = componentParameters ? toRecordOrEmpty(componentParameters) : {};
  const compSchemas = componentSchemas ? toRecordOrEmpty(componentSchemas) : {};
  const compResponses = componentResponses ? toRecordOrEmpty(componentResponses) : {};
  const compRequestBodies = componentRequestBodies ? toRecordOrEmpty(componentRequestBodies) : {};
  const includeSchemas = options.includeSchemas ?? true;
  const includeTypeHints = options.includeTypeHints ?? true;
  const includeParameterSchemas = options.includeParameterSchemas ?? true;
  const resolveSchemaRefs = options.resolveSchemaRefs ?? true;
  const referencedComponentRefKeys = new Set<string>();

  const resolveParam = (entry: Record<string, unknown>): Record<string, unknown> => {
    if (typeof entry.$ref === "string") {
      const ref = entry.$ref;
      const prefix = "#/components/parameters/";
      if (ref.startsWith(prefix)) {
        const key = ref.slice(prefix.length);
        const resolved = toRecordOrEmpty(compParams[key]);
        if (Object.keys(resolved).length > 0) return resolved;
      }
    }
    return entry;
  };

  const normalizeParameters = (entries: unknown): OpenApiParameterHint[] => {
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry) => resolveParam(toRecordOrEmpty(entry)))
      .map((entry) => {
        const parsed = openApiParameterEntrySchema.safeParse(entry);
        if (!parsed.success) return null;

        const location = parsed.data.in.trim();
        const description = (parsed.data.description ?? "").trim();
        const style = (parsed.data.style ?? "").trim();
        const parsedExamples = parsed.data.examples
          ? toRecordOrEmpty(parsed.data.examples)
          : undefined;

        return {
          name: parsed.data.name,
          in: location,
          required: location === "path" ? true : (parsed.data.required ?? false),
          schema: includeParameterSchemas ? parameterSchemaFromEntry(entry) : {},
          ...(description.length > 0 ? { description } : {}),
          ...(parsed.data.deprecated !== undefined ? { deprecated: parsed.data.deprecated } : {}),
          ...(style.length > 0 ? { style } : {}),
          ...(parsed.data.explode !== undefined ? { explode: parsed.data.explode } : {}),
          ...(parsed.data.allowReserved !== undefined ? { allowReserved: parsed.data.allowReserved } : {}),
          ...(parsed.data.example !== undefined ? { example: parsed.data.example } : {}),
          ...(parsedExamples && Object.keys(parsedExamples).length > 0 ? { examples: parsedExamples } : {}),
        } satisfies OpenApiParameterHint;
      })
      .filter((entry): entry is OpenApiParameterHint => Boolean(entry));
  };

  for (const [pathTemplate, pathValue] of Object.entries(paths)) {
    const pathObject = toRecordOrEmpty(pathValue);
    const compactPathObject: Record<string, unknown> = {};
    const sharedParameters = normalizeParameters(pathObject.parameters);
    if (sharedParameters.length > 0) {
      compactPathObject.parameters = sharedParameters;
    }

    for (const method of methods) {
      const operation = toRecordOrEmpty(pathObject[method]);
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
      const requestBody = resolveRequestBodyRef(toRecordOrEmpty(operation.requestBody), compRequestBodies);
      const requestBodyRequired = Boolean(requestBody.required);
      const shouldBuildSchemas = includeSchemas || hasGeneratedTypes || !resolveSchemaRefs;
      // Always attempt to compute minimal input/output schemas. This keeps the
      // prepared spec compact while enabling schema-first tool signatures.
      if (shouldBuildSchemas) {
        const requestBodyContent = toRecordOrEmpty(requestBody.content);
        const rawRequestBodySchema = getPreferredContentSchema(requestBodyContent);
        requestBodySchema = resolveSchemaRefs
          ? resolveSchemaRef(rawRequestBodySchema, compSchemas)
          : toRecordOrEmpty(rawRequestBodySchema);

        const responses = toRecordOrEmpty(operation.responses);
        for (const [status, responseValue] of Object.entries(responses)) {
          if (!status.startsWith("2")) continue;
          responseStatus = status;
          const resolvedResponse = resolveResponseRef(toRecordOrEmpty(responseValue), compResponses);
          const rawResponseSchema = getPreferredResponseSchema(resolvedResponse);
          responseSchema = resolveSchemaRefs
            ? resolveSchemaRef(rawResponseSchema, compSchemas)
            : toRecordOrEmpty(rawResponseSchema);
          if (Object.keys(responseSchema).length > 0) break;
        }
      }

      const mergedParameters = normalizeParameters(operation.parameters).concat(sharedParameters);
      const hasInputSchema = mergedParameters.length > 0 || Object.keys(requestBodySchema).length > 0;
      if (hasInputSchema) {
        compactOperation._inputSchema = buildOpenApiInputSchema(mergedParameters, requestBodySchema, {
          requestBodyRequired,
        });
      }
      if (Object.keys(responseSchema).length > 0 || responseStatus) {
        compactOperation._outputSchema = responseSchema;
        if (responseStatus) {
          compactOperation._successStatus = responseStatus;
        }
      }

      const componentRefKeys = collectComponentRefKeys(
        [compactOperation._inputSchema, compactOperation._outputSchema],
        compSchemas,
      );
      if (componentRefKeys.length > 0) {
        compactOperation._refHintKeys = componentRefKeys;
        for (const key of componentRefKeys) {
          referencedComponentRefKeys.add(key);
        }
      }

      const previewKeys = buildOpenApiArgPreviewKeys(mergedParameters, requestBodySchema, compSchemas);
      if (previewKeys.length > 0) {
        compactOperation._previewInputKeys = [...new Set(previewKeys)];
      }

      const requiredInputKeys = buildOpenApiRequiredInputKeys(
        mergedParameters,
        requestBodySchema,
        compSchemas,
        requestBodyRequired,
      );
      if (requiredInputKeys.length > 0) {
        compactOperation._requiredInputKeys = [...new Set(requiredInputKeys)];
      }

      if (hasGeneratedTypes) {
        // Keep a low-cost type hint string for optional UI usage.
        // NOTE: Not required for the schema-first agent signature.
        if (compactOperation._inputSchema) {
          compactOperation._argsTypeHint = compactArgTypeHintFromSchema(
            toRecordOrEmpty(compactOperation._inputSchema),
            compSchemas,
          );
        } else {
          compactOperation._argsTypeHint = "{}";
        }
        compactOperation._returnsTypeHint = compactReturnTypeHintFromSchema(responseSchema, responseStatus, compSchemas);
      }

      compactPathObject[method] = compactOperation;
    }

    if (Object.keys(compactPathObject).length > 0) {
      compactPaths[pathTemplate] = compactPathObject;
    }
  }

  return {
    paths: compactPaths,
    refHintTable: buildComponentRefHintTable(referencedComponentRefKeys, compSchemas),
  };
}
