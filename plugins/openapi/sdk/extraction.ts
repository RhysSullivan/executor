import * as Effect from "effect/Effect";

import { contentHash, stableHash } from "@executor/source-core";

import { parseOpenApiDocument } from "./document";
import type {
  OpenApiExample,
  OpenApiExtractedTool,
  OpenApiHeader,
  OpenApiJsonObject,
  OpenApiMediaContent,
  OpenApiResponseVariant,
  OpenApiSecurityRequirement,
  OpenApiSecurityScheme,
  OpenApiServer,
  OpenApiToolDocumentation,
  OpenApiToolManifest,
  OpenApiToolParameter,
  OpenApiToolRequestBody,
} from "./types";
import { OPEN_API_HTTP_METHODS, type OpenApiHttpMethod } from "./types";

const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asArray = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : [];

const asTrimmedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => stableJsonValue(entry));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableJsonValue(entry)]),
    );
  }

  return value;
};

const stableJsonStringify = (value: unknown): string =>
  JSON.stringify(stableJsonValue(value));

const sortedTrimmedStrings = (value: unknown): string[] =>
  [...new Set(
    asArray(value).flatMap((entry) => {
      const stringValue = asTrimmedString(entry);
      return stringValue ? [stringValue] : [];
    }),
  )].sort((left, right) => left.localeCompare(right));

const normalizedSwagger2FlowName = (
  value: string | undefined,
): "implicit" | "password" | "clientCredentials" | "authorizationCode" | undefined => {
  switch (value) {
    case "implicit":
      return "implicit";
    case "password":
      return "password";
    case "application":
      return "clientCredentials";
    case "accessCode":
      return "authorizationCode";
    default:
      return undefined;
  }
};

const resolvePointerSegment = (segment: string): string =>
  segment.replaceAll("~1", "/").replaceAll("~0", "~");

const resolveLocalRef = (
  document: OpenApiJsonObject,
  value: unknown,
  activeRefs: ReadonlySet<string> = new Set<string>(),
): unknown => {
  const object = asObject(value);
  const ref = typeof object.$ref === "string" ? object.$ref : null;
  if (!ref || !ref.startsWith("#/") || activeRefs.has(ref)) {
    return value;
  }

  const resolved = ref
    .slice(2)
    .split("/")
    .reduce<unknown>((current, segment) => {
      if (current === undefined || current === null) {
        return undefined;
      }

      return asObject(current)[resolvePointerSegment(segment)];
    }, document);

  if (resolved === undefined) {
    return value;
  }

  const nextActiveRefs = new Set(activeRefs);
  nextActiveRefs.add(ref);

  const resolvedObject = asObject(
    resolveLocalRef(document, resolved, nextActiveRefs),
  );
  const { $ref: _ignoredRef, ...rest } = object;

  return Object.keys(rest).length > 0 ? { ...resolvedObject, ...rest } : resolvedObject;
};

export type OpenApiManifestExtractionOptions = {
  documentUrl?: string;
  loadDocument?: (url: string) => Promise<string>;
};

