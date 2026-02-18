import { Result } from "better-result";
import { parseValue, valueFromASTUntyped } from "graphql";
import { z } from "zod";
import {
  buildFieldQuery,
  gqlFieldArgsTypeHint,
  gqlTypeToHint,
  normalizeGraphqlFieldVariables,
  selectGraphqlFieldEnvelope,
  type GqlSchema,
  type GqlType,
  type GqlTypeRef,
} from "../graphql/field-tools";
import {
  executeGraphqlRequest,
  type GraphqlExecutionEnvelope,
} from "../tool/source-execution";
import { buildCredentialSpec, buildStaticAuthHeaders, getCredentialSourceKey } from "../tool/source-auth";
import { sanitizeSegment } from "../tool/path-utils";
import type { GraphqlToolSourceConfig } from "../tool/source-types";
import { buildPreviewKeys, extractTopLevelRequiredKeys } from "../tool-typing/schema-utils";
import type { ToolDefinition } from "../types";

const gqlTypeRefSchema: z.ZodType<GqlTypeRef> = z.lazy(() => z.object({
  kind: z.string(),
  name: z.string().nullable(),
  ofType: gqlTypeRefSchema.nullish(),
}));

const gqlFieldArgSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional().transform((value) => value ?? null),
  isDeprecated: z.boolean().nullable().optional().transform((value) => value ?? null),
  deprecationReason: z.string().nullable().optional().transform((value) => value ?? null),
  type: gqlTypeRefSchema,
  defaultValue: z.string().nullable().optional().transform((value) => value ?? null),
});

const gqlFieldSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional().transform((value) => value ?? null),
  isDeprecated: z.boolean().nullable().optional().transform((value) => value ?? null),
  deprecationReason: z.string().nullable().optional().transform((value) => value ?? null),
  args: z.array(gqlFieldArgSchema),
  type: gqlTypeRefSchema,
});

const gqlInputFieldSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional().transform((value) => value ?? null),
  isDeprecated: z.boolean().nullable().optional().transform((value) => value ?? null),
  deprecationReason: z.string().nullable().optional().transform((value) => value ?? null),
  type: gqlTypeRefSchema,
  defaultValue: z.string().nullable().optional().transform((value) => value ?? null),
});

const gqlEnumValueSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional().transform((value) => value ?? null),
  isDeprecated: z.boolean().nullable().optional().transform((value) => value ?? null),
  deprecationReason: z.string().nullable().optional().transform((value) => value ?? null),
});

const gqlTypeSchema = z.object({
  kind: z.string(),
  name: z.string(),
  fields: z.array(gqlFieldSchema).nullable().optional().transform((value) => value ?? null),
  inputFields: z.array(gqlInputFieldSchema).nullable().optional().transform((value) => value ?? null),
  enumValues: z.array(gqlEnumValueSchema).nullable().optional().transform((value) => value ?? null),
  possibleTypes: z.array(gqlTypeRefSchema).nullable().optional().transform((value) => value ?? null),
});

const gqlSchemaSchema = z.object({
  queryType: z.object({ name: z.string() }).nullable().optional().transform((value) => value ?? null),
  mutationType: z.object({ name: z.string() }).nullable().optional().transform((value) => value ?? null),
  types: z.array(gqlTypeSchema),
});

const gqlIntrospectionResponseSchema = z.object({
  data: z.object({ __schema: gqlSchemaSchema }).optional(),
  errors: z.array(z.unknown()).optional(),
});

const graphqlObjectInputSchema = z.object({
  query: z.string().optional(),
  variables: z.unknown().optional(),
}).catchall(z.unknown());

const graphqlToolInputSchema = z.union([
  z.string(),
  graphqlObjectInputSchema,
]);

const recordSchema = z.record(z.unknown());

function coerceRecord(value: unknown): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function normalizeGraphqlToolInput(value: unknown): {
  payload: Record<string, unknown>;
  query: string;
  variables: unknown;
  hasExplicitQuery: boolean;
} {
  const parsedInput = graphqlToolInputSchema.safeParse(value);
  if (!parsedInput.success) {
    const payload = coerceRecord(value);
    return {
      payload,
      query: "",
      variables: payload.variables,
      hasExplicitQuery: false,
    };
  }

  if (typeof parsedInput.data === "string") {
    const query = parsedInput.data.trim();
    return {
      payload: { query: parsedInput.data },
      query,
      variables: undefined,
      hasExplicitQuery: query.length > 0,
    };
  }

  const query = (parsedInput.data.query ?? "").trim();
  return {
    payload: parsedInput.data,
    query,
    variables: parsedInput.data.variables,
    hasExplicitQuery: query.length > 0,
  };
}

