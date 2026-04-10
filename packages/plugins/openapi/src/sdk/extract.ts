import { Effect, Option } from "effect";

import { OpenApiExtractionError } from "./errors";
import type { ParsedDocument } from "./parse";
import {
  DocResolver,
  preferredContent,
  type OperationObject,
  type ParameterObject,
  type PathItemObject,
  type RequestBodyObject,
  type ResponseObject,
} from "./openapi-utils";
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
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
];

const VALID_PARAM_LOCATIONS = new Set<string>(["path", "query", "header", "cookie"]);

// ---------------------------------------------------------------------------
// Parameter extraction
// ---------------------------------------------------------------------------

const extractParameters = (
  pathItem: PathItemObject,
  operation: OperationObject,
  r: DocResolver,
): OperationParameter[] => {
  const merged = new Map<string, ParameterObject>();

  for (const raw of pathItem.parameters ?? []) {
    const p = r.resolve<ParameterObject>(raw);
    if (!p) continue;
    merged.set(`${p.in}:${p.name}`, p);
  }
  for (const raw of operation.parameters ?? []) {
    const p = r.resolve<ParameterObject>(raw);
    if (!p) continue;
    merged.set(`${p.in}:${p.name}`, p);
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
          allowReserved: Option.fromNullable("allowReserved" in p ? p.allowReserved : undefined),
          description: Option.fromNullable(p.description),
        }),
    );
};

// ---------------------------------------------------------------------------
// Request body extraction
// ---------------------------------------------------------------------------

const extractRequestBody = (
  operation: OperationObject,
  r: DocResolver,
): OperationRequestBody | undefined => {
  if (!operation.requestBody) return undefined;

  const body = r.resolve<RequestBodyObject>(operation.requestBody);
  if (!body) return undefined;

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

const extractOutputSchema = (operation: OperationObject, r: DocResolver): unknown | undefined => {
  if (!operation.responses) return undefined;

  const entries = Object.entries(operation.responses);
  const preferred = [
    ...entries.filter(([s]) => /^2\d\d$/.test(s)).sort(([a], [b]) => a.localeCompare(b)),
    ...entries.filter(([s]) => s === "default"),
  ];

  for (const [, ref] of preferred) {
    const resp = r.resolve<ResponseObject>(ref);
    if (!resp) continue;
    const content = preferredContent(resp.content);
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
  (`${method}_${pathTemplate.replace(/[^a-zA-Z0-9]+/g, "_")}`.replace(/^_+|_+$/g, "") ||
    `${method}_operation`);

// ---------------------------------------------------------------------------
// Server extraction
// ---------------------------------------------------------------------------

const extractServers = (doc: ParsedDocument): ServerInfo[] =>
  (doc.servers ?? []).flatMap((server) => {
    if (!server.url) return [];
    const vars = server.variables
      ? Object.fromEntries(
          Object.entries(server.variables).flatMap(([name, v]) =>
            v.default ? [[name, v.default]] : [],
          ),
        )
      : undefined;
    return [
      new ServerInfo({
        url: server.url,
        variables: vars && Object.keys(vars).length > 0 ? Option.some(vars) : Option.none(),
      }),
    ];
  });

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

/** Extract all operations from a bundled OpenAPI 3.x document */
export const extract = Effect.fn("OpenApi.extract")(function* (doc: ParsedDocument) {
  const paths = doc.paths;
  if (!paths) {
    return yield* new OpenApiExtractionError({
      message: "OpenAPI document has no paths defined",
    });
  }

  const r = new DocResolver(doc);
  const operations: ExtractedOperation[] = [];

  for (const [pathTemplate, pathItem] of Object.entries(paths).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!pathItem) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const parameters = extractParameters(pathItem, operation, r);
      const requestBody = extractRequestBody(operation, r);
      const inputSchema = buildInputSchema(parameters, requestBody);
      const outputSchema = extractOutputSchema(operation, r);
      const tags = (operation.tags ?? []).filter((t) => t.trim().length > 0);

      operations.push(
        new ExtractedOperation({
          operationId: OperationId.make(deriveOperationId(method, pathTemplate, operation)),
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