const defaultDocumentLoader = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed fetching OpenAPI document ${url} (${response.status} ${response.statusText})`);
  }

  return response.text();
};

const refTargetFor = (
  currentDocumentUrl: string | undefined,
  ref: string,
): { documentUrl?: string; pointer: string } | undefined => {
  if (ref.startsWith("#")) {
    return { documentUrl: currentDocumentUrl, pointer: ref };
  }

  if (!currentDocumentUrl) {
    return undefined;
  }

  const resolvedUrl = new URL(ref, currentDocumentUrl);
  const pointer = resolvedUrl.hash && resolvedUrl.hash.length > 0 ? resolvedUrl.hash : "#";
  resolvedUrl.hash = "";
  return {
    documentUrl: resolvedUrl.toString(),
    pointer,
  };
};

const resolvePointerValue = (
  document: OpenApiJsonObject,
  pointer: string,
): unknown => {
  if (pointer === "#" || pointer.length === 0) {
    return document;
  }

  return pointer
    .slice(pointer.startsWith("#/") ? 2 : 0)
    .split("/")
    .reduce<unknown>((current, segment) => {
      if (current === undefined || current === null) {
        return undefined;
      }

      return asObject(current)[resolvePointerSegment(segment)];
    }, document);
};

const loadDereferencedOpenApiDocument = async (input: {
  document: OpenApiJsonObject;
  documentUrl?: string;
  loadDocument?: (url: string) => Promise<string>;
}): Promise<OpenApiJsonObject> => {
  if (!input.documentUrl) {
    return input.document;
  }

  const loader = input.loadDocument ?? defaultDocumentLoader;
  const cache = new Map<string, Promise<OpenApiJsonObject>>();
  cache.set(input.documentUrl, Promise.resolve(input.document));

  const loadParsedDocument = async (documentUrl: string): Promise<OpenApiJsonObject> => {
    const cached = cache.get(documentUrl);
    if (cached) {
      return cached;
    }

    const next = loader(documentUrl).then((text) => parseOpenApiDocument(text));
    cache.set(documentUrl, next);
    return next;
  };

  const dereference = async (inputValue: {
    value: unknown;
    currentDocument: OpenApiJsonObject;
    currentDocumentUrl?: string;
    activeRefs: ReadonlySet<string>;
    preserveLocalRefs: boolean;
  }): Promise<unknown> => {
    const {
      value,
      currentDocument,
      currentDocumentUrl,
      activeRefs,
      preserveLocalRefs,
    } = inputValue;

    if (Array.isArray(value)) {
      return Promise.all(
        value.map((entry) =>
          dereference({
            value: entry,
            currentDocument,
            currentDocumentUrl,
            activeRefs,
            preserveLocalRefs,
          }),
        ),
      );
    }

    if (value === null || typeof value !== "object") {
      return value;
    }

    const object = value as Record<string, unknown>;
    const ref = asTrimmedString(object.$ref);
    if (ref) {
      const target = refTargetFor(currentDocumentUrl, ref);
      if (!target?.documentUrl && !ref.startsWith("#")) {
        return value;
      }

      const isLocalRef =
        ref.startsWith("#") &&
        (target?.documentUrl === undefined || target.documentUrl === currentDocumentUrl);
      if (isLocalRef && preserveLocalRefs) {
        const siblingEntries = Object.fromEntries(
          await Promise.all(
            Object.entries(object)
              .filter(([key]) => key !== "$ref")
              .map(async ([key, entry]) => [
                key,
                await dereference({
                  value: entry,
                  currentDocument,
                  currentDocumentUrl,
                  activeRefs,
                  preserveLocalRefs,
                }),
              ]),
          ),
        );

        return Object.keys(siblingEntries).length > 0
          ? {
              $ref: ref,
              ...siblingEntries,
            }
          : value;
      }

      const activeKey = `${target?.documentUrl ?? currentDocumentUrl ?? "root"}|${target?.pointer ?? ref}`;
      if (activeRefs.has(activeKey)) {
        return value;
      }

      const targetDocument =
        target?.documentUrl && target.documentUrl !== currentDocumentUrl
          ? await loadParsedDocument(target.documentUrl)
          : currentDocument;
      const targetValue = resolvePointerValue(targetDocument, target?.pointer ?? ref);
      if (targetValue === undefined) {
        return value;
      }

      const nextActiveRefs = new Set(activeRefs);
      nextActiveRefs.add(activeKey);

      const resolvedValue = await dereference({
        value: targetValue,
        currentDocument: targetDocument,
        currentDocumentUrl: target?.documentUrl ?? currentDocumentUrl,
        activeRefs: nextActiveRefs,
        preserveLocalRefs: target?.documentUrl ? false : preserveLocalRefs,
      });
      const siblingEntries = Object.fromEntries(
        await Promise.all(
          Object.entries(object)
            .filter(([key]) => key !== "$ref")
            .map(async ([key, entry]) => [
              key,
              await dereference({
                value: entry,
                currentDocument,
                currentDocumentUrl,
                activeRefs: nextActiveRefs,
                preserveLocalRefs,
              }),
            ]),
        ),
      );
      const resolvedObject = asObject(resolvedValue);

      return Object.keys(siblingEntries).length > 0
        ? { ...resolvedObject, ...siblingEntries }
        : resolvedObject;
    }

    return Object.fromEntries(
      await Promise.all(
        Object.entries(object).map(async ([key, entry]) => [
          key,
          await dereference({
            value: entry,
            currentDocument,
            currentDocumentUrl,
            activeRefs,
            preserveLocalRefs,
          }),
        ]),
      ),
    );
  };

  return dereference({
    value: input.document,
    currentDocument: input.document,
    currentDocumentUrl: input.documentUrl,
    activeRefs: new Set<string>(),
    preserveLocalRefs: true,
  }) as Promise<OpenApiJsonObject>;
};

const preferredContentEntry = (
  content: unknown,
): readonly [string, Record<string, unknown>] | undefined => {
  const entries = Object.entries(asObject(content))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([mediaType, value]) => [mediaType, asObject(value)] as const);

  return (
    entries.find(([mediaType]) => mediaType === "application/json") ??
    entries.find(([mediaType]) => mediaType.toLowerCase().includes("+json")) ??
    entries.find(([mediaType]) => mediaType.toLowerCase().includes("json")) ??
    entries[0]
  );
};

const contentSchemaFromOperationContent = (
  document: OpenApiJsonObject,
  content: unknown,
): unknown | undefined => {
  const preferred = preferredContentEntry(content);
  return preferred?.[1].schema === undefined
    ? undefined
    : resolveLocalRef(document, preferred[1].schema);
};

const examplesFromValue = (
  value: unknown,
  input: {
    label?: string;
    mediaType?: string;
  } = {},
): Array<OpenApiExample> => {
  const record = asObject(value);
  const examples: Array<OpenApiExample> = [];

  if (record.example !== undefined) {
    examples.push({
      valueJson: stableJsonStringify(record.example),
      ...(input.mediaType ? { mediaType: input.mediaType } : {}),
      ...(input.label ? { label: input.label } : {}),
    });
  }

  const exampleEntries = Object.entries(asObject(record.examples)).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [key, exampleValue] of exampleEntries) {
    const exampleRecord = asObject(exampleValue);
    examples.push({
      valueJson: stableJsonStringify(
        exampleRecord.value !== undefined ? exampleRecord.value : exampleValue,
      ),
      ...(input.mediaType ? { mediaType: input.mediaType } : {}),
      label: key,
    });
  }

  return examples;
};

const examplesFromSchema = (schema: unknown): Array<OpenApiExample> =>
  examplesFromValue(schema);

const examplesFromMediaType = (
  mediaType: string,
  mediaTypeRecord: Record<string, unknown>,
): Array<OpenApiExample> => {
  const direct = examplesFromValue(mediaTypeRecord, { mediaType });
  if (direct.length > 0) {
    return direct;
  }

  return examplesFromSchema(mediaTypeRecord.schema).map((example) => ({
    ...example,
    mediaType,
  }));
};

const contentEntriesFromContent = (
  document: OpenApiJsonObject,
  content: unknown,
): ReadonlyArray<OpenApiMediaContent> =>
  Object.entries(asObject(content))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([mediaType, mediaValue]) => {
      const mediaRecord = asObject(resolveLocalRef(document, mediaValue));
      const examples = examplesFromMediaType(mediaType, mediaRecord);

      return {
        mediaType,
        ...(mediaRecord.schema !== undefined
          ? { schema: resolveLocalRef(document, mediaRecord.schema) }
          : {}),
        ...(examples.length > 0 ? { examples } : {}),
      };
    });

const schemaFromSchemaLikeRecord = (
  document: OpenApiJsonObject,
  value: unknown,
): unknown | undefined => {
  const record = asObject(resolveLocalRef(document, value));
  if (record.schema !== undefined) {
    return resolveLocalRef(document, record.schema);
  }

  const schema: Record<string, unknown> = {};
  const type = asTrimmedString(record.type);

  if (type === "file") {
    schema.type = "string";
    schema.format = "binary";
  } else if (type) {
    schema.type = type;
  }

  for (const key of [
    "title",
    "description",
    "format",
    "default",
    "nullable",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "deprecated",
  ] as const) {
    if (record[key] !== undefined) {
      schema[key] = record[key];
    }
  }

  const enumValues = asArray(record.enum);
  if (enumValues.length > 0) {
    schema.enum = enumValues;
  }

  const required = sortedTrimmedStrings(record.required);
  if (required.length > 0) {
    schema.required = required;
  }

  if (record.items !== undefined) {
    schema.items = resolveLocalRef(document, record.items);
  }

  if (record.additionalProperties !== undefined) {
    schema.additionalProperties =
      typeof record.additionalProperties === "boolean"
        ? record.additionalProperties
        : resolveLocalRef(document, record.additionalProperties);
  }

  const properties = Object.fromEntries(
    Object.entries(asObject(record.properties))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([propertyName, propertyValue]) => [
        propertyName,
        resolveLocalRef(document, propertyValue),
      ]),
  );
  if (Object.keys(properties).length > 0) {
    schema.properties = properties;
  }

  const patternProperties = Object.fromEntries(
    Object.entries(asObject(record.patternProperties))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([pattern, patternValue]) => [pattern, resolveLocalRef(document, patternValue)]),
  );
  if (Object.keys(patternProperties).length > 0) {
    schema.patternProperties = patternProperties;
  }

  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const entries = asArray(record[key]).map((entry) => resolveLocalRef(document, entry));
    if (entries.length > 0) {
      schema[key] = entries;
    }
  }

  if (record.not !== undefined) {
    schema.not = resolveLocalRef(document, record.not);
  }

  return Object.keys(schema).length > 0 ? schema : undefined;
};

const headerFromValue = (
  document: OpenApiJsonObject,
  name: string,
  value: unknown,
): OpenApiHeader | undefined => {
  const header = asObject(resolveLocalRef(document, value));
  if (Object.keys(header).length === 0) {
    return undefined;
  }

  const content = contentEntriesFromContent(document, header.content);
  const directExamples = content.length > 0 ? [] : examplesFromValue(header);
  const schema = schemaFromSchemaLikeRecord(document, header);

  return {
    name,
    ...(asTrimmedString(header.description)
      ? { description: asTrimmedString(header.description) }
      : {}),
    ...(typeof header.required === "boolean" ? { required: header.required } : {}),
    ...(typeof header.deprecated === "boolean"
      ? { deprecated: header.deprecated }
      : {}),
    ...(schema !== undefined ? { schema } : {}),
    ...(content.length > 0 ? { content } : {}),
    ...(asTrimmedString(header.style) ? { style: asTrimmedString(header.style) } : {}),
    ...(typeof header.explode === "boolean" ? { explode: header.explode } : {}),
    ...(directExamples.length > 0 ? { examples: directExamples } : {}),
  };
};

const headersFromValue = (
  document: OpenApiJsonObject,
  value: unknown,
): ReadonlyArray<OpenApiHeader> =>
  Object.entries(asObject(value))
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, headerValue]) => {
      const header = headerFromValue(document, name, headerValue);
      return header ? [header] : [];
    });

const serversFromValue = (value: unknown): ReadonlyArray<OpenApiServer> =>
  asArray(value)
    .map((entry) => asObject(entry))
    .flatMap((server) => {
      const url = asTrimmedString(server.url);
      if (!url) {
        return [];
      }

      const variables = Object.fromEntries(
        Object.entries(asObject(server.variables))
          .sort(([left], [right]) => left.localeCompare(right))
          .flatMap(([name, variableValue]) => {
            const variableRecord = asObject(variableValue);
            const defaultValue = asTrimmedString(variableRecord.default);
            return defaultValue ? [[name, defaultValue] as const] : [];
          }),
      );

      return [
        {
          url,
          ...(asTrimmedString(server.description)
            ? { description: asTrimmedString(server.description) }
            : {}),
          ...(Object.keys(variables).length > 0 ? { variables } : {}),
        },
      ];
    });

const normalizedPathPrefix = (value: string | undefined): string => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed === "/") {
    return "";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
};

const swagger2ServersFromDocument = (
  document: OpenApiJsonObject,
  schemesOverride?: readonly string[],
): ReadonlyArray<OpenApiServer> => {
  const host = asTrimmedString(document.host);
  if (!host) {
    return [];
  }

  const schemes = schemesOverride && schemesOverride.length > 0
    ? [...schemesOverride]
    : sortedTrimmedStrings(document.schemes);
  const normalizedSchemes = schemes.length > 0 ? schemes : ["https"];
  const basePath = normalizedPathPrefix(asTrimmedString(document.basePath));

  return normalizedSchemes.map((scheme) => ({
    url: `${scheme}://${host}${basePath}`,
  }));
};

