import { sha256Hex } from "@executor/codemode-core";
import * as Effect from "effect/Effect";

import type {
  GoogleDiscoveryHttpMethod,
  GoogleDiscoveryManifestMethod,
  GoogleDiscoveryMethodParameter,
  GoogleDiscoverySchemaRefTable,
  GoogleDiscoveryToolManifest,
} from "./types";

type JsonObject = Record<string, unknown>;

type DiscoveryParameter = {
  location?: unknown;
  type?: unknown;
  required?: unknown;
  repeated?: unknown;
  description?: unknown;
  enum?: unknown;
  default?: unknown;
  $ref?: unknown;
  items?: unknown;
};

type DiscoverySchema = {
  id?: unknown;
  type?: unknown;
  description?: unknown;
  properties?: unknown;
  items?: unknown;
  additionalProperties?: unknown;
  enum?: unknown;
  format?: unknown;
  readOnly?: unknown;
  default?: unknown;
  $ref?: unknown;
};

type DiscoveryMethod = {
  id?: unknown;
  description?: unknown;
  httpMethod?: unknown;
  path?: unknown;
  flatPath?: unknown;
  parameters?: unknown;
  request?: unknown;
  response?: unknown;
  scopes?: unknown;
  mediaUpload?: unknown;
  supportsMediaDownload?: unknown;
};

type DiscoveryResource = {
  methods?: unknown;
  resources?: unknown;
};

type DiscoveryDocument = {
  name?: unknown;
  version?: unknown;
  title?: unknown;
  description?: unknown;
  rootUrl?: unknown;
  servicePath?: unknown;
  batchPath?: unknown;
  documentationLink?: unknown;
  resources?: unknown;
  methods?: unknown;
  schemas?: unknown;
  auth?: unknown;
};

const asRecord = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const asBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const asStringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
      const stringValue = asString(entry);
      return stringValue ? [stringValue] : [];
    })
    : [];

const parseJson = (value: string | undefined): unknown | undefined => {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

const contentHash = (value: string): string =>
  sha256Hex(value);

const escapeJsonPointerSegment = (value: string): string =>
  value.replaceAll("~", "~0").replaceAll("/", "~1");

const schemaRefKey = (schemaId: string): string =>
  `#/$defs/google/${escapeJsonPointerSegment(schemaId)}`;

const normalizeHttpMethod = (value: unknown): GoogleDiscoveryHttpMethod => {
  const method = asString(value)?.toLowerCase();
  switch (method) {
    case "get":
    case "put":
    case "post":
    case "delete":
    case "patch":
    case "head":
    case "options":
      return method;
    default:
      throw new Error(`Unsupported Google Discovery HTTP method: ${String(value)}`);
  }
};

const googleSchemaToJsonSchema = (input: {
  schema: DiscoverySchema | DiscoveryParameter | unknown;
  topLevelSchemas: Readonly<Record<string, DiscoverySchema>>;
}): unknown => {
  const schema = asRecord(input.schema) as DiscoverySchema;
  const ref = asString(schema.$ref);
  if (ref) {
    return { $ref: schemaRefKey(ref) };
  }

  const description = asString(schema.description);
  const format = asString(schema.format);
  const type = asString(schema.type);
  const enumValues = asStringArray(schema.enum);
  const defaultValue =
    typeof schema.default === "string"
      || typeof schema.default === "number"
      || typeof schema.default === "boolean"
      ? schema.default
      : undefined;
  const readOnly = asBoolean(schema.readOnly);

  const base: Record<string, unknown> = {
    ...(description ? { description } : {}),
    ...(format ? { format } : {}),
    ...(enumValues.length > 0 ? { enum: [...enumValues] } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(readOnly === true ? { readOnly: true } : {}),
  };

  if (type === "any") {
    return base;
  }

  if (type === "array") {
    const items = googleSchemaToJsonSchema({
      schema: schema.items,
      topLevelSchemas: input.topLevelSchemas,
    });
    return {
      ...base,
      type: "array",
      items: items ?? {},
    };
  }

  const properties = asRecord(schema.properties);
  const additionalProperties = schema.additionalProperties;
  if (
    type === "object"
    || Object.keys(properties).length > 0
    || additionalProperties !== undefined
  ) {
    const convertedProperties = Object.fromEntries(
      Object.entries(properties).map(([key, propertySchema]) => [
        key,
        googleSchemaToJsonSchema({
          schema: propertySchema,
          topLevelSchemas: input.topLevelSchemas,
        }),
      ]),
    );

    const convertedAdditionalProperties =
      additionalProperties === undefined
        ? undefined
        : additionalProperties === true
          ? true
          : googleSchemaToJsonSchema({
            schema: additionalProperties,
            topLevelSchemas: input.topLevelSchemas,
          });

    return {
      ...base,
      type: "object",
      ...(Object.keys(convertedProperties).length > 0
        ? { properties: convertedProperties }
        : {}),
      ...(convertedAdditionalProperties !== undefined
        ? { additionalProperties: convertedAdditionalProperties }
        : {}),
    };
  }

  if (type === "boolean" || type === "number" || type === "integer" || type === "string") {
    return {
      ...base,
      type,
    };
  }

  return Object.keys(base).length > 0 ? base : {};
};

const parameterToJsonSchema = (input: {
  parameter: DiscoveryParameter;
  topLevelSchemas: Readonly<Record<string, DiscoverySchema>>;
}): unknown => {
  const schema = googleSchemaToJsonSchema({
    schema: input.parameter,
    topLevelSchemas: input.topLevelSchemas,
  });
  const repeated = input.parameter.repeated === true;
  if (!repeated) {
    return schema;
  }

  return {
    type: "array",
    items: schema,
  };
};

const methodRequestSchemaJson = (input: {
  method: DiscoveryMethod;
  topLevelSchemas: Readonly<Record<string, DiscoverySchema>>;
}): string | undefined => {
  const methodRecord = asRecord(input.method);
  const parameters = asRecord(methodRecord.parameters);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, rawParameter] of Object.entries(parameters)) {
    const parameter = asRecord(rawParameter) as DiscoveryParameter;
    properties[name] = parameterToJsonSchema({
      parameter,
      topLevelSchemas: input.topLevelSchemas,
    });
    if (parameter.required === true) {
      required.push(name);
    }
  }

  const requestRef = asString(asRecord(methodRecord.request).$ref);
  if (requestRef) {
    const requestSchema = input.topLevelSchemas[requestRef];
    if (requestSchema) {
      properties.body = googleSchemaToJsonSchema({
        schema: requestSchema,
        topLevelSchemas: input.topLevelSchemas,
      });
    } else {
      properties.body = { $ref: schemaRefKey(requestRef) };
    }
  }

  if (Object.keys(properties).length === 0) {
    return undefined;
  }

  return JSON.stringify({
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  });
};