const INTROSPECTION_QUERY_EXTENDED = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        kind name
        fields(includeDeprecated: true) {
          name description isDeprecated deprecationReason
          args { name description isDeprecated deprecationReason type { ...TypeRef } defaultValue }
          type { ...TypeRef }
        }
        inputFields(includeDeprecated: true) {
          name description isDeprecated deprecationReason
          type { ...TypeRef }
          defaultValue
        }
        enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason }
        possibleTypes { ...TypeRef }
      }
    }
  }
  fragment TypeRef on __Type {
    kind name
    ofType {
      kind name
      ofType {
        kind name
        ofType {
          kind name
          ofType { kind name }
        }
      }
    }
  }
`;

async function fetchGraphqlIntrospection(
  endpoint: string,
  authHeaders: Record<string, string>,
): Promise<GqlSchema> {
  const introspectionResult = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({ query: INTROSPECTION_QUERY_EXTENDED }),
  });

  if (!introspectionResult.ok) {
    const text = await introspectionResult.text().catch(() => "");
    throw new Error(`GraphQL introspection failed: HTTP ${introspectionResult.status}: ${text.slice(0, 300)}`);
  }

  let introspectionJson: unknown;
  try {
    introspectionJson = await introspectionResult.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GraphQL introspection response parse failed: ${message}`);
  }

  const schemaResult = parseGraphqlIntrospectionSchema(introspectionJson);
  if (schemaResult.isErr()) {
    throw schemaResult.error;
  }

  return schemaResult.value;
}

function schemaForNamedScalar(name: string): Record<string, unknown> {
  switch (name) {
    case "String":
    case "ID":
    case "DateTime":
    case "Date":
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
}

function parseGraphqlDefaultValue(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    return valueFromASTUntyped(parseValue(trimmed));
  } catch {
    return raw;
  }
}

function withGraphqlSchemaMetadata(
  schema: Record<string, unknown>,
  metadata: {
    description?: string | null;
    defaultValue?: string | null;
    isDeprecated?: boolean | null;
    deprecationReason?: string | null;
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...schema };
  const description = (metadata.description ?? "").trim();
  if (description.length > 0 && !("description" in next)) {
    next.description = description;
  }

  const parsedDefault = parseGraphqlDefaultValue(metadata.defaultValue);
  if (parsedDefault !== undefined && !("default" in next)) {
    next.default = parsedDefault;
  }

  if (metadata.isDeprecated === true && !("deprecated" in next)) {
    next.deprecated = true;
  }

  const deprecationReason = (metadata.deprecationReason ?? "").trim();
  if (deprecationReason.length > 0 && !("x-deprecationReason" in next)) {
    next["x-deprecationReason"] = deprecationReason;
  }

  return next;
}