const documentServersFor = (document: OpenApiJsonObject): ReadonlyArray<OpenApiServer> => {
  const openApi3Servers = serversFromValue(document.servers);
  return openApi3Servers.length > 0
    ? openApi3Servers
    : swagger2ServersFromDocument(document);
};

const operationServersFor = (
  document: OpenApiJsonObject,
  pathTemplate: string,
  method: OpenApiHttpMethod,
): ReadonlyArray<OpenApiServer> | undefined => {
  const operation = operationFor(document, pathTemplate, method);
  const pathItem = pathItemFor(document, pathTemplate);
  const openApi3Servers = [
    ...serversFromValue(operation.servers),
    ...serversFromValue(pathItem.servers),
  ];
  if (openApi3Servers.length > 0) {
    return openApi3Servers;
  }

  const swagger2Schemes = sortedTrimmedStrings(operation.schemes);
  if (swagger2Schemes.length > 0) {
    const servers = swagger2ServersFromDocument(document, swagger2Schemes);
    return servers.length > 0 ? servers : undefined;
  }

  const pathSchemes = sortedTrimmedStrings(pathItem.schemes);
  if (pathSchemes.length > 0) {
    const servers = swagger2ServersFromDocument(document, pathSchemes);
    return servers.length > 0 ? servers : undefined;
  }

  return undefined;
};