const methodResponseSchemaJson = (input: {
  method: DiscoveryMethod;
  topLevelSchemas: Readonly<Record<string, DiscoverySchema>>;
}): string | undefined => {
  const responseRef = asString(asRecord(asRecord(input.method).response).$ref);
  if (!responseRef) {
    return undefined;
  }

  const responseSchema = input.topLevelSchemas[responseRef];
  const schemaJson = responseSchema
    ? googleSchemaToJsonSchema({
      schema: responseSchema,
      topLevelSchemas: input.topLevelSchemas,
    })
    : { $ref: schemaRefKey(responseRef) };

  return JSON.stringify(schemaJson);
};

const parameterRecordFromMethod = (
  method: DiscoveryMethod,
): ReadonlyArray<GoogleDiscoveryMethodParameter> =>
  Object.entries(asRecord(asRecord(method).parameters))
    .flatMap(([name, rawParameter]) => {
      const parameter = asRecord(rawParameter) as DiscoveryParameter;
      const location = asString(parameter.location);
      if (location !== "path" && location !== "query" && location !== "header") {
        return [];
      }

      return [{
        name,
        location,
        required: parameter.required === true,
        repeated: parameter.repeated === true,
        description: asString(parameter.description),
        type: asString(parameter.type) ?? asString(parameter.$ref),
        ...(asStringArray(parameter.enum).length > 0
          ? { enum: [...asStringArray(parameter.enum)] }
          : {}),
        ...(asString(parameter.default) ? { default: asString(parameter.default)! } : {}),
      } satisfies GoogleDiscoveryMethodParameter];
    });

