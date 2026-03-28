import {
  applyCookiePlacementsToHeaders,
  applyHttpQueryPlacementsToUrl,
  applyJsonBodyPlacements,
  sha256Hex,
  standardSchemaFromJsonSchema,
  toTool,
  type HttpRequestPlacements,
  type ToolDescriptor,
  type ToolMap,
  type ToolMetadata,
  type ToolPath,
  typeSignatureFromSchema,
} from "@executor/codemode-core";
import { sourceCoreEffectError } from "@executor/source-core";
import {
  GraphqlToolProviderDataSchema,
  type GraphqlToolProviderData,
} from "./provider-data";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  buildClientSchema,
  getIntrospectionQuery,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  type GraphQLArgument,
  type GraphQLInputObjectType,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type IntrospectionQuery,
} from "graphql";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";

type JsonSchema = Record<string, unknown>;
type GraphqlSchemaRefTable = Record<string, string>;

type GraphqlOperationType = "query" | "mutation";

const GRAPHQL_PRESENTATION_TYPE_MAX_LENGTH = 320;

type GraphqlManifestToolBase = {
  toolId: string;
  rawToolId: string | null;
  toolName: string;
  description: string | null;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  exampleInput?: unknown;
};

export type GraphqlRequestToolManifestEntry = GraphqlManifestToolBase & {
  kind: "request";
};

export type GraphqlFieldToolManifestEntry = GraphqlManifestToolBase & {
  kind: "field";
  group: GraphqlOperationType;
  leaf: string;
  fieldName: string;
  operationType: GraphqlOperationType;
  operationName: string;
  operationDocument: string;
  searchTerms: readonly string[];
};

export type GraphqlToolManifestEntry =
  | GraphqlRequestToolManifestEntry
  | GraphqlFieldToolManifestEntry;

export type GraphqlToolManifest = {
  version: 2;
  sourceHash: string;
  queryTypeName: string | null;
  mutationTypeName: string | null;
  subscriptionTypeName: string | null;
  schemaRefTable?: GraphqlSchemaRefTable;
  tools: readonly GraphqlToolManifestEntry[];
};

export type GraphqlToolDefinition = {
  toolId: string;
  rawToolId: string | null;
  name: string;
  description: string;
  group: string | null;
  leaf: string | null;
  fieldName: string | null;
  operationType: GraphqlOperationType | null;
  operationName: string | null;
  operationDocument: string | null;
  searchTerms: readonly string[];
};

export type GraphqlToolPresentation = {
  inputTypePreview: string;
  outputTypePreview: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  exampleInput?: unknown;
  providerData: GraphqlToolProviderData;
};

type GraphqlToolPresentationResolver = {
  resolve(definition: GraphqlToolDefinition): GraphqlToolPresentation;
};

type SelectedGraphqlOutput = {
  selectionSet: string;
  schema: JsonSchema;
};

type GraphqlHttpInvocation = {
  endpoint: string;
  path: string;
  defaultHeaders?: Readonly<Record<string, string>>;
  credentialHeaders?: Readonly<Record<string, string>>;
  credentialPlacements?: HttpRequestPlacements;
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  requestHeaders?: Record<string, string>;
};

const BLOCKED_RESPONSE_HEADER_NAMES = new Set([
  "authorization",
  "authentication-info",
  "cookie",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "set-cookie2",
  "www-authenticate",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
]);

const PREFERRED_LEAF_FIELD_NAMES = [
  "id",
  "identifier",
  "key",
  "slug",
  "name",
  "title",
  "number",
  "url",
  "state",
  "status",
  "success",
] as const;

const PREFERRED_NESTED_FIELD_NAMES = [
  "node",
  "nodes",
  "edge",
  "edges",
  "pageInfo",
  "viewer",
  "user",
  "users",
  "team",
  "teams",
  "project",
  "projects",
  "organization",
  "issue",
  "issues",
  "creator",
  "assignee",
  "items",
] as const;

const asToolPath = (value: string): ToolPath => value as ToolPath;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const asStringRecord = (value: unknown): Record<string, string> => {
  const record = asRecord(value);
  const normalized: Record<string, string> = {};

  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") {
      normalized[key] = entry;
    }
  }

  return normalized;
};

const sanitizeResponseHeaders = (
  headers: Readonly<Record<string, string>>,
): Record<string, string> => {
  const sanitized: Record<string, string> = {};

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim().toLowerCase();
    if (name.length === 0 || BLOCKED_RESPONSE_HEADER_NAMES.has(name)) {
      continue;
    }

    sanitized[name] = rawValue;
  }

  return sanitized;
};

const normalizeHttpUrl = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("GraphQL endpoint is empty");
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("GraphQL endpoint must be http or https");
  }

  return parsed.toString();
};

const graphqlToolError = (message: string, cause?: unknown): Error =>
  new Error(cause instanceof Error ? `${message}: ${cause.message}` : message);

const parseGraphqlResponseBody = async (
  response: Response,
): Promise<unknown> => {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }

  return await response.text();
};

const hasGraphqlErrors = (value: unknown): boolean =>
  Array.isArray(asRecord(value).errors);

const splitWords = (value: string): Array<string> =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z0-9]+)/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);

const toCamelCase = (value: string): string => {
  const words = splitWords(value).map((part) => part.toLowerCase());
  if (words.length === 0) {
    return "tool";
  }

  const [first, ...rest] = words;
  return `${first}${rest.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join("")}`;
};

const toPascalCase = (value: string): string => {
  const camel = toCamelCase(value);
  return `${camel[0]?.toUpperCase() ?? ""}${camel.slice(1)}`;
};

const toTitleCase = (value: string): string =>
  splitWords(value)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");