const requestContentTypesFor = (
  document: OpenApiJsonObject,
  pathTemplate: string,
  method: OpenApiHttpMethod,
): string[] => {
  const operation = operationFor(document, pathTemplate, method);
  const pathItem = pathItemFor(document, pathTemplate);

  return sortedTrimmedStrings(
    operation.consumes ?? pathItem.consumes ?? document.consumes,
  );
};

const responseContentTypesFor = (
  document: OpenApiJsonObject,
  pathTemplate: string,
  method: OpenApiHttpMethod,
): string[] => {
  const operation = operationFor(document, pathTemplate, method);
  const pathItem = pathItemFor(document, pathTemplate);

  return sortedTrimmedStrings(
    operation.produces ?? pathItem.produces ?? document.produces,
  );
};

const responseStatusRank = (statusCode: string): number => {
  if (/^2\\d\\d$/.test(statusCode)) {
    return 0;
  }

  if (statusCode === "default") {
    return 1;
  }

  return 2;
};

const operationFor = (
  document: OpenApiJsonObject,
  pathTemplate: string,
  method: OpenApiHttpMethod,
): Record<string, unknown> =>
  asObject(asObject(asObject(document.paths)[pathTemplate])[method]);

const pathItemFor = (
  document: OpenApiJsonObject,
  pathTemplate: string,
): Record<string, unknown> => asObject(asObject(document.paths)[pathTemplate]);

const parameterKey = (input: {
  location: string;
  name: string;
}): string => `${input.location}:${input.name}`;

const mergedParameterRecords = (
  document: OpenApiJsonObject,
  pathTemplate: string,
  method: OpenApiHttpMethod,
): ReadonlyMap<string, Record<string, unknown>> => {
  const merged = new Map<string, Record<string, unknown>>();
  const pathItem = pathItemFor(document, pathTemplate);
  const operation = operationFor(document, pathTemplate, method);

  for (const parameterValue of asArray(pathItem.parameters)) {
    const parameter = asObject(resolveLocalRef(document, parameterValue));
    const name = asTrimmedString(parameter.name);
    const location = asTrimmedString(parameter.in);
    if (!name || !location) {
      continue;
    }

    merged.set(parameterKey({ location, name }), parameter);
  }

  for (const parameterValue of asArray(operation.parameters)) {
    const parameter = asObject(resolveLocalRef(document, parameterValue));
    const name = asTrimmedString(parameter.name);
    const location = asTrimmedString(parameter.in);
    if (!name || !location) {
      continue;
    }

    merged.set(parameterKey({ location, name }), parameter);
  }

  return merged;
};

const parameterSchemaFor = (
  document: OpenApiJsonObject,
  parameter: Record<string, unknown>,
): unknown | undefined => schemaFromSchemaLikeRecord(document, parameter);

const swagger2BodyParameterFor = (
  document: OpenApiJsonObject,
  pathTemplate: string,
  method: OpenApiHttpMethod,
): Record<string, unknown> | undefined =>
  [...mergedParameterRecords(document, pathTemplate, method).values()].find(
    (parameter) => asTrimmedString(parameter.in) === "body",
  );

const swagger2FormDataParametersFor = (
  document: OpenApiJsonObject,
  pathTemplate: string,
  method: OpenApiHttpMethod,
): Array<Record<string, unknown>> =>
  [...mergedParameterRecords(document, pathTemplate, method).values()]
    .filter((parameter) => asTrimmedString(parameter.in) === "formData")
    .sort((left, right) =>
      (asTrimmedString(left.name) ?? "").localeCompare(asTrimmedString(right.name) ?? ""),
    );

const openApiRequestBodyContents = (input: {
  contentTypes: readonly string[];
  schema: unknown | undefined;
  examples?: readonly OpenApiExample[];
}): Array<OpenApiMediaContent> =>
  input.contentTypes.map((mediaType) => ({
    mediaType,
    ...(input.schema !== undefined ? { schema: input.schema } : {}),
    ...(input.examples && input.examples.length > 0 ? { examples: [...input.examples] } : {}),
  }));