function schemaForTypeRef(
  ref: GqlTypeRef | null | undefined,
  typeMap: Map<string, GqlType>,
  depth = 0,
): Record<string, unknown> {
  if (!ref || typeof ref !== "object") return {};

  if (ref.kind === "NON_NULL" && ref.ofType) {
    return schemaForTypeRef(ref.ofType, typeMap, depth);
  }

  if (ref.kind === "LIST" && ref.ofType) {
    return {
      type: "array",
      items: schemaForTypeRef(ref.ofType, typeMap, depth),
    };
  }

  const name = typeof ref.name === "string" ? ref.name : "";
  if (!name) return {};

  const resolved = typeMap.get(name);
  if (resolved?.kind === "ENUM" && resolved.enumValues && resolved.enumValues.length > 0) {
    const enumValues = resolved.enumValues.slice(0, 200);
    return {
      type: "string",
      enum: enumValues.map((v) => v.name),
      oneOf: enumValues.map((v) => ({
        const: v.name,
        ...(v.description ? { description: v.description } : {}),
        ...(v.isDeprecated ? { deprecated: true } : {}),
        ...(v.deprecationReason ? { "x-deprecationReason": v.deprecationReason } : {}),
      })),
    };
  }

  if (resolved?.kind === "INPUT_OBJECT" && resolved.inputFields && depth < 2) {
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    for (const field of resolved.inputFields) {
      if (!field?.name) continue;
      props[field.name] = withGraphqlSchemaMetadata(
        schemaForTypeRef(field.type, typeMap, depth + 1),
        {
          description: field.description,
          defaultValue: field.defaultValue,
          isDeprecated: field.isDeprecated,
          deprecationReason: field.deprecationReason,
        },
      );
      if (field.type?.kind === "NON_NULL") {
        required.push(field.name);
      }
    }
    return {
      type: "object",
      properties: props,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  if (resolved?.kind === "UNION" && Array.isArray(resolved.possibleTypes) && resolved.possibleTypes.length > 0 && depth < 2) {
    const variants = resolved.possibleTypes
      .slice(0, 16)
      .map((possible) => schemaForTypeRef(possible, typeMap, depth + 1))
      .filter((variant) => Object.keys(variant).length > 0);
    if (variants.length > 0) {
      return {
        oneOf: variants,
      };
    }
  }

  if ((resolved?.kind === "OBJECT" || resolved?.kind === "INTERFACE") && resolved.fields && depth < 2) {
    const props: Record<string, unknown> = {};
    for (const field of resolved.fields) {
      if (!field?.name || field.name.startsWith("__")) continue;
      props[field.name] = withGraphqlSchemaMetadata(
        schemaForTypeRef(field.type, typeMap, depth + 1),
        {
          description: field.description,
          isDeprecated: field.isDeprecated,
          deprecationReason: field.deprecationReason,
        },
      );
    }
    return {
      type: "object",
      properties: props,
    };
  }

  return schemaForNamedScalar(name);
}

function buildArgsObjectSchema(
  args: Array<{
    name: string;
    type: GqlTypeRef;
    description?: string | null;
    defaultValue?: string | null;
    isDeprecated?: boolean | null;
    deprecationReason?: string | null;
  }>,
  typeMap: Map<string, GqlType>,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const required: string[] = [];

  for (const arg of args) {
    const name = typeof arg?.name === "string" ? arg.name : "";
    if (!name) continue;
    props[name] = withGraphqlSchemaMetadata(
      schemaForTypeRef(arg.type, typeMap),
      {
        description: arg.description,
        defaultValue: arg.defaultValue,
        isDeprecated: arg.isDeprecated,
        deprecationReason: arg.deprecationReason,
      },
    );
    if (arg.type?.kind === "NON_NULL") {
      required.push(name);
    }
  }

  return {
    type: "object",
    properties: props,
    ...(required.length > 0 ? { required } : {}),
  };
}

function parseGraphqlIntrospectionSchema(payload: unknown): Result<GqlSchema, Error> {
  const parsed = gqlIntrospectionResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return Result.err(new Error(`GraphQL introspection payload invalid: ${parsed.error.message}`));
  }

  const errors = parsed.data.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return Result.err(new Error(`GraphQL introspection errors: ${JSON.stringify(errors).slice(0, 500)}`));
  }

  const schema = parsed.data.data?.__schema;
  if (!schema) {
    return Result.err(new Error("GraphQL introspection returned no schema"));
  }

  return Result.ok(schema);
}

function toGraphqlEnvelope(value: unknown): GraphqlExecutionEnvelope {
  const payload = coerceRecord(value);
  return {
    data: Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : null,
    errors: Array.isArray(payload.errors) ? payload.errors : [],
  };
}

