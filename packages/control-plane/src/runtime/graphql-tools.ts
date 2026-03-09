import { createHash } from "node:crypto";

import {
  standardSchemaFromJsonSchema,
  toTool,
  type ToolDescriptor,
  type ToolMap,
  type ToolMetadata,
  type ToolPath,
  typeSignatureFromSchemaJson,
} from "@executor-v3/codemode-core";
import * as Effect from "effect/Effect";
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
  type GraphQLField,
  type GraphQLInputType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type IntrospectionQuery,
} from "graphql";

type JsonSchema = Record<string, unknown>;

type GraphqlToolKind = "request" | "field";

type GraphqlOperationType = "query" | "mutation";

type GraphqlManifestToolBase = {
  toolId: string;
  rawToolId: string | null;
  toolName: string;
  description: string | null;
  inputSchemaJson?: string;
  outputSchemaJson?: string;
  exampleInputJson?: string;
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
  inputType: string;
  outputType: string;
  inputSchemaJson?: string;
  outputSchemaJson?: string;
  exampleInputJson?: string;
  providerDataJson: string;
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
  new Error(
    cause instanceof Error ? `${message}: ${cause.message}` : message,
  );

const parseGraphqlResponseBody = async (response: Response): Promise<unknown> => {
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

const withSchemaDefault = (
  schema: JsonSchema,
  value: unknown,
): JsonSchema => (value !== undefined ? { ...schema, default: value } : schema);

const withSchemaDeprecation = (
  schema: JsonSchema,
  deprecationReason: string | null | undefined,
): JsonSchema => {
  const trimmed = deprecationReason?.trim();
  return trimmed
    ? { ...schema, deprecated: true, "x-deprecationReason": trimmed }
    : schema;
};

const introspectionQueryFromDocument = (documentText: string): IntrospectionQuery => {
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
    case "UUID":
    case "TimelessDate":
      return { type: "string" };
    case "Int":
    case "Float":
      return { type: "number" };
    case "Boolean":
      return { type: "boolean" };
    case "JSON":
    case "JSONObject":
    case "JSONString":
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
      return "2026-03-08T00:00:00.000Z";
    case "UUID":
      return "00000000-0000-0000-0000-000000000000";
    case "TimelessDate":
      return "2026-03-08";
    case "Int":
      return 1;
    case "Float":
      return 1.5;
    case "Boolean":
      return true;
    default:
      return {};
  }
};

const schemaForGraphqlInputType = (
  type: GraphQLInputType,
  depth = 0,
): JsonSchema => {
  if (isNonNullType(type)) {
    return schemaForGraphqlInputType(type.ofType, depth);
  }

  if (isListType(type)) {
    return {
      type: "array",
      items: schemaForGraphqlInputType(type.ofType, depth + 1),
    };
  }

  const namedType = getNamedType(type);
  if (isScalarType(namedType)) {
    return scalarInputSchema(namedType.name);
  }

  if (isEnumType(namedType)) {
    return {
      type: "string",
      enum: namedType.getValues().map((value) => value.name),
    };
  }

  if (isInputObjectType(namedType)) {
    if (depth >= 2) {
      return {
        type: "object",
        additionalProperties: true,
      };
    }

    const fields = Object.values(namedType.getFields());
    const properties = Object.fromEntries(
      fields.map((field) => {
        const schema = schemaForGraphqlInputType(field.type, depth + 1);
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
      .filter((field) => isNonNullType(field.type) && field.defaultValue === undefined)
      .map((field) => field.name);

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  }

  return {};
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
    const fieldsForExample = requiredFields.length > 0
      ? requiredFields
      : fields.slice(0, 1);

    return Object.fromEntries(
      fieldsForExample.map((field) => [
        field.name,
        field.defaultValue ?? exampleValueForGraphqlInputType(field.type, depth + 1),
      ]),
    );
  }

  return {};
};

const scalarOutputSchema = (name: string): JsonSchema => scalarInputSchema(name);

const selectedLeafOutputForType = (type: GraphQLOutputType): SelectedGraphqlOutput => {
  const namedType = getNamedType(type);

  if (isScalarType(namedType)) {
    return {
      selectionSet: "",
      schema: scalarOutputSchema(namedType.name),
    };
  }

  if (isEnumType(namedType)) {
    return {
      selectionSet: "",
      schema: {
        type: "string",
        enum: namedType.getValues().map((value) => value.name),
      },
    };
  }

  return {
    selectionSet: "",
    schema: {},
  };
};

const dedupeFields = <T extends { name: string }>(fields: readonly T[]): T[] => {
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

const selectedObjectOutputForType = (
  type: GraphQLOutputType,
  depth: number,
  seenTypeNames: ReadonlySet<string>,
): SelectedGraphqlOutput => {
  const namedType = getNamedType(type);
  if (!isObjectType(namedType) && !isInterfaceType(namedType)) {
    return {
      selectionSet: "{ __typename }",
      schema: {
        type: "object",
        properties: {
          __typename: { type: "string" },
        },
        required: ["__typename"],
        additionalProperties: false,
      },
    };
  }

  if (depth >= 2 || seenTypeNames.has(namedType.name)) {
    return {
      selectionSet: "{ __typename }",
      schema: {
        type: "object",
        properties: {
          __typename: { type: "string" },
        },
        required: ["__typename"],
        additionalProperties: false,
      },
    };
  }

  const nextSeen = new Set(seenTypeNames);
  nextSeen.add(namedType.name);

  const fields = Object.values(namedType.getFields()).filter(
    (field) => !field.name.startsWith("__"),
  );
  const leafFields = fields.filter((field) => isLeafType(getNamedType(field.type)));
  const nestedFields = fields.filter((field) => !isLeafType(getNamedType(field.type)));

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
    return {
      selectionSet: "{ __typename }",
      schema: {
        type: "object",
        properties: {
          __typename: { type: "string" },
        },
        required: ["__typename"],
        additionalProperties: false,
      },
    };
  }

  const selectionParts: string[] = [];
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const field of selectedFields) {
    const selected = selectedOutputForType(field.type, depth + 1, nextSeen);
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

  return {
    selectionSet: `{ ${selectionParts.join(" ")} }`,
    schema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
};

const selectedOutputForType = (
  type: GraphQLOutputType,
  depth = 0,
  seenTypeNames: ReadonlySet<string> = new Set<string>(),
): SelectedGraphqlOutput => {
  if (isNonNullType(type)) {
    return selectedOutputForType(type.ofType, depth, seenTypeNames);
  }

  if (isListType(type)) {
    const selectedItem = selectedOutputForType(type.ofType, depth, seenTypeNames);
    return {
      selectionSet: selectedItem.selectionSet,
      schema: {
        type: "array",
        items: selectedItem.schema,
      },
    };
  }

  const namedType = getNamedType(type);
  if (isLeafType(namedType)) {
    return selectedLeafOutputForType(type);
  }

  if (isUnionType(namedType)) {
    return {
      selectionSet: "{ __typename }",
      schema: {
        type: "object",
        properties: {
          __typename: { type: "string" },
        },
        required: ["__typename"],
        additionalProperties: false,
      },
    };
  }

  return selectedObjectOutputForType(type, depth, seenTypeNames);
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

const inputSchemaForFieldArguments = (args: readonly GraphQLArgument[]): JsonSchema => {
  const properties = Object.fromEntries(
    args.map((arg) => {
      const schema = schemaForGraphqlInputType(arg.type);
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

const outputEnvelopeSchemaForField = (fieldType: GraphQLOutputType): JsonSchema => {
  const selectedOutput = selectedOutputForType(fieldType);

  return {
    type: "object",
    properties: {
      data: withSchemaDescription(
        selectedOutput.schema,
        "Value returned for the selected GraphQL field.",
      ),
      errors: {
        type: "array",
        items: {},
      },
    },
    required: ["data", "errors"],
    additionalProperties: false,
  };
};

const exampleInputJsonForField = (args: readonly GraphQLArgument[]): string | undefined => {
  if (args.length === 0) {
    return JSON.stringify({});
  }

  const requiredArgs = args.filter(
    (arg) => isNonNullType(arg.type) && arg.defaultValue === undefined,
  );
  const argsForExample = requiredArgs.length > 0 ? requiredArgs : args.slice(0, 1);
  const example = Object.fromEntries(
    argsForExample.map((arg) => [
      arg.name,
      arg.defaultValue ?? exampleValueForGraphqlInputType(arg.type),
    ]),
  );

  return JSON.stringify(example);
};

const buildGraphqlFieldOperationDocument = (input: {
  operationType: GraphqlOperationType;
  fieldName: string;
  args: readonly GraphQLArgument[];
  fieldType: GraphQLOutputType;
}): { operationName: string; operationDocument: string } => {
  const selectedOutput = selectedOutputForType(input.fieldType);
  const operationName = `${toPascalCase(input.operationType)}${toPascalCase(input.fieldName)}`;
  const variableDefinitions = input.args
    .map((arg) => `$${arg.name}: ${printGraphqlType(arg.type)}`)
    .join(", ");
  const fieldArguments = input.args
    .map((arg) => `${arg.name}: $${arg.name}`)
    .join(", ");
  const fieldCall = fieldArguments.length > 0
    ? `${input.fieldName}(${fieldArguments})`
    : input.fieldName;
  const selectionSuffix = selectedOutput.selectionSet.length > 0
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
  inputSchemaJson: JSON.stringify(GRAPHQL_REQUEST_INPUT_SCHEMA),
  outputSchemaJson: JSON.stringify(GRAPHQL_REQUEST_OUTPUT_SCHEMA),
  exampleInputJson: JSON.stringify({
    query: "query { __typename }",
  }),
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

  applyDuplicates((draft) => `${draft.leaf}${toPascalCase(draft.operationType)}`);
  applyDuplicates((draft) =>
    `${draft.leaf}${toPascalCase(draft.operationType)}${createHash("sha1").update(`${draft.group}:${draft.fieldName}`).digest("hex").slice(0, 6)}`,
  );

  return staged
    .sort((left, right) =>
      left.toolId.localeCompare(right.toolId)
      || left.fieldName.localeCompare(right.fieldName)
      || left.operationType.localeCompare(right.operationType),
    )
    .map((draft) => ({ ...draft }));
};

const fieldToolDraftsFromRootType = (input: {
  rootType: ReturnType<GraphQLSchema["getQueryType"]> | ReturnType<GraphQLSchema["getMutationType"]>;
  operationType: GraphqlOperationType;
}): GraphqlFieldToolDraft[] => {
  if (!input.rootType) {
    return [];
  }

  return Object.values(input.rootType.getFields())
    .filter((field) => !field.name.startsWith("__"))
    .map((field) => {
      const leaf = toCamelCase(field.name);
      const outputSchemaJson = JSON.stringify(outputEnvelopeSchemaForField(field.type));
      const inputSchemaJson = JSON.stringify(inputSchemaForFieldArguments(field.args));
      const { operationName, operationDocument } = buildGraphqlFieldOperationDocument({
        operationType: input.operationType,
        fieldName: field.name,
        args: field.args,
        fieldType: field.type,
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
        inputSchemaJson,
        outputSchemaJson,
        exampleInputJson: exampleInputJsonForField(field.args),
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
  createHash("sha256").update(documentText).digest("hex");

export const extractGraphqlManifest = (
  sourceName: string,
  documentText: string,
): Effect.Effect<GraphqlToolManifest, Error, never> =>
  Effect.try({
    try: () => {
      const introspection = introspectionQueryFromDocument(documentText);
      const schema = buildClientSchema(introspection);
      const sourceHash = createGraphqlSourceHash(documentText);
      const fieldTools = resolveGraphqlFieldToolIds([
        ...fieldToolDraftsFromRootType({
          rootType: schema.getQueryType(),
          operationType: "query",
        }),
        ...fieldToolDraftsFromRootType({
          rootType: schema.getMutationType(),
          operationType: "mutation",
        }),
      ]);

      return {
        version: 2,
        sourceHash,
        queryTypeName: schema.getQueryType()?.name ?? null,
        mutationTypeName: schema.getMutationType()?.name ?? null,
        subscriptionTypeName: schema.getSubscriptionType()?.name ?? null,
        tools: [
          ...fieldTools,
          requestToolManifestEntry(sourceName),
        ],
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
    searchTerms: tool.kind === "field" ? tool.searchTerms : ["request", "graphql", "query", "mutation"],
  }));

export const buildGraphqlToolPresentation = (input: {
  manifest: GraphqlToolManifest;
  definition: GraphqlToolDefinition;
}): GraphqlToolPresentation => {
  const entry = input.manifest.tools.find((tool) => tool.toolId === input.definition.toolId);
  const inputSchemaJson = entry?.inputSchemaJson;
  const outputSchemaJson = entry?.outputSchemaJson;

  return {
    inputType: typeSignatureFromSchemaJson(inputSchemaJson, "unknown", Infinity),
    outputType: typeSignatureFromSchemaJson(outputSchemaJson, "unknown", Infinity),
    ...(inputSchemaJson ? { inputSchemaJson } : {}),
    ...(outputSchemaJson ? { outputSchemaJson } : {}),
    ...(entry?.exampleInputJson ? { exampleInputJson: entry.exampleInputJson } : {}),
    providerDataJson: JSON.stringify({
      kind: "graphql",
      toolKind: entry?.kind ?? "request",
      toolId: input.definition.toolId,
      rawToolId: input.definition.rawToolId,
      group: input.definition.group,
      leaf: input.definition.leaf,
      fieldName: input.definition.fieldName,
      operationType: input.definition.operationType,
      operationName: input.definition.operationName,
      queryTypeName: input.manifest.queryTypeName,
      mutationTypeName: input.manifest.mutationTypeName,
      subscriptionTypeName: input.manifest.subscriptionTypeName,
    }),
  };
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
    interaction: "auto",
    inputType: presentation.inputType,
    outputType: presentation.outputType,
    ...(input.includeSchemas && presentation.inputSchemaJson
      ? { inputSchemaJson: presentation.inputSchemaJson }
      : {}),
    ...(input.includeSchemas && presentation.outputSchemaJson
      ? { outputSchemaJson: presentation.outputSchemaJson }
      : {}),
    ...(presentation.exampleInputJson
      ? { exampleInputJson: presentation.exampleInputJson }
      : {}),
    providerKind: "graphql",
    providerDataJson: presentation.providerDataJson,
  };
};

const invokeGraphqlHttpRequest = (input: GraphqlHttpInvocation) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(input.endpoint, {
          method: "POST",
          headers: new Headers({
            "content-type": "application/json",
            ...(input.defaultHeaders ?? {}),
            ...(input.requestHeaders ?? {}),
            ...(input.credentialHeaders ?? {}),
          }),
          body: JSON.stringify({
            query: input.query,
            ...(input.variables !== undefined ? { variables: input.variables } : {}),
            ...(input.operationName ? { operationName: input.operationName } : {}),
          }),
        }),
      catch: (cause) => graphqlToolError(`GraphQL request failed for ${input.path}`, cause),
    });
    const body = yield* Effect.tryPromise({
      try: () => parseGraphqlResponseBody(response),
      catch: (cause) => graphqlToolError(`Failed decoding GraphQL response for ${input.path}`, cause),
    });

    return {
      status: response.status,
      headers: sanitizeResponseHeaders(
        Object.fromEntries(response.headers.entries()),
      ),
      body,
      isError: response.status >= 400 || hasGraphqlErrors(body),
    };
  });

const invokeRawGraphqlTool = (input: {
  endpoint: string;
  path: string;
  defaultHeaders?: Readonly<Record<string, string>>;
  credentialHeaders?: Readonly<Record<string, string>>;
  args: unknown;
}) =>
  Effect.gen(function* () {
    const record = asRecord(input.args);
    const query = asString(record.query);
    if (query === null) {
      return yield* Effect.fail(
        new Error(`GraphQL query must be a non-empty string for ${input.path}`),
      );
    }

    return yield* invokeGraphqlHttpRequest({
      endpoint: input.endpoint,
      path: input.path,
      defaultHeaders: input.defaultHeaders,
      credentialHeaders: input.credentialHeaders,
      query,
      variables: record.variables !== undefined ? asRecord(record.variables) : undefined,
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
  entry: GraphqlFieldToolManifestEntry;
  endpoint: string;
  path: string;
  defaultHeaders?: Readonly<Record<string, string>>;
  credentialHeaders?: Readonly<Record<string, string>>;
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
}): ToolMap => {
  const endpoint = normalizeHttpUrl(input.endpoint);
  const definitions = compileGraphqlToolDefinitions(input.manifest);

  return Object.fromEntries(
    definitions.map((definition) => {
      const presentation = buildGraphqlToolPresentation({
        manifest: input.manifest,
        definition,
      });
      const entry = input.manifest.tools.find((tool) => tool.toolId === definition.toolId);
      const path = input.namespace ? `${input.namespace}.${definition.toolId}` : definition.toolId;
      const inputSchema = presentation.inputSchemaJson
        ? (JSON.parse(presentation.inputSchemaJson) as Record<string, unknown>)
        : {};
      const metadata: ToolMetadata = {
        interaction: "auto",
        inputType: presentation.inputType,
        outputType: presentation.outputType,
        ...(presentation.inputSchemaJson ? { inputSchemaJson: presentation.inputSchemaJson } : {}),
        ...(presentation.outputSchemaJson ? { outputSchemaJson: presentation.outputSchemaJson } : {}),
        ...(presentation.exampleInputJson ? { exampleInputJson: presentation.exampleInputJson } : {}),
        sourceKey: input.sourceKey,
        providerKind: "graphql",
        providerDataJson: presentation.providerDataJson,
      };

      return [
        path,
        toTool({
          tool: {
            description: definition.description,
            inputSchema: standardSchemaFromJsonSchema(inputSchema),
            execute: (args: unknown) => {
              if (entry?.kind === "field") {
                return Effect.runPromise(invokeGraphqlFieldTool({
                  entry,
                  endpoint,
                  path,
                  defaultHeaders: input.defaultHeaders,
                  credentialHeaders: input.credentialHeaders,
                  args,
                }));
              }

              return Effect.runPromise(invokeRawGraphqlTool({
                endpoint,
                path,
                defaultHeaders: input.defaultHeaders,
                credentialHeaders: input.credentialHeaders,
                args,
              }));
            },
          },
          metadata,
        }),
      ] as const;
    }),
  );
};