const requestBodyPayloadFor = (
  document: OpenApiJsonObject,
  pathTemplate: string,
  method: OpenApiHttpMethod,
): OpenApiToolRequestBody | null => {
  const operation = operationFor(document, pathTemplate, method);
  const requestBody = asObject(resolveLocalRef(document, operation.requestBody));
  if (Object.keys(requestBody).length === 0) {
    return null;
  }

  const contents = contentEntriesFromContent(document, requestBody.content);
  const contentTypes = contents.map((content) => content.mediaType);
  if (contents.length > 0 || contentTypes.length > 0) {
    return {
      required:
        typeof requestBody.required === "boolean" ? requestBody.required : false,
      contentTypes,
      ...(contents.length > 0 ? { contents } : {}),
    };
  }

  const swagger2BodyParameter = swagger2BodyParameterFor(document, pathTemplate, method);
  if (swagger2BodyParameter) {
    const schema = parameterSchemaFor(document, swagger2BodyParameter);
    const examples = examplesFromValue(swagger2BodyParameter);
    const contentTypes = requestContentTypesFor(document, pathTemplate, method);
    const normalizedContentTypes = contentTypes.length > 0
      ? contentTypes
      : ["application/json"];
    const bodyContents = openApiRequestBodyContents({
      contentTypes: normalizedContentTypes,
      schema,
      examples,
    });

    return {
      required:
        typeof swagger2BodyParameter.required === "boolean"
          ? swagger2BodyParameter.required
          : false,
      contentTypes: normalizedContentTypes,
      ...(bodyContents.length > 0 ? { contents: bodyContents } : {}),
    };
  }

  const formDataParameters = swagger2FormDataParametersFor(document, pathTemplate, method);
  if (formDataParameters.length > 0) {
    const properties = Object.fromEntries(
      formDataParameters.flatMap((parameter) => {
        const name = asTrimmedString(parameter.name);
        const schema = parameterSchemaFor(document, parameter);
        return name && schema !== undefined ? [[name, schema] as const] : [];
      }),
    );
    const required = formDataParameters.flatMap((parameter) =>
      typeof parameter.required === "boolean" && parameter.required
        ? [asTrimmedString(parameter.name)].filter((name): name is string => Boolean(name))
        : [],
    );
    const hasFileParameter = formDataParameters.some(
      (parameter) => asTrimmedString(parameter.type) === "file",
    );
    const contentTypes = requestContentTypesFor(document, pathTemplate, method);
    const normalizedContentTypes = contentTypes.length > 0
      ? contentTypes
      : [hasFileParameter ? "multipart/form-data" : "application/x-www-form-urlencoded"];
    const schema = {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
    const bodyContents = openApiRequestBodyContents({
      contentTypes: normalizedContentTypes,
      schema,
    });

    return {
      required: required.length > 0,
      contentTypes: normalizedContentTypes,
      ...(bodyContents.length > 0 ? { contents: bodyContents } : {}),
    };
  }

  return null;
};

const responseSchemaFromResponse = (
  document: OpenApiJsonObject,
  response: Record<string, unknown>,
): unknown | undefined =>
  contentSchemaFromOperationContent(document, response.content) ??
  (response.schema !== undefined ? resolveLocalRef(document, response.schema) : undefined);

const responseExamplesFromResponse = (
  response: Record<string, unknown>,
): Array<OpenApiExample> => {
  const mediaExamples = Object.entries(asObject(response.examples))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([mediaType, exampleValue]) => ({
      mediaType,
      valueJson: stableJsonStringify(exampleValue),
    }));
  return mediaExamples.length > 0 ? mediaExamples : examplesFromValue(response);
};

const responseContentsFromResponse = (
  document: OpenApiJsonObject,
  pathTemplate: string,
  method: OpenApiHttpMethod,
  response: Record<string, unknown>,
): ReadonlyArray<OpenApiMediaContent> => {
  const contents = contentEntriesFromContent(document, response.content);
  if (contents.length > 0) {
    return contents;
  }

  const schema = responseSchemaFromResponse(document, response);
  if (schema === undefined) {
    return [];
  }

  const contentTypes = responseContentTypesFor(document, pathTemplate, method);
  const normalizedContentTypes = contentTypes.length > 0
    ? contentTypes
    : ["application/json"];
  const examplesByMediaType = new Map(
    responseExamplesFromResponse(response).flatMap((example) =>
      example.mediaType ? [[example.mediaType, [example]] as const] : [],
    ),
  );
  const fallbackExamples = responseExamplesFromResponse(response).filter(
    (example) => !example.mediaType,
  );

  return normalizedContentTypes.map((mediaType) => ({
    mediaType,
    schema,
    ...(examplesByMediaType.get(mediaType)?.length
      ? { examples: examplesByMediaType.get(mediaType) }
      : fallbackExamples.length > 0
        ? {
            examples: fallbackExamples.map((example) => ({
              ...example,
              mediaType,
            })),
          }
        : {}),
  }));
};

const responseSchemaFor = (
  document: OpenApiJsonObject,
  pathTemplate: string,
  method: OpenApiHttpMethod,
): unknown | undefined => {
  const operation = operationFor(document, pathTemplate, method);
  const responseEntries = Object.entries(asObject(operation.responses));
  const preferredResponses = responseEntries
    .filter(([status]) => /^2\\d\\d$/.test(status))
    .sort(([left], [right]) => left.localeCompare(right));
  const fallbackResponses = responseEntries.filter(([status]) => status === "default");

  for (const [, responseValue] of [...preferredResponses, ...fallbackResponses]) {
    const response = asObject(resolveLocalRef(document, responseValue));
    const schema = responseSchemaFromResponse(document, response);
    if (schema !== undefined) {
      return schema;
    }
  }

  return undefined;
};