export async function loadGraphqlTools(config: GraphqlToolSourceConfig): Promise<ToolDefinition[]> {
  const authHeaders = buildStaticAuthHeaders(config.auth);
  const sourceKey = `graphql:${config.name}`;
  const credentialSpec = buildCredentialSpec(getCredentialSourceKey(config), config.auth);
  const sourceName = sanitizeSegment(config.name);

  const schema = await fetchGraphqlIntrospection(config.endpoint, authHeaders);

  // Index types by name
  const typeMap = new Map<string, GqlType>();
  for (const t of schema.types) {
    typeMap.set(t.name, t);
  }

  const tools: ToolDefinition[] = [];

  // Create the main graphql tool — this is the one that actually executes queries
  const mainToolPath = `${sourceName}.graphql`;
  const mainTool: ToolDefinition & { _graphqlSource: string } = {
    path: mainToolPath,
    source: sourceKey,
    description: `Execute a GraphQL query or mutation against ${config.name}. Returns { data, errors }. Use ${sourceName}.query.* and ${sourceName}.mutation.* helpers when available.`,
    approval: "auto", // Actual approval is determined dynamically per-invocation
    typing: {
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          variables: {},
        },
        required: ["query"],
      },
      outputSchema: {
        type: "object",
        properties: {
          data: {},
          errors: { type: "array", items: {} },
        },
        required: ["data"],
      },
      requiredInputKeys: ["query"],
      previewInputKeys: ["query", "variables"],
    },
    credential: credentialSpec,
    // Tag as graphql source so invokeTool knows to do dynamic path extraction
    _graphqlSource: config.name,
    _runSpec: {
      kind: "graphql_raw" as const,
      endpoint: config.endpoint,
      authHeaders,
    },
    run: async (input: unknown, context) => {
      const normalized = normalizeGraphqlToolInput(input);
      if (!normalized.hasExplicitQuery) {
        throw new Error("GraphQL query string is required");
      }
      return await executeGraphqlRequest(
        config.endpoint,
        authHeaders,
        normalized.query,
        normalized.variables,
        context.credential?.headers,
      );
    },
  };
  tools.push(mainTool);

  // Create pseudo-tools for each query/mutation field — these are for discovery/intellisense
  // but they all route through the main .graphql tool
  const rootTypes: Array<{ typeName: string | null; operationType: "query" | "mutation" }> = [
    { typeName: schema.queryType?.name ?? null, operationType: "query" },
    { typeName: schema.mutationType?.name ?? null, operationType: "mutation" },
  ];

  for (const { typeName, operationType } of rootTypes) {
    if (!typeName) continue;
    const rootType = typeMap.get(typeName);
    if (!rootType?.fields) continue;

    const defaultApproval = operationType === "query"
      ? (config.defaultQueryApproval ?? "auto")
      : (config.defaultMutationApproval ?? "required");

    for (const field of rootType.fields) {
      if (field.name.startsWith("__")) continue;

      const fieldPath = `${sourceName}.${operationType}.${sanitizeSegment(field.name)}`;
      const approval = config.overrides?.[field.name]?.approval ?? defaultApproval;
      const inputSchema = buildArgsObjectSchema(field.args, typeMap);
      const fieldDataSchema = schemaForTypeRef(field.type, typeMap);
      const outputSchema = {
        type: "object",
        properties: {
          data: fieldDataSchema,
          errors: { type: "array", items: {} },
        },
        required: ["data"],
      } satisfies Record<string, unknown>;
      const requiredInputKeys = extractTopLevelRequiredKeys(inputSchema);
      const previewInputKeys = buildPreviewKeys(inputSchema);
      const inputHint = gqlFieldArgsTypeHint(field.args, typeMap);
      const outputHint = `{ data: ${gqlTypeToHint(field.type, typeMap)}; errors: unknown[] }`;

      // Build the example query for the description
      const exampleQuery = buildFieldQuery(operationType, field.name, field.args, field.type, typeMap);
      const directCallExample = field.args.length === 0
        ? `tools.${fieldPath}({})`
        : `tools.${fieldPath}({ ${field.args.map((arg) => `${arg.name}: ...`).join(", ")} })`;

      const fieldTool: ToolDefinition & { _pseudoTool: boolean } = {
        path: fieldPath,
        source: sourceKey,
        description: field.description
          ? `${field.description}\n\nPreferred: ${directCallExample}\nReturns: { data, errors }\nRaw GraphQL: ${sourceName}.graphql({ query: \`${exampleQuery}\`, variables: {...} })`
          : `GraphQL ${operationType}: ${field.name}\n\nPreferred: ${directCallExample}\nReturns: { data, errors }\nRaw GraphQL: ${sourceName}.graphql({ query: \`${exampleQuery}\`, variables: {...} })`,
        approval,
        credential: credentialSpec,
        typing: {
          inputSchema,
          outputSchema,
          inputHint,
          outputHint,
          ...(requiredInputKeys.length > 0 ? { requiredInputKeys } : {}),
          ...(previewInputKeys.length > 0 ? { previewInputKeys } : {}),
        },
        _runSpec: {
          kind: "graphql_field" as const,
          endpoint: config.endpoint,
          operationName: field.name,
          operationType,
          queryTemplate: exampleQuery,
          argNames: field.args.map((arg) => arg.name),
          authHeaders,
        },
        // Pseudo-tools don't have a run — they exist for discovery and policy matching only
        _pseudoTool: true,
        run: async (input: unknown, context) => {
          // If someone calls this directly, delegate to the main graphql tool
          const normalized = normalizeGraphqlToolInput(input);
          const payload = normalized.payload;
          if (!normalized.hasExplicitQuery) {
            // Auto-build the query from the variables
            payload.query = buildFieldQuery(operationType, field.name, field.args, field.type, typeMap);
            if (payload.variables === undefined) {
              payload.variables = normalizeGraphqlFieldVariables(
                field.args.map((arg) => arg.name),
                payload,
              );
            }
          }
          const envelope = toGraphqlEnvelope(await mainTool.run(payload, context));
          return selectGraphqlFieldEnvelope(envelope, field.name);
        },
      };
      tools.push(fieldTool);
    }
  }

  return tools;
}