const withSchemaDescription = (
  schema: JsonSchema,
  description: string | null | undefined,
): JsonSchema => {
  const trimmed = description?.trim();
  return trimmed ? { ...schema, description: trimmed } : schema;
};

const withSchemaDefault = (schema: JsonSchema, value: unknown): JsonSchema =>
  value !== undefined ? { ...schema, default: value } : schema;

const withSchemaDeprecation = (
  schema: JsonSchema,
  deprecationReason: string | null | undefined,
): JsonSchema => {
  const trimmed = deprecationReason?.trim();
  return trimmed
    ? { ...schema, deprecated: true, "x-deprecationReason": trimmed }
    : schema;
};

const introspectionQueryFromDocument = (
  documentText: string,
): IntrospectionQuery => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentText) as unknown;
  } catch (cause) {
    throw new Error(
      `GraphQL document is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const record = asRecord(parsed);
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    const messages = record.errors
      .map((entry) => asString(asRecord(entry).message))
      .filter((message): message is string => message !== null);
    throw new Error(
      messages.length > 0
        ? `GraphQL introspection returned errors: ${messages.join("; ")}`
        : "GraphQL introspection returned errors",
    );
  }

  const data = record.data;
  if (!data || typeof data !== "object" || !("__schema" in data)) {
    throw new Error("GraphQL introspection document is missing data.__schema");
  }

  return data as IntrospectionQuery;
};

const GRAPHQL_REQUEST_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "GraphQL query or mutation document.",
    },
    variables: {
      type: "object",
      description: "Optional GraphQL variables.",
      additionalProperties: true,
    },
    operationName: {
      type: "string",
      description: "Optional GraphQL operation name.",
    },
    headers: {
      type: "object",
      description: "Optional per-request headers.",
      additionalProperties: {
        type: "string",
      },
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const GRAPHQL_REQUEST_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "number",
    },
    headers: {
      type: "object",
      additionalProperties: {
        type: "string",
      },
    },
    body: {},
  },
  required: ["status", "headers", "body"],
  additionalProperties: false,
} as const;

export const GRAPHQL_INTROSPECTION_QUERY = getIntrospectionQuery({
  descriptions: true,
  inputValueDeprecation: true,
  schemaDescription: true,
});

const scalarInputSchema = (name: string): JsonSchema => {
  switch (name) {
    case "String":
    case "ID":
    case "Date":
    case "DateTime":
    case "DateTimeOrDuration":
    case "Duration":
    case "UUID":
    case "TimelessDate":
    case "TimelessDateOrDuration":
    case "URI":
      return { type: "string" };
    case "Int":
    case "Float":
      return { type: "number" };
    case "Boolean":
      return { type: "boolean" };
    case "JSONObject":
      return {
        type: "object",
        additionalProperties: true,
      };
    case "JSONString":
      return { type: "string" };
    case "JSON":
      return {};
    default:
      return {};
  }
};

const scalarExampleValue = (name: string): unknown => {
  switch (name) {
    case "String":
      return "value";
    case "ID":
      return "id";
    case "Date":
      return "2026-03-08";
    case "DateTime":
    case "DateTimeOrDuration":
      return "2026-03-08T00:00:00.000Z";
    case "UUID":
      return "00000000-0000-0000-0000-000000000000";
    case "TimelessDate":
    case "TimelessDateOrDuration":
      return "2026-03-08";
    case "Duration":
      return "P1D";
    case "URI":
      return "https://example.com";
    case "Int":
      return 1;
    case "Float":
      return 1.5;
    case "Boolean":
      return true;
    case "JSONObject":
      return {};
    case "JSONString":
      return "{}";
    default:
      return {};
  }
};

const GRAPHQL_SCHEMA_REF_PREFIX = "#/$defs/graphql";

const graphqlScalarRef = (name: string): string =>
  `${GRAPHQL_SCHEMA_REF_PREFIX}/scalars/${name}`;

const graphqlEnumRef = (name: string): string =>
  `${GRAPHQL_SCHEMA_REF_PREFIX}/enums/${name}`;

const graphqlInputObjectRef = (name: string): string =>
  `${GRAPHQL_SCHEMA_REF_PREFIX}/input/${name}`;

const graphqlOutputTypeRef = (name: string, depth: number): string =>
  `${GRAPHQL_SCHEMA_REF_PREFIX}/output/${depth === 0 ? name : `${name}__depth${depth}`}`;

const graphqlTypenameOnlyOutputRef = (): string =>
  `${GRAPHQL_SCHEMA_REF_PREFIX}/output/GraphqlTypenameOnly`;

const schemaRef = (ref: string): JsonSchema => ({
  $ref: ref,
});

const typenameOnlyObjectSchema = (): JsonSchema => ({
  type: "object",
  properties: {
    __typename: { type: "string" },
  },
  required: ["__typename"],
  additionalProperties: false,
});

const createGraphqlSchemaRefTableBuilder = () => {
  const refTable: GraphqlSchemaRefTable = {};
  const outputSelectionsByRef = new Map<string, SelectedGraphqlOutput>();

  const defineRefSchema = (ref: string, schema: JsonSchema): void => {
    refTable[ref] = JSON.stringify(schema);
  };

  const ensureTypenameOnlyOutputRef = (): JsonSchema => {
    const ref = graphqlTypenameOnlyOutputRef();
    if (!(ref in refTable)) {
      defineRefSchema(ref, typenameOnlyObjectSchema());
    }

    return schemaRef(ref);
  };

  const ensureScalarRef = (name: string): JsonSchema => {
    const ref = graphqlScalarRef(name);
    if (!(ref in refTable)) {
      defineRefSchema(ref, scalarInputSchema(name));
    }

    return schemaRef(ref);
  };

  const ensureEnumRef = (
    name: string,
    values: readonly string[],
  ): JsonSchema => {
    const ref = graphqlEnumRef(name);
    if (!(ref in refTable)) {
      defineRefSchema(ref, {
        type: "string",
        enum: [...values],
      });
    }

    return schemaRef(ref);
  };

  const ensureInputObjectRef = (
    namedType: GraphQLInputObjectType,
  ): JsonSchema => {
    const ref = graphqlInputObjectRef(namedType.name);
    if (!(ref in refTable)) {
      defineRefSchema(ref, {});

      const fields = Object.values(namedType.getFields());
      const properties = Object.fromEntries(
        fields.map((field) => {
          const schema = inputSchemaForType(field.type);
          const enriched = withSchemaDeprecation(
            withSchemaDefault(
              withSchemaDescription(schema, field.description),
              field.defaultValue,
            ),
            field.deprecationReason,
          );
          return [field.name, enriched];
        }),
      );
      const required = fields
        .filter(
          (field) =>
            isNonNullType(field.type) && field.defaultValue === undefined,
        )
        .map((field) => field.name);

      defineRefSchema(ref, {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      });
    }

    return schemaRef(ref);
  };

  const inputSchemaForType = (type: GraphQLInputType): JsonSchema => {
    if (isNonNullType(type)) {
      return inputSchemaForType(type.ofType);
    }

    if (isListType(type)) {
      return {
        type: "array",
        items: inputSchemaForType(type.ofType),
      };
    }

    const namedType = getNamedType(type);
    if (isScalarType(namedType)) {
      return ensureScalarRef(namedType.name);
    }

    if (isEnumType(namedType)) {
      return ensureEnumRef(
        namedType.name,
        namedType.getValues().map((value) => value.name),
      );
    }

    if (isInputObjectType(namedType)) {
      return ensureInputObjectRef(namedType);
    }

    return {};
  };

  const selectedOutputForNamedType = (
    namedType: GraphQLNamedType,
    depth: number,
  ): SelectedGraphqlOutput => {
    if (isScalarType(namedType)) {
      return {
        selectionSet: "",
        schema: ensureScalarRef(namedType.name),
      };
    }

    if (isEnumType(namedType)) {
      return {
        selectionSet: "",
        schema: ensureEnumRef(
          namedType.name,
          namedType.getValues().map((value) => value.name),
        ),
      };
    }

    const ref = graphqlOutputTypeRef(namedType.name, depth);
    const cached = outputSelectionsByRef.get(ref);
    if (cached) {
      return cached;
    }

    if (isUnionType(namedType)) {
      const result = {
        selectionSet: "{ __typename }",
        schema: ensureTypenameOnlyOutputRef(),
      } satisfies SelectedGraphqlOutput;
      outputSelectionsByRef.set(ref, result);
      return result;
    }

    if (!isObjectType(namedType) && !isInterfaceType(namedType)) {
      return {
        selectionSet: "{ __typename }",
        schema: ensureTypenameOnlyOutputRef(),
      };
    }

    const fallback = {
      selectionSet: "{ __typename }",
      schema: ensureTypenameOnlyOutputRef(),
    } satisfies SelectedGraphqlOutput;
    outputSelectionsByRef.set(ref, fallback);

    if (depth >= 2) {
      return fallback;
    }

    const fields = Object.values(namedType.getFields()).filter(
      (field) => !field.name.startsWith("__"),
    );
    const leafFields = fields.filter((field) =>
      isLeafType(getNamedType(field.type)),
    );
    const nestedFields = fields.filter(
      (field) => !isLeafType(getNamedType(field.type)),
    );

    const selectedLeafFields = pickPreferredFields({
      fields: leafFields,
      preferredNames: PREFERRED_LEAF_FIELD_NAMES,
      limit: 3,
    });
    const selectedNestedFields = pickPreferredFields({
      fields: nestedFields,
      preferredNames: PREFERRED_NESTED_FIELD_NAMES,
      limit: 2,
    });
    const selectedFields = dedupeFields([
      ...selectedLeafFields,
      ...selectedNestedFields,
    ]);

    if (selectedFields.length === 0) {
      return fallback;
    }

    const selectionParts: string[] = [];
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const field of selectedFields) {
      const selected = selectedOutputForType(field.type, depth + 1);
      const propertySchema = withSchemaDeprecation(
        withSchemaDescription(selected.schema, field.description),
        field.deprecationReason,
      );

      properties[field.name] = propertySchema;
      required.push(field.name);
      selectionParts.push(
        selected.selectionSet.length > 0
          ? `${field.name} ${selected.selectionSet}`
          : field.name,
      );
    }

    properties.__typename = { type: "string" };
    required.push("__typename");
    selectionParts.push("__typename");

    defineRefSchema(ref, {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    });

    const result = {
      selectionSet: `{ ${selectionParts.join(" ")} }`,
      schema: schemaRef(ref),
    } satisfies SelectedGraphqlOutput;
    outputSelectionsByRef.set(ref, result);
    return result;
  };

  const selectedOutputForType = (
    type: GraphQLOutputType,
    depth = 0,
  ): SelectedGraphqlOutput => {
    if (isNonNullType(type)) {
      return selectedOutputForType(type.ofType, depth);
    }

    if (isListType(type)) {
      const selectedItem = selectedOutputForType(type.ofType, depth);
      return {
        selectionSet: selectedItem.selectionSet,
        schema: {
          type: "array",
          items: selectedItem.schema,
        },
      };
    }

    return selectedOutputForNamedType(getNamedType(type), depth);
  };

  return {
    refTable,
    inputSchemaForType,
    selectedOutputForType,
  };
};

const exampleValueForGraphqlInputType = (
  type: GraphQLInputType,
  depth = 0,
): unknown => {
  if (isNonNullType(type)) {
    return exampleValueForGraphqlInputType(type.ofType, depth);
  }

  if (isListType(type)) {
    return [exampleValueForGraphqlInputType(type.ofType, depth + 1)];
  }

  const namedType = getNamedType(type);
  if (isScalarType(namedType)) {
    return scalarExampleValue(namedType.name);
  }

  if (isEnumType(namedType)) {
    return namedType.getValues()[0]?.name ?? "VALUE";
  }

  if (isInputObjectType(namedType)) {
    if (depth >= 2) {
      return {};
    }

    const fields = Object.values(namedType.getFields());
    const requiredFields = fields.filter(
      (field) => isNonNullType(field.type) && field.defaultValue === undefined,
    );
    const fieldsForExample =
      requiredFields.length > 0 ? requiredFields : fields.slice(0, 1);

    return Object.fromEntries(
      fieldsForExample.map((field) => [
        field.name,
        field.defaultValue ??
          exampleValueForGraphqlInputType(field.type, depth + 1),
      ]),
    );
  }

  return {};
};

const dedupeFields = <T extends { name: string }>(
  fields: readonly T[],
): T[] => {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const field of fields) {
    if (seen.has(field.name)) {
      continue;
    }

    seen.add(field.name);
    deduped.push(field);
  }

  return deduped;
};

const pickPreferredFields = <T extends { name: string }>(input: {
  fields: readonly T[];
  preferredNames: readonly string[];
  limit: number;
}): T[] => {
  const matches = input.preferredNames
    .map((name) => input.fields.find((field) => field.name === name))
    .filter((field): field is T => field !== undefined);

  if (matches.length >= input.limit) {
    return dedupeFields(matches).slice(0, input.limit);
  }

  return dedupeFields([...matches, ...input.fields]).slice(0, input.limit);
};

const printGraphqlType = (type: GraphQLInputType): string => {
  if (isNonNullType(type)) {
    return `${printGraphqlType(type.ofType)}!`;
  }

  if (isListType(type)) {
    return `[${printGraphqlType(type.ofType)}]`;
  }

  return type.name;
};

const inputSchemaForFieldArguments = (
  args: readonly GraphQLArgument[],
  bundleBuilder: ReturnType<typeof createGraphqlSchemaRefTableBuilder>,
): JsonSchema => {
  const properties = Object.fromEntries(
    args.map((arg) => {
      const schema = bundleBuilder.inputSchemaForType(arg.type);
      const enriched = withSchemaDeprecation(
        withSchemaDefault(
          withSchemaDescription(schema, arg.description),
          arg.defaultValue,
        ),
        arg.deprecationReason,
      );
      return [arg.name, enriched];
    }),
  );
  const required = args
    .filter((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined)
    .map((arg) => arg.name);

  return {
    type: "object",
    properties: {
      ...properties,
      headers: {
        type: "object",
        description: "Optional per-request headers.",
        additionalProperties: {
          type: "string",
        },
      },
    },
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
};

const outputEnvelopeSchemaForField = (
  fieldType: GraphQLOutputType,
  bundleBuilder: ReturnType<typeof createGraphqlSchemaRefTableBuilder>,
): JsonSchema => {
  const selectedOutput = bundleBuilder.selectedOutputForType(fieldType);

  return {
    type: "object",
    properties: {
      data: withSchemaDescription(
        selectedOutput.schema,
        "Value returned for the selected GraphQL field.",
      ),
      errors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "GraphQL error message.",
            },
            path: {
              type: "array",
              description: "Path to the field that produced the error.",
              items: {
                anyOf: [
                  { type: "string" },
                  { type: "number" },
                ],
              },
            },
            locations: {
              type: "array",
              description: "Source locations for the error in the GraphQL document.",
              items: {
                type: "object",
                properties: {
                  line: { type: "number" },
                  column: { type: "number" },
                },
                required: ["line", "column"],
                additionalProperties: false,
              },
            },
            extensions: {
              type: "object",
              description: "Additional provider-specific GraphQL error metadata.",
              additionalProperties: true,
            },
          },
          required: ["message"],
          additionalProperties: true,
        },
      },
    },
    required: ["data", "errors"],
    additionalProperties: false,
  };
};

const exampleInputForField = (
  args: readonly GraphQLArgument[],
): Record<string, unknown> | undefined => {
  if (args.length === 0) {
    return {};
  }

  const requiredArgs = args.filter(
    (arg) => isNonNullType(arg.type) && arg.defaultValue === undefined,
  );
  const argsForExample =
    requiredArgs.length > 0 ? requiredArgs : args.slice(0, 1);
  const example = Object.fromEntries(
    argsForExample.map((arg) => [
      arg.name,
      arg.defaultValue ?? exampleValueForGraphqlInputType(arg.type),
    ]),
  );

  return example;
};

const buildGraphqlFieldOperationDocument = (input: {
  operationType: GraphqlOperationType;
  fieldName: string;
  args: readonly GraphQLArgument[];
  fieldType: GraphQLOutputType;
  bundleBuilder: ReturnType<typeof createGraphqlSchemaRefTableBuilder>;
}): { operationName: string; operationDocument: string } => {
  const selectedOutput = input.bundleBuilder.selectedOutputForType(
    input.fieldType,
  );
  const operationName = `${toPascalCase(input.operationType)}${toPascalCase(input.fieldName)}`;
  const variableDefinitions = input.args
    .map((arg) => `$${arg.name}: ${printGraphqlType(arg.type)}`)
    .join(", ");
  const fieldArguments = input.args
    .map((arg) => `${arg.name}: $${arg.name}`)
    .join(", ");
  const fieldCall =
    fieldArguments.length > 0
      ? `${input.fieldName}(${fieldArguments})`
      : input.fieldName;
  const selectionSuffix =
    selectedOutput.selectionSet.length > 0
      ? ` ${selectedOutput.selectionSet}`
      : "";

  return {
    operationName,
    operationDocument: `${input.operationType} ${operationName}${variableDefinitions.length > 0 ? `(${variableDefinitions})` : ""} { ${fieldCall}${selectionSuffix} }`,
  };
};

const defaultDescriptionForField = (input: {
  operationType: GraphqlOperationType;
  fieldName: string;
  description: string | null | undefined;
}): string => {
  const trimmed = input.description?.trim();
  if (trimmed) {
    return trimmed;
  }

  return `Execute the GraphQL ${input.operationType} field '${input.fieldName}'.`;
};

const requestToolManifestEntry = (
  sourceName: string,
): GraphqlRequestToolManifestEntry => ({
  kind: "request",
  toolId: "request",
  rawToolId: "request",
  toolName: "GraphQL request",
  description: `Execute a raw GraphQL request against ${sourceName}.`,
  inputSchema: GRAPHQL_REQUEST_INPUT_SCHEMA,
  outputSchema: GRAPHQL_REQUEST_OUTPUT_SCHEMA,
  exampleInput: {
    query: "query { __typename }",
  },
});

type GraphqlFieldToolDraft = Omit<GraphqlFieldToolManifestEntry, "toolId"> & {
  toolId: string;
};

const resolveGraphqlFieldToolIds = (
  drafts: readonly GraphqlFieldToolDraft[],
): GraphqlFieldToolManifestEntry[] => {
  const staged = drafts.map((draft) => ({ ...draft }));
  const requestToolId = "request";

  const applyDuplicates = (
    factory: (draft: GraphqlFieldToolDraft) => string,
  ): void => {
    const buckets = new Map<string, GraphqlFieldToolDraft[]>();

    for (const draft of staged) {
      const bucket = buckets.get(draft.toolId) ?? [];
      bucket.push(draft);
      buckets.set(draft.toolId, bucket);
    }

    for (const [toolId, bucket] of buckets.entries()) {
      if (bucket.length < 2 && toolId !== requestToolId) {
        continue;
      }

      for (const draft of bucket) {
        draft.toolId = factory(draft);
      }
    }
  };

  applyDuplicates(
    (draft) => `${draft.leaf}${toPascalCase(draft.operationType)}`,
  );
  applyDuplicates(
    (draft) =>
      `${draft.leaf}${toPascalCase(draft.operationType)}${sha256Hex(`${draft.group}:${draft.fieldName}`).slice(0, 6)}`,
  );

  return staged
    .sort(
      (left, right) =>
        left.toolId.localeCompare(right.toolId) ||
        left.fieldName.localeCompare(right.fieldName) ||
        left.operationType.localeCompare(right.operationType),
    )
    .map((draft) => ({ ...draft }));
};

const fieldToolDraftsFromRootType = (input: {
  rootType:
    | ReturnType<GraphQLSchema["getQueryType"]>
    | ReturnType<GraphQLSchema["getMutationType"]>;
  operationType: GraphqlOperationType;
  bundleBuilder: ReturnType<typeof createGraphqlSchemaRefTableBuilder>;
}): GraphqlFieldToolDraft[] => {
  if (!input.rootType) {
    return [];
  }

  return Object.values(input.rootType.getFields())
    .filter((field) => !field.name.startsWith("__"))
    .map((field) => {
      const leaf = toCamelCase(field.name);
      const outputSchema = outputEnvelopeSchemaForField(
        field.type,
        input.bundleBuilder,
      );
      const inputSchema = inputSchemaForFieldArguments(
        field.args,
        input.bundleBuilder,
      );
      const { operationName, operationDocument } =
        buildGraphqlFieldOperationDocument({
          operationType: input.operationType,
          fieldName: field.name,
          args: field.args,
          fieldType: field.type,
          bundleBuilder: input.bundleBuilder,
        });

      return {
        kind: "field",
        toolId: leaf,
        rawToolId: field.name,
        toolName: toTitleCase(field.name),
        description: defaultDescriptionForField({
          operationType: input.operationType,
          fieldName: field.name,
          description: field.description,
        }),
        group: input.operationType,
        leaf,
        fieldName: field.name,
        operationType: input.operationType,
        operationName,
        operationDocument,
        inputSchema,
        outputSchema,
        exampleInput: exampleInputForField(field.args),
        searchTerms: [
          input.operationType,
          field.name,
          ...field.args.map((arg) => arg.name),
          getNamedType(field.type).name,
        ],
      } satisfies GraphqlFieldToolDraft;
    });
};

export const createGraphqlSourceHash = (documentText: string): string =>
  sha256Hex(documentText);

export const extractGraphqlManifest = (
  sourceName: string,
  documentText: string,
): Effect.Effect<GraphqlToolManifest, Error, never> =>
  Effect.try({
    try: () => {
      const introspection = introspectionQueryFromDocument(documentText);
      const schema = buildClientSchema(introspection);
      const sourceHash = createGraphqlSourceHash(documentText);
      const bundleBuilder = createGraphqlSchemaRefTableBuilder();
      const fieldTools = resolveGraphqlFieldToolIds([
        ...fieldToolDraftsFromRootType({
          rootType: schema.getQueryType(),
          operationType: "query",
          bundleBuilder,
        }),
        ...fieldToolDraftsFromRootType({
          rootType: schema.getMutationType(),
          operationType: "mutation",
          bundleBuilder,
        }),
      ]);

      return {
        version: 2,
        sourceHash,
        queryTypeName: schema.getQueryType()?.name ?? null,
        mutationTypeName: schema.getMutationType()?.name ?? null,
        subscriptionTypeName: schema.getSubscriptionType()?.name ?? null,
        ...(Object.keys(bundleBuilder.refTable).length > 0
          ? { schemaRefTable: bundleBuilder.refTable }
          : {}),
        tools: [...fieldTools, requestToolManifestEntry(sourceName)],
      } satisfies GraphqlToolManifest;
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  });

export const compileGraphqlToolDefinitions = (
  manifest: GraphqlToolManifest,
): Array<GraphqlToolDefinition> =>
  manifest.tools.map((tool) => ({
    toolId: tool.toolId,
    rawToolId: tool.rawToolId,
    name: tool.toolName,
    description: tool.description ?? `Execute ${tool.toolName}.`,
    group: tool.kind === "field" ? tool.group : null,
    leaf: tool.kind === "field" ? tool.leaf : null,
    fieldName: tool.kind === "field" ? tool.fieldName : null,
    operationType: tool.kind === "field" ? tool.operationType : null,
    operationName: tool.kind === "field" ? tool.operationName : null,
    operationDocument: tool.kind === "field" ? tool.operationDocument : null,
    searchTerms:
      tool.kind === "field"
        ? tool.searchTerms
        : ["request", "graphql", "query", "mutation"],
  }));

const materializedSchemaRefDefinitions = (refTable?: GraphqlSchemaRefTable): JsonSchema | undefined => {
  if (!refTable || Object.keys(refTable).length === 0) {
    return undefined;
  }

  const defsRoot: JsonSchema = {};
  for (const [ref, value] of Object.entries(refTable)) {
    if (!ref.startsWith("#/$defs/")) {
      continue;
    }

    const materializedValue = typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return value;
          }
        })()
      : value;
    const path = ref
      .slice("#/$defs/".length)
      .split("/")
      .filter((segment) => segment.length > 0);
    setNestedSchemaProperty(defsRoot, path, materializedValue);
  }

  return Object.keys(defsRoot).length > 0 ? defsRoot : undefined;
};

const materializeManifestSchema = (input: {
  schema: JsonSchema | undefined;
  defsRoot: JsonSchema | undefined;
  cache: WeakMap<object, JsonSchema>;
}): JsonSchema | undefined => {
  if (input.schema === undefined) {
    return undefined;
  }

  if (input.defsRoot === undefined) {
    return input.schema;
  }

  const cached = input.cache.get(input.schema);
  if (cached) {
    return cached;
  }

  const existingDefs = input.schema.$defs;
  const materialized = existingDefs && typeof existingDefs === "object" && !Array.isArray(existingDefs)
    ? { ...input.schema, $defs: { ...input.defsRoot, ...existingDefs } }
    : { ...input.schema, $defs: input.defsRoot };

  input.cache.set(input.schema, materialized);
  return materialized;
};

const graphqlToolPresentationResolverCache = new WeakMap<GraphqlToolManifest, GraphqlToolPresentationResolver>();

const graphqlToolPresentationResolver = (
  manifest: GraphqlToolManifest,
): GraphqlToolPresentationResolver => {
  const cached = graphqlToolPresentationResolverCache.get(manifest);
  if (cached) {
    return cached;
  }

  const toolEntriesById = HashMap.fromIterable(
    manifest.tools.map((tool) => [tool.toolId, tool] as const),
  );
  const defsRoot = materializedSchemaRefDefinitions(manifest.schemaRefTable);
  const schemaCache = new WeakMap<object, JsonSchema>();
  const presentationCache = new Map<string, GraphqlToolPresentation>();

  const resolver: GraphqlToolPresentationResolver = {
    resolve(definition) {
      const existing = presentationCache.get(definition.toolId);
      if (existing) {
        return existing;
      }

      const entry = Option.getOrUndefined(HashMap.get(toolEntriesById, definition.toolId));
      const inputSchema = materializeManifestSchema({
        schema: entry?.inputSchema,
        defsRoot,
        cache: schemaCache,
      });
      const outputSchema = materializeManifestSchema({
        schema: entry?.outputSchema,
        defsRoot,
        cache: schemaCache,
      });

      const presentation = {
        inputTypePreview: typeSignatureFromSchema(
          inputSchema,
          "unknown",
          GRAPHQL_PRESENTATION_TYPE_MAX_LENGTH,
        ),
        outputTypePreview: typeSignatureFromSchema(
          outputSchema,
          "unknown",
          GRAPHQL_PRESENTATION_TYPE_MAX_LENGTH,
        ),
        ...(inputSchema !== undefined ? { inputSchema } : {}),
        ...(outputSchema !== undefined ? { outputSchema } : {}),
        ...(entry?.exampleInput !== undefined
          ? { exampleInput: entry.exampleInput }
          : {}),
        providerData: {
          kind: "graphql",
          toolKind: entry?.kind ?? "request",
          toolId: definition.toolId,
          rawToolId: definition.rawToolId,
          group: definition.group,
          leaf: definition.leaf,
          fieldName: definition.fieldName,
          operationType: definition.operationType,
          operationName: definition.operationName,
          operationDocument: definition.operationDocument,
          queryTypeName: manifest.queryTypeName,
          mutationTypeName: manifest.mutationTypeName,
          subscriptionTypeName: manifest.subscriptionTypeName,
        } satisfies GraphqlToolProviderData,
      } satisfies GraphqlToolPresentation;

      presentationCache.set(definition.toolId, presentation);
      return presentation;
    },
  };

  graphqlToolPresentationResolverCache.set(manifest, resolver);
  return resolver;
};

export const buildGraphqlToolPresentation = (input: {
  manifest: GraphqlToolManifest;
  definition: GraphqlToolDefinition;
}): GraphqlToolPresentation => {
  return graphqlToolPresentationResolver(input.manifest).resolve(input.definition);
};

const decodeGraphqlToolProviderData = Schema.decodeUnknownEither(
  GraphqlToolProviderDataSchema,
);

export const decodeGraphqlSchemaRefTableJson = Schema.decodeUnknownEither(
  Schema.parseJson(
    Schema.Record({
      key: Schema.String,
      value: Schema.Unknown,
    }),
  ),
);

const setNestedSchemaProperty = (
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void => {
  if (path.length === 0) {
    return;
  }

  const [head, ...rest] = path;
  if (!head) {
    return;
  }

  if (rest.length === 0) {
    target[head] = value;
    return;
  }

  const next = asRecord(target[head]);
  target[head] = next;
  setNestedSchemaProperty(next, rest, value);
};

const materializeSchemaWithRefDefinitions = (input: {
  schema: unknown;
  refTable?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> => {
  if (input.schema === undefined || input.schema === null) {
    return {};
  }

  const rootSchema = asRecord(input.schema);

  if (!input.refTable || Object.keys(input.refTable).length === 0) {
    return rootSchema;
  }

  const defsRoot = asRecord(rootSchema.$defs);
  for (const [ref, value] of Object.entries(input.refTable)) {
    if (!ref.startsWith("#/$defs/")) {
      continue;
    }

    const materializedValue =
      typeof value === "string"
        ? (() => {
            try {
              return JSON.parse(value) as unknown;
            } catch {
              return value;
            }
          })()
        : value;
    const path = ref
      .slice("#/$defs/".length)
      .split("/")
      .filter((segment) => segment.length > 0);
    setNestedSchemaProperty(defsRoot, path, materializedValue);
  }

  return Object.keys(defsRoot).length > 0
    ? { ...rootSchema, $defs: defsRoot }
    : rootSchema;
};

export const createGraphqlToolFromPersistedOperation = (input: {
  path: string;
  sourceKey: string;
  endpoint: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  exampleInput?: unknown;
  providerData: unknown;
  schemaRefTable?: Readonly<Record<string, unknown>>;
  defaultHeaders?: Readonly<Record<string, string>>;
  credentialHeaders?: Readonly<Record<string, string>>;
  credentialPlacements?: HttpRequestPlacements;
}) => {
  const decodedProviderData = decodeGraphqlToolProviderData(
    input.providerData,
  );
  if (Either.isLeft(decodedProviderData)) {
    throw new Error("Invalid GraphQL provider data");
  }

  const providerData = decodedProviderData.right;
  const inputSchema = materializeSchemaWithRefDefinitions({
    schema: input.inputSchema,
    refTable: input.schemaRefTable,
  });

  const metadata: ToolMetadata = {
    interaction:
      providerData.toolKind === "request"
        ? "auto"
        : providerData.operationType === "query"
          ? "auto"
          : "required",
    contract: {
      inputTypePreview: typeSignatureFromSchema(
        input.inputSchema,
        "unknown",
        GRAPHQL_PRESENTATION_TYPE_MAX_LENGTH,
      ),
      outputTypePreview: typeSignatureFromSchema(
        input.outputSchema,
        "unknown",
        GRAPHQL_PRESENTATION_TYPE_MAX_LENGTH,
      ),
      ...(input.inputSchema !== undefined
        ? { inputSchema: input.inputSchema }
        : {}),
      ...(input.outputSchema !== undefined
        ? { outputSchema: input.outputSchema }
        : {}),
      ...(input.exampleInput !== undefined
        ? { exampleInput: input.exampleInput }
        : {}),
    },
    sourceKey: input.sourceKey,
    pluginKind: "graphql",
    pluginData: providerData,
  };

  return toTool({
    tool: {
      description: input.description,
      inputSchema: standardSchemaFromJsonSchema(inputSchema),
      execute: (args: unknown) => {
        if (
          providerData.toolKind === "field" &&
          providerData.fieldName &&
          providerData.operationType &&
          providerData.operationName &&
          providerData.operationDocument
        ) {
          return Effect.runPromise(
            invokeGraphqlFieldTool({
              entry: {
                fieldName: providerData.fieldName,
                operationName: providerData.operationName,
                operationDocument: providerData.operationDocument,
              },
              endpoint: input.endpoint,
              path: input.path,
              defaultHeaders: input.defaultHeaders,
              credentialHeaders: input.credentialHeaders,
              credentialPlacements: input.credentialPlacements,
              args,
            }),
          );
        }

        return Effect.runPromise(
          invokeRawGraphqlTool({
            endpoint: input.endpoint,
            path: input.path,
            defaultHeaders: input.defaultHeaders,
            credentialHeaders: input.credentialHeaders,
            credentialPlacements: input.credentialPlacements,
            args,
          }),
        );
      },
    },
    metadata,
  });
};

export const graphqlToolDescriptorFromDefinition = (input: {
  manifest: GraphqlToolManifest;
  definition: GraphqlToolDefinition;
  path: string;
  sourceKey: string;
  includeSchemas: boolean;
}): ToolDescriptor => {
  const presentation = buildGraphqlToolPresentation({
    manifest: input.manifest,
    definition: input.definition,
  });

  return {
    path: asToolPath(input.path),
    sourceKey: input.sourceKey,
    description: input.definition.description,
    interaction:
      input.definition.operationType === "query" ? "auto" : "required",
    contract: {
      inputTypePreview: presentation.inputTypePreview,
      outputTypePreview: presentation.outputTypePreview,
      ...(input.includeSchemas && presentation.inputSchema !== undefined
        ? { inputSchema: presentation.inputSchema }
        : {}),
      ...(input.includeSchemas && presentation.outputSchema !== undefined
        ? { outputSchema: presentation.outputSchema }
        : {}),
      ...(presentation.exampleInput !== undefined
        ? { exampleInput: presentation.exampleInput }
        : {}),
    },
    pluginKind: "graphql",
    pluginData: presentation.providerData,
  };
};

const invokeGraphqlHttpRequest = (input: GraphqlHttpInvocation) =>
  Effect.gen(function* () {
    const endpoint = applyHttpQueryPlacementsToUrl({
      url: input.endpoint,
      queryParams: input.credentialPlacements?.queryParams,
    }).toString();
    const requestBody = applyJsonBodyPlacements({
      body: {
        query: input.query,
        ...(input.variables !== undefined
          ? { variables: input.variables }
          : {}),
        ...(input.operationName
          ? { operationName: input.operationName }
          : {}),
      },
      bodyValues: input.credentialPlacements?.bodyValues,
      label: `GraphQL ${input.path}`,
    });
    const headers = applyCookiePlacementsToHeaders({
      headers: {
        "content-type": "application/json",
        ...input.defaultHeaders,
        ...input.requestHeaders,
        ...input.credentialHeaders,
        ...input.credentialPlacements?.headers,
      },
      cookies: input.credentialPlacements?.cookies,
    });

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(endpoint, {
          method: "POST",
          headers: new Headers(headers),
          body: JSON.stringify(requestBody),
        }),
      catch: (cause) =>
        graphqlToolError(`GraphQL request failed for ${input.path}`, cause),
    });
    const body = yield* Effect.tryPromise({
      try: () => parseGraphqlResponseBody(response),
      catch: (cause) =>
        graphqlToolError(
          `Failed decoding GraphQL response for ${input.path}`,
          cause,
        ),
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      status: response.status,
      headers: sanitizeResponseHeaders(responseHeaders),
      body,
      isError: response.status >= 400 || hasGraphqlErrors(body),
    };
  });

const invokeRawGraphqlTool = (input: {
  endpoint: string;
  path: string;
  defaultHeaders?: Readonly<Record<string, string>>;
  credentialHeaders?: Readonly<Record<string, string>>;
  credentialPlacements?: HttpRequestPlacements;
  args: unknown;
}) =>
  Effect.gen(function* () {
    const record = asRecord(input.args);
    const query = asString(record.query);
    if (query === null) {
      return yield* sourceCoreEffectError("graphql/graphql-tools", `GraphQL query must be a non-empty string for ${input.path}`);
    }

    return yield* invokeGraphqlHttpRequest({
      endpoint: input.endpoint,
      path: input.path,
      defaultHeaders: input.defaultHeaders,
      credentialHeaders: input.credentialHeaders,
      credentialPlacements: input.credentialPlacements,
      query,
      variables:
        record.variables !== undefined ? asRecord(record.variables) : undefined,
      operationName: asString(record.operationName) ?? undefined,
      requestHeaders: asStringRecord(record.headers),
    });
  });

const withoutUndefinedEntries = (
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );

const invokeGraphqlFieldTool = (input: {
  entry: Pick<
    GraphqlFieldToolManifestEntry,
    "fieldName" | "operationName" | "operationDocument"
  >;
  endpoint: string;
  path: string;
  defaultHeaders?: Readonly<Record<string, string>>;
  credentialHeaders?: Readonly<Record<string, string>>;
  credentialPlacements?: HttpRequestPlacements;
  args: unknown;
}) =>
  Effect.gen(function* () {
    const record = asRecord(input.args);
    const requestHeaders = asStringRecord(record.headers);
    const variables = withoutUndefinedEntries(
      Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== "headers"),
      ),
    );
    const response = yield* invokeGraphqlHttpRequest({
      endpoint: input.endpoint,
      path: input.path,
      defaultHeaders: input.defaultHeaders,
      credentialHeaders: input.credentialHeaders,
      credentialPlacements: input.credentialPlacements,
      query: input.entry.operationDocument,
      variables,
      operationName: input.entry.operationName,
      requestHeaders,
    });
    const bodyRecord = asRecord(response.body);
    const dataRecord = asRecord(bodyRecord.data);
    const errors = Array.isArray(bodyRecord.errors) ? bodyRecord.errors : [];

    return {
      data: dataRecord[input.entry.fieldName] ?? null,
      errors,
      isError: response.status >= 400 || errors.length > 0,
    };
  });

export const createGraphqlToolsFromManifest = (input: {
  manifest: GraphqlToolManifest;
  endpoint: string;
  namespace: string;
  sourceKey: string;
  defaultHeaders?: Readonly<Record<string, string>>;
  credentialHeaders?: Readonly<Record<string, string>>;
  credentialPlacements?: HttpRequestPlacements;
}): ToolMap => {
  const endpoint = normalizeHttpUrl(input.endpoint);
  const definitions = compileGraphqlToolDefinitions(input.manifest);

  return Object.fromEntries(
    definitions.map((definition) => {
      const presentation = buildGraphqlToolPresentation({
        manifest: input.manifest,
        definition,
      });
      const path = input.namespace
        ? `${input.namespace}.${definition.toolId}`
        : definition.toolId;

      return [
        path,
        createGraphqlToolFromPersistedOperation({
          path,
          sourceKey: input.sourceKey,
          endpoint,
          description: definition.description,
          inputSchema: presentation.inputSchema,
          outputSchema: presentation.outputSchema,
          exampleInput: presentation.exampleInput,
          providerData: presentation.providerData,
          schemaRefTable: input.manifest.schemaRefTable,
          defaultHeaders: input.defaultHeaders,
          credentialHeaders: input.credentialHeaders,
          credentialPlacements: input.credentialPlacements,
        }),
      ] as const;
    }),
  );
};
