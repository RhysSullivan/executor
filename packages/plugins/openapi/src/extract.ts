import type { OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { Effect, Option } from "effect";

import { OpenApiExtractionError } from "./errors";
import type { DereferencedDocument } from "./parse";
import {
  ExtractedOperation,
  ExtractionResult,
  type HttpMethod,
  OperationId,
  OperationParameter,
  OperationRequestBody,
  type ParameterLocation,
  ServerInfo,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HTTP_METHODS: readonly HttpMethod[] = [
  "get", "put", "post", "delete", "patch", "head", "options", "trace",
];

const VALID_PARAM_LOCATIONS = new Set<string>(["path", "query", "header", "cookie"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ParameterObject = OpenAPIV3.ParameterObject | OpenAPIV3_1.ParameterObject;
type OperationObject = OpenAPIV3.OperationObject | OpenAPIV3_1.OperationObject;
type PathItemObject = OpenAPIV3.PathItemObject | OpenAPIV3_1.PathItemObject;
type RequestBodyObject = OpenAPIV3.RequestBodyObject | OpenAPIV3_1.RequestBodyObject;
type MediaTypeObject = OpenAPIV3.MediaTypeObject | OpenAPIV3_1.MediaTypeObject;

/** After dereferencing, $ref objects are resolved — this narrows the type */
const isResolved = <T>(value: T | OpenAPIV3.ReferenceObject | OpenAPIV3_1.ReferenceObject): value is T =>
  typeof value === "object" && value !== null && !("$ref" in value);

/** Pick the preferred media type entry (prefer application/json) */
const preferredContent = (
  content: Record<string, MediaTypeObject> | undefined,
): { mediaType: string; media: MediaTypeObject } | undefined => {
  if (!content) return undefined;
  const entries = Object.entries(content);
  const pick =
    entries.find(([mt]) => mt === "application/json") ??
    entries.find(([mt]) => mt.toLowerCase().includes("+json")) ??
    entries.find(([mt]) => mt.toLowerCase().includes("json")) ??
    entries[0];

  return pick ? { mediaType: pick[0], media: pick[1] } : undefined;
};

// ---------------------------------------------------------------------------
// Parameter extraction
// ---------------------------------------------------------------------------

const extractParameters = (
  pathItem: PathItemObject,
  operation: OperationObject,
): OperationParameter[] => {
  // Operation parameters override path-level ones by name+location
  const merged = new Map<string, ParameterObject>();

  for (const raw of pathItem.parameters ?? []) {
    if (!isResolved(raw)) continue;
    merged.set(`${raw.in}:${raw.name}`, raw);
  }
  for (const raw of operation.parameters ?? []) {
    if (!isResolved(raw)) continue;
    merged.set(`${raw.in}:${raw.name}`, raw);
  }

  return [...merged.values()]
    .filter((p) => VALID_PARAM_LOCATIONS.has(p.in))
    .map(
      (p) =>
        new OperationParameter({
          name: p.name,
          location: p.in as ParameterLocation,
          required: p.in === "path" ? true : p.required === true,
          schema: Option.fromNullable(p.schema),
          style: Option.fromNullable(p.style),
          explode: Option.fromNullable(p.explode),
          allowReserved: Option.fromNullable(
            "allowReserved" in p ? p.allowReserved : undefined,
          ),
          description: Option.fromNullable(p.description),
        }),
    );
};

// ---------------------------------------------------------------------------
// Request body extraction
// ---------------------------------------------------------------------------

const extractRequestBody = (
  operation: OperationObject,
): OperationRequestBody | undefined => {
  const body = operation.requestBody;
  if (!body || !isResolved<RequestBodyObject>(body)) return undefined;

  const content = preferredContent(body.content);
  if (!content) return undefined;

  return new OperationRequestBody({
    required: body.required === true,
    contentType: content.mediaType,
    schema: Option.fromNullable(content.media.schema),
  });
};

// ---------------------------------------------------------------------------
// Response schema extraction
// ---------------------------------------------------------------------------

const extractOutputSchema = (
  operation: OperationObject,
): unknown | undefined => {
  const responses = operation.responses;
  if (!responses) return undefined;

  // Prefer 2xx responses, then default
  const entries = Object.entries(responses);
  const preferred = [
    ...entries.filter(([s]) => /^2\d\d$/.test(s)).sort(([a], [b]) => a.localeCompare(b)),
    ...entries.filter(([s]) => s === "default"),
  ];

  for (const [, respValue] of preferred) {
    if (!isResolved(respValue)) continue;
    const content = preferredContent(
      (respValue as OpenAPIV3.ResponseObject).content,
    );
    if (content?.media.schema) return content.media.schema;
  }

  return undefined;
};

// ---------------------------------------------------------------------------
// Input schema builder
// ---------------------------------------------------------------------------

const buildInputSchema = (
  parameters: readonly OperationParameter[],
  requestBody: OperationRequestBody | undefined,
): Record<string, unknown> | undefined => {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of parameters) {
    properties[param.name] = Option.getOrElse(param.schema, () => ({ type: "string" }));
    if (param.required) required.push(param.name);
  }

  if (requestBody) {
    properties.body = Option.getOrElse(requestBody.schema, () => ({ type: "object" }));
    if (requestBody.required) required.push("body");
  }

  if (Object.keys(properties).length === 0) return undefined;

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
};

// ---------------------------------------------------------------------------
// Operation ID derivation
// ---------------------------------------------------------------------------

const deriveOperationId = (
  method: HttpMethod,
  pathTemplate: string,
  operation: OperationObject,
): string =>
  operation.operationId ??
  (`${method}_${pathTemplate.replace(/[^a-zA-Z0-9]+/g, "_")}`.replace(
    /^_+|_+$/g,
    "",
  ) || `${method}_operation`);

// ---------------------------------------------------------------------------
// Server extraction
// ---------------------------------------------------------------------------

const extractServers = (doc: DereferencedDocument): ServerInfo[] =>
  (doc.servers ?? []).flatMap((server) => {
    if (!server.url) return [];
    const variables = server.variables
      ? Object.fromEntries(
          Object.entries(server.variables).flatMap(([name, v]) =>
            v.default ? [[name, v.default]] : [],
          ),
        )
      : undefined;
    return [
      new ServerInfo({
        url: server.url,
        variables:
          variables && Object.keys(variables).length > 0
            ? Option.some(variables)
            : Option.none(),
      }),
    ];
  });

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

/** Extract all operations from a dereferenced OpenAPI 3.x document */
export const extract = Effect.fn("OpenApi.extract")(function* (
  doc: DereferencedDocument,
) {
  const paths = doc.paths;
  if (!paths) {
    return yield* new OpenApiExtractionError({
      message: "OpenAPI document has no paths defined",
    });
  }

  const operations: ExtractedOperation[] = [];

  for (const [pathTemplate, pathItem] of Object.entries(paths).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    if (!pathItem) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const parameters = extractParameters(pathItem, operation);
      const requestBody = extractRequestBody(operation);
      const inputSchema = buildInputSchema(parameters, requestBody);
      const outputSchema = extractOutputSchema(operation);
      const tags = (operation.tags ?? []).filter((t) => t.trim().length > 0);

      operations.push(
        new ExtractedOperation({
          operationId: OperationId.make(
            deriveOperationId(method, pathTemplate, operation),
          ),
          method,
          pathTemplate,
          summary: Option.fromNullable(operation.summary),
          description: Option.fromNullable(operation.description),
          tags,
          parameters,
          requestBody: Option.fromNullable(requestBody),
          inputSchema: Option.fromNullable(inputSchema),
          outputSchema: Option.fromNullable(outputSchema),
          deprecated: operation.deprecated === true,
        }),
      );
    }
  }

  return new ExtractionResult({
    title: Option.fromNullable(doc.info?.title),
    version: Option.fromNullable(doc.info?.version),
    servers: extractServers(doc),
    operations,
  });
});