const responseVariantsFor = (
  document: OpenApiJsonObject,
  pathTemplate: string,
  method: OpenApiHttpMethod,
): OpenApiResponseVariant[] | undefined => {
  const operation = operationFor(document, pathTemplate, method);
  const responseEntries = Object.entries(asObject(operation.responses)).sort(
    ([left], [right]) =>
      responseStatusRank(left) - responseStatusRank(right) ||
      left.localeCompare(right),
  );

  const responses = responseEntries.map(([statusCode, responseValue]) => {
    const response = asObject(resolveLocalRef(document, responseValue));
    const contents = responseContentsFromResponse(document, pathTemplate, method, response);
    const contentTypes = contents.map((content) => content.mediaType);
    const examples =
      contents[0]?.examples ??
      responseExamplesFromResponse(response);
    const headers = headersFromValue(document, response.headers);
    const schema = responseSchemaFromResponse(document, response);

    return {
      statusCode,
      ...(asTrimmedString(response.description)
        ? { description: asTrimmedString(response.description) }
        : {}),
      contentTypes,
      ...(schema !== undefined ? { schema } : {}),
      ...(examples.length > 0 ? { examples } : {}),
      ...(contents.length > 0 ? { contents } : {}),
      ...(headers.length > 0 ? { headers } : {}),
    };
  });

  return responses.length > 0 ? responses : undefined;
};

const securityRequirementFromValue = (
  value: unknown,
): OpenApiSecurityRequirement | undefined => {
  const requirementEntries = asArray(value);
  if (requirementEntries.length === 0) {
    return { kind: "none" };
  }

  const anyOfItems = requirementEntries.flatMap((entry) => {
    const schemes = Object.entries(asObject(entry))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([schemeName, rawScopes]) => {
        const scopes = asArray(rawScopes).flatMap((scope) =>
          typeof scope === "string" && scope.trim().length > 0 ? [scope.trim()] : [],
        );

        return {
          kind: "scheme" as const,
          schemeName,
          ...(scopes.length > 0 ? { scopes } : {}),
        };
      });

    if (schemes.length === 0) {
      return [];
    }

    return [
      schemes.length === 1
        ? schemes[0]!
        : {
            kind: "allOf" as const,
            items: schemes,
          },
    ];
  });

  if (anyOfItems.length === 0) {
    return undefined;
  }

  return anyOfItems.length === 1
    ? anyOfItems[0]
    : {
        kind: "anyOf",
        items: anyOfItems,
      };
};

const authRequirementFor = (
  document: OpenApiJsonObject,
  pathTemplate: string,
  method: OpenApiHttpMethod,
): OpenApiSecurityRequirement | undefined => {
  const operation = operationFor(document, pathTemplate, method);
  if (Object.prototype.hasOwnProperty.call(operation, "security")) {
    return securityRequirementFromValue(operation.security);
  }

  return securityRequirementFromValue(document.security);
};

const collectReferencedSecuritySchemeNames = (
  authRequirement: OpenApiSecurityRequirement | undefined,
  names: Set<string>,
): void => {
  if (!authRequirement) {
    return;
  }

  switch (authRequirement.kind) {
    case "none":
      return;
    case "scheme":
      names.add(authRequirement.schemeName);
      return;
    case "allOf":
    case "anyOf":
      for (const item of authRequirement.items) {
        collectReferencedSecuritySchemeNames(item, names);
      }
  }
};

const oauthFlowRecord = (
  value: unknown,
):
  | Record<
      string,
      {
        authorizationUrl?: string;
        tokenUrl?: string;
        refreshUrl?: string;
        scopes?: Record<string, string>;
      }
    >
  | undefined => {
  const result = Object.fromEntries(
    Object.entries(asObject(value))
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([flowName, flowValue]) => {
        const normalizedFlowName = normalizedSwagger2FlowName(flowName) ?? flowName;
        const flowRecord = asObject(flowValue);
        const scopes = Object.fromEntries(
          Object.entries(asObject(flowRecord.scopes))
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([scope, description]) => [scope, asTrimmedString(description) ?? ""]),
        );

        return [[
          normalizedFlowName,
          {
            ...(asTrimmedString(flowRecord.authorizationUrl)
              ? { authorizationUrl: asTrimmedString(flowRecord.authorizationUrl) }
              : {}),
            ...(asTrimmedString(flowRecord.tokenUrl)
              ? { tokenUrl: asTrimmedString(flowRecord.tokenUrl) }
              : {}),
            ...(asTrimmedString(flowRecord.refreshUrl)
              ? { refreshUrl: asTrimmedString(flowRecord.refreshUrl) }
              : {}),
            ...(Object.keys(scopes).length > 0 ? { scopes } : {}),
          },
        ]];
      }),
  );

  return Object.keys(result).length > 0 ? result : undefined;
};

const oauthFlowRecordFromSwagger2Scheme = (
  scheme: Record<string, unknown>,
):
  | Record<
      string,
      {
        authorizationUrl?: string;
        tokenUrl?: string;
        refreshUrl?: string;
        scopes?: Record<string, string>;
      }
    >
  | undefined => {
  const flowName = normalizedSwagger2FlowName(asTrimmedString(scheme.flow));
  if (!flowName) {
    return undefined;
  }

  const scopes = Object.fromEntries(
    Object.entries(asObject(scheme.scopes))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([scope, description]) => [scope, asTrimmedString(description) ?? ""]),
  );

  return {
    [flowName]: {
      ...(asTrimmedString(scheme.authorizationUrl)
        ? { authorizationUrl: asTrimmedString(scheme.authorizationUrl) }
        : {}),
      ...(asTrimmedString(scheme.tokenUrl)
        ? { tokenUrl: asTrimmedString(scheme.tokenUrl) }
        : {}),
      ...(asTrimmedString(scheme.refreshUrl)
        ? { refreshUrl: asTrimmedString(scheme.refreshUrl) }
        : {}),
      ...(Object.keys(scopes).length > 0 ? { scopes } : {}),
    },
  };
};