const scopesRecordFromDocument = (
  document: DiscoveryDocument,
): Record<string, string> | undefined => {
  const scopes = asRecord(
    asRecord(
      asRecord(document.auth).oauth2,
    ).scopes,
  );

  const normalized = Object.fromEntries(
    Object.entries(scopes).flatMap(([scope, rawValue]) => {
      const description = asString(asRecord(rawValue).description) ?? "";
      return [[scope, description]];
    }),
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const manifestMethodFromDiscoveryMethod = (input: {
  service: string;
  version: string;
  rootUrl: string;
  servicePath: string;
  topLevelSchemas: Readonly<Record<string, DiscoverySchema>>;
  method: DiscoveryMethod;
}): GoogleDiscoveryManifestMethod | null => {
  const methodId = asString(input.method.id);
  const path = asString(input.method.path);
  if (!methodId || !path) {
    return null;
  }

  const method = normalizeHttpMethod(input.method.httpMethod);
  const rawToolId = methodId;
  const toolId = rawToolId.startsWith(`${input.service}.`)
    ? rawToolId.slice(input.service.length + 1)
    : rawToolId;
  const segments = toolId.split(".").filter((segment) => segment.length > 0);
  const leaf = segments.at(-1) ?? toolId;
  const group = segments.length > 1 ? segments.slice(0, -1).join(".") : null;
  const responseRef = asString(asRecord(asRecord(input.method).response).$ref);
  const requestRef = asString(asRecord(asRecord(input.method).request).$ref);
  const mediaUpload = asRecord(input.method.mediaUpload);

  return {
    toolId,
    rawToolId,
    methodId,
    name: toolId,
    description: asString(input.method.description),
    group,
    leaf,
    method,
    path,
    flatPath: asString(input.method.flatPath),
    parameters: parameterRecordFromMethod(input.method),
    requestSchemaId: requestRef,
    responseSchemaId: responseRef,
    scopes: [...asStringArray(input.method.scopes)],
    supportsMediaUpload: Object.keys(mediaUpload).length > 0,
    supportsMediaDownload: asBoolean(input.method.supportsMediaDownload) === true,
    ...(methodRequestSchemaJson({
      method: input.method,
      topLevelSchemas: input.topLevelSchemas,
    })
      ? {
        inputSchema: parseJson(
          methodRequestSchemaJson({
            method: input.method,
            topLevelSchemas: input.topLevelSchemas,
          }),
        ),
      }
      : {}),
    ...(methodResponseSchemaJson({
      method: input.method,
      topLevelSchemas: input.topLevelSchemas,
    })
      ? {
        outputSchema: parseJson(
          methodResponseSchemaJson({
            method: input.method,
            topLevelSchemas: input.topLevelSchemas,
          }),
        ),
      }
      : {}),
  };
};

const collectDiscoveryMethods = (input: {
  service: string;
  version: string;
  rootUrl: string;
  servicePath: string;
  topLevelSchemas: Readonly<Record<string, DiscoverySchema>>;
  resource: DiscoveryResource | JsonObject | unknown;
}): ReadonlyArray<GoogleDiscoveryManifestMethod> => {
  const resource = asRecord(input.resource) as DiscoveryResource;
  const methods = Object.values(asRecord(resource.methods)).flatMap((method) => {
    try {
      const manifestMethod = manifestMethodFromDiscoveryMethod({
        service: input.service,
        version: input.version,
        rootUrl: input.rootUrl,
        servicePath: input.servicePath,
        topLevelSchemas: input.topLevelSchemas,
        method: asRecord(method) as DiscoveryMethod,
      });
      return manifestMethod ? [manifestMethod] : [];
    } catch {
      return [];
    }
  });
  const nested = Object.values(asRecord(resource.resources)).flatMap((nestedResource) =>
    collectDiscoveryMethods({
      ...input,
      resource: nestedResource,
    }));

  return [...methods, ...nested];
};

export const extractGoogleDiscoveryManifest = (
  sourceName: string,
  discoveryInput: string | JsonObject,
): Effect.Effect<GoogleDiscoveryToolManifest, Error, never> =>
  Effect.try({
    try: () => {
      const document = typeof discoveryInput === "string"
        ? JSON.parse(discoveryInput) as DiscoveryDocument
        : discoveryInput as DiscoveryDocument;

      const service = asString(document.name);
      const versionName = asString(document.version);
      const rootUrl = asString(document.rootUrl);
      const servicePath = typeof document.servicePath === "string" ? document.servicePath : "";

      if (!service || !versionName || !rootUrl) {
        throw new Error(`Invalid Google Discovery document for ${sourceName}`);
      }

      const schemas = Object.fromEntries(
        Object.entries(asRecord(document.schemas)).map(([schemaId, rawSchema]) => [
          schemaId,
          asRecord(rawSchema) as DiscoverySchema,
        ]),
      );
      const schemaRefTable = Object.fromEntries(
        Object.entries(schemas).map(([schemaId, schema]) => [
          schemaRefKey(schemaId),
          JSON.stringify(
            googleSchemaToJsonSchema({
              schema,
              topLevelSchemas: schemas,
            }),
          ),
        ]),
      ) satisfies GoogleDiscoverySchemaRefTable;
      const methods = [
        ...Object.values(asRecord(document.methods)).flatMap((method) => {
          const manifestMethod = manifestMethodFromDiscoveryMethod({
            service,
            version: versionName,
            rootUrl,
            servicePath,
            topLevelSchemas: schemas,
            method: asRecord(method) as DiscoveryMethod,
          });
          return manifestMethod ? [manifestMethod] : [];
        }),
        ...Object.values(asRecord(document.resources)).flatMap((resource) =>
          collectDiscoveryMethods({
            service,
            version: versionName,
            rootUrl,
            servicePath,
            topLevelSchemas: schemas,
            resource,
          })),
      ].sort((left, right) => left.toolId.localeCompare(right.toolId));

      const sourceHash = contentHash(
        typeof discoveryInput === "string"
          ? discoveryInput
          : JSON.stringify(discoveryInput),
      );

      return {
        version: 1,
        sourceHash,
        service,
        versionName,
        title: asString(document.title),
        description: asString(document.description),
        rootUrl,
        servicePath,
        batchPath: asString(document.batchPath),
        documentationLink: asString(document.documentationLink),
        ...(Object.keys(schemaRefTable).length > 0 ? { schemaRefTable } : {}),
        ...(scopesRecordFromDocument(document)
          ? { oauthScopes: scopesRecordFromDocument(document)! }
          : {}),
        methods,
      };
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`Failed to extract Google Discovery manifest: ${String(cause)}`),
  });

export const compileGoogleDiscoveryToolDefinitions = (
  manifest: GoogleDiscoveryToolManifest,
): Array<GoogleDiscoveryManifestMethod> => [...manifest.methods];