const securitySchemesFor = (
  document: OpenApiJsonObject,
  authRequirement: OpenApiSecurityRequirement | undefined,
): OpenApiSecurityScheme[] | undefined => {
  if (!authRequirement || authRequirement.kind === "none") {
    return undefined;
  }

  const schemeNames = new Set<string>();
  collectReferencedSecuritySchemeNames(authRequirement, schemeNames);

  const securitySchemes =
    Object.keys(asObject(asObject(document.components).securitySchemes)).length > 0
      ? asObject(asObject(document.components).securitySchemes)
      : asObject(document.securityDefinitions);
  const resolved = [...schemeNames]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((schemeName) => {
      const rawScheme = securitySchemes[schemeName];
      if (rawScheme === undefined) {
        return [];
      }

      const scheme = asObject(resolveLocalRef(document, rawScheme));
      const schemeType = asTrimmedString(scheme.type);
      if (!schemeType) {
        return [];
      }

      const normalizedSchemeType: "apiKey" | "http" | "oauth2" | "openIdConnect" =
        schemeType === "apiKey" ||
        schemeType === "http" ||
        schemeType === "oauth2" ||
        schemeType === "openIdConnect"
          ? schemeType
          : "http";
      const normalizedScheme =
        schemeType === "basic"
          ? "basic"
          : asTrimmedString(scheme.scheme);

      const placementIn = asTrimmedString(scheme.in);
      const normalizedPlacementIn: "header" | "query" | "cookie" | undefined =
        placementIn === "header" || placementIn === "query" || placementIn === "cookie"
          ? placementIn
          : undefined;

      return [
        {
          schemeName,
          schemeType: normalizedSchemeType,
          ...(asTrimmedString(scheme.description)
            ? { description: asTrimmedString(scheme.description) }
            : {}),
          ...(normalizedPlacementIn ? { placementIn: normalizedPlacementIn } : {}),
          ...(asTrimmedString(scheme.name)
            ? { placementName: asTrimmedString(scheme.name) }
            : {}),
          ...(normalizedScheme
            ? { scheme: normalizedScheme }
            : {}),
          ...(asTrimmedString(scheme.bearerFormat)
            ? { bearerFormat: asTrimmedString(scheme.bearerFormat) }
            : {}),
          ...(asTrimmedString(scheme.openIdConnectUrl)
            ? { openIdConnectUrl: asTrimmedString(scheme.openIdConnectUrl) }
            : {}),
          ...(oauthFlowRecord(scheme.flows) || oauthFlowRecordFromSwagger2Scheme(scheme)
            ? {
                flows:
                  oauthFlowRecord(scheme.flows) ??
                  oauthFlowRecordFromSwagger2Scheme(scheme),
              }
            : {}),
        },
      ];
    });

  return resolved.length > 0 ? resolved : undefined;
};

const buildInputSchema = (input: {
  parameters: ReadonlyArray<OpenApiToolParameter>;
  requestBody: OpenApiToolRequestBody | null;
}): Record<string, unknown> | undefined => {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const parameter of input.parameters) {
    const preferredContent = parameter.content?.[0]?.schema;
    properties[parameter.name] = preferredContent ?? { type: "string" };
    if (parameter.required) {
      required.push(parameter.name);
    }
  }

  if (input.requestBody) {
    properties.body =
      input.requestBody.contents?.[0]?.schema ?? {
        type: "object",
      };
    if (input.requestBody.required) {
      required.push("body");
    }
  }

  return Object.keys(properties).length > 0
    ? {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      }
    : undefined;
};

const buildDocumentation = (input: {
  document: OpenApiJsonObject;
  pathTemplate: string;
  method: OpenApiHttpMethod;
  operation: Record<string, unknown>;
  parameters: ReadonlyArray<OpenApiToolParameter>;
  requestBody: OpenApiToolRequestBody | null;
  responses: ReadonlyArray<OpenApiResponseVariant> | undefined;
}): OpenApiToolDocumentation => {
  const parameterDocs = input.parameters.map((parameter) => ({
    name: parameter.name,
    location: parameter.location,
    required: parameter.required,
    ...(asTrimmedString(
      (parameter as unknown as Record<string, unknown>).description,
    )
      ? {
          description: asTrimmedString(
            (parameter as unknown as Record<string, unknown>).description,
          ),
        }
      : {}),
    ...(parameter.content?.[0]?.examples && parameter.content[0].examples.length > 0
      ? { examples: parameter.content[0].examples }
      : {}),
  }));

  const preferredResponse =
    input.responses?.find((response) => /^2\\d\\d$/.test(response.statusCode)) ??
    input.responses?.find((response) => response.statusCode === "default") ??
    input.responses?.[0];
  const openApi3RequestBody = asObject(
    resolveLocalRef(input.document, input.operation.requestBody),
  );
  const swagger2BodyParameter = swagger2BodyParameterFor(
    input.document,
    input.pathTemplate,
    input.method,
  );
  const requestBodyDescription =
    asTrimmedString(openApi3RequestBody.description) ??
    asTrimmedString(swagger2BodyParameter?.description);

  return {
    ...(asTrimmedString(input.operation.summary)
      ? { summary: asTrimmedString(input.operation.summary) }
      : {}),
    ...(typeof input.operation.deprecated === "boolean"
      ? { deprecated: input.operation.deprecated }
      : {}),
    parameters: parameterDocs,
    ...(input.requestBody
      ? {
          requestBody: {
            ...(requestBodyDescription ? { description: requestBodyDescription } : {}),
            ...(input.requestBody.contents?.[0]?.examples &&
            input.requestBody.contents[0].examples.length > 0
              ? { examples: input.requestBody.contents[0].examples }
              : {}),
          },
        }
      : {}),
    ...(preferredResponse
      ? {
          response: {
            statusCode: preferredResponse.statusCode,
            ...(preferredResponse.description
              ? { description: preferredResponse.description }
              : {}),
            contentTypes: preferredResponse.contentTypes,
            ...(preferredResponse.examples && preferredResponse.examples.length > 0
              ? { examples: preferredResponse.examples }
              : {}),
          },
        }
      : {}),
  };
};

const extractToolParameters = (
  document: OpenApiJsonObject,
  pathTemplate: string,
  method: OpenApiHttpMethod,
): OpenApiToolParameter[] =>
  [...mergedParameterRecords(document, pathTemplate, method).values()]
    .filter((parameter) => {
      const location = asTrimmedString(parameter.in);
      return (
        location === "path" ||
        location === "query" ||
        location === "header" ||
        location === "cookie"
      );
    })
    .map((parameter) => {
      const location = asTrimmedString(parameter.in);
      const name = asTrimmedString(parameter.name);
      if (!location || !name) {
        throw new Error(`Invalid OpenAPI parameter on ${method.toUpperCase()} ${pathTemplate}`);
      }

      const content = contentEntriesFromContent(document, parameter.content);
      const schema = parameterSchemaFor(document, parameter);
      const examples = examplesFromValue(parameter);

      return {
        name,
        location: location as OpenApiToolParameter["location"],
        required:
          location === "path"
            ? true
            : typeof parameter.required === "boolean"
              ? parameter.required
              : false,
        ...(asTrimmedString(parameter.style)
          ? { style: asTrimmedString(parameter.style) }
          : {}),
        ...(typeof parameter.explode === "boolean"
          ? { explode: parameter.explode }
          : {}),
        ...(typeof parameter.allowReserved === "boolean"
          ? { allowReserved: parameter.allowReserved }
          : {}),
        ...(schema !== undefined && content.length === 0
          ? {
              content: [
                {
                  mediaType: "application/json",
                  schema,
                  ...(examples.length > 0 ? { examples } : {}),
                },
              ],
            }
          : {}),
        ...(content.length > 0 ? { content } : {}),
        ...(asTrimmedString(parameter.description)
          ? {
              description: asTrimmedString(parameter.description),
            }
          : {}),
      } as OpenApiToolParameter;
    });

const rawToolIdForOperation = (input: {
  method: OpenApiHttpMethod;
  pathTemplate: string;
  operation: Record<string, unknown>;
}): string =>
  asTrimmedString(input.operation.operationId) ??
  (`${input.method}_${input.pathTemplate.replace(/[^a-zA-Z0-9]+/g, "_")}`.replace(
    /^_+|_+$/g,
    "",
  ) || `${input.method}_operation`);

export const extractOpenApiManifest = (
  sourceName: string,
  openApiDocumentText: string,
  options: OpenApiManifestExtractionOptions = {},
): Effect.Effect<OpenApiToolManifest, Error, never> =>
  Effect.tryPromise({
    try: async () => {
      const parsedDocument = parseOpenApiDocument(openApiDocumentText);
      const document = await loadDereferencedOpenApiDocument({
        document: parsedDocument,
        documentUrl: options.documentUrl,
        loadDocument: options.loadDocument,
      });
      const tools: OpenApiExtractedTool[] = [];
      const paths = asObject(document.paths);
      const documentServers = documentServersFor(document);

      for (const [pathTemplate, pathItemValue] of Object.entries(paths).sort(
        ([left], [right]) => left.localeCompare(right),
      )) {
        const pathItem = asObject(pathItemValue);
        for (const method of OPEN_API_HTTP_METHODS) {
          const operation = asObject(pathItem[method]);
          if (Object.keys(operation).length === 0) {
            continue;
          }

          const parameters = extractToolParameters(document, pathTemplate, method);
          const requestBody = requestBodyPayloadFor(document, pathTemplate, method);
          const responses = responseVariantsFor(document, pathTemplate, method);
          const authRequirement = authRequirementFor(document, pathTemplate, method);
          const servers = operationServersFor(document, pathTemplate, method);
          const inputSchema = buildInputSchema({
            parameters,
            requestBody,
          });
          const outputSchema = responseSchemaFor(document, pathTemplate, method);
          const documentation = buildDocumentation({
            document,
            pathTemplate,
            method,
            operation,
            parameters,
            requestBody,
            responses,
          });

          tools.push({
            toolId: rawToolIdForOperation({
              method,
              pathTemplate,
              operation,
            }),
            ...(asTrimmedString(operation.operationId)
              ? { operationId: asTrimmedString(operation.operationId) }
              : {}),
            tags: asArray(operation.tags).flatMap((tag) =>
              typeof tag === "string" && tag.trim().length > 0 ? [tag.trim()] : [],
            ),
            name:
              asTrimmedString(operation.summary) ??
              asTrimmedString(operation.operationId) ??
              `${method.toUpperCase()} ${pathTemplate}`,
            description:
              asTrimmedString(operation.description) ??
              asTrimmedString(operation.summary) ??
              null,
            method,
            path: pathTemplate,
            invocation: {
              method,
              pathTemplate,
              parameters,
              requestBody,
            },
            operationHash: stableHash({
              method,
              path: pathTemplate,
              operation: stableJsonValue(operation),
            }),
            ...(inputSchema ? { inputSchema } : {}),
            ...(outputSchema !== undefined ? { outputSchema } : {}),
            documentation,
            ...(responses ? { responses } : {}),
            ...(authRequirement ? { authRequirement } : {}),
            ...(authRequirement
              ? {
                  securitySchemes: securitySchemesFor(document, authRequirement),
                }
              : {}),
            ...(documentServers.length > 0 ? { documentServers } : {}),
            ...(servers ? { servers } : {}),
          });
        }
      }

      return {
        version: 1,
        sourceHash: contentHash(openApiDocumentText),
        tools,
      };
    },
    catch: (cause) =>
      cause instanceof Error
        ? new Error(`Failed extracting OpenAPI manifest for ${sourceName}: ${cause.message}`)
        : new Error(String(cause)),
  });
