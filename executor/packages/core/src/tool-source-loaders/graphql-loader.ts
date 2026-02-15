"use node";

import {
  buildFieldQuery,
  normalizeGraphqlFieldVariables,
  selectGraphqlFieldEnvelope,
  type GqlSchema,
  type GqlType,
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
import { asRecord } from "../utils";

const INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        kind name
        fields {
          name description
          args { name description type { ...TypeRef } defaultValue }
          type { ...TypeRef }
        }
        inputFields {
          name description
          type { ...TypeRef }
          defaultValue
        }
        enumValues { name description }
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

function unwrapNonNull(ref: { kind: string; ofType?: unknown } | null | undefined): unknown {
  if (!ref || typeof ref !== "object") return ref;
  if (ref.kind === "NON_NULL" && ref.ofType) return unwrapNonNull(ref.ofType as any);
  return ref;
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

function schemaForTypeRef(
  ref: { kind: string; name: string | null; ofType?: unknown } | null | undefined,
  typeMap: Map<string, GqlType>,
  depth = 0,
): Record<string, unknown> {
  if (!ref || typeof ref !== "object") return {};

  if (ref.kind === "NON_NULL" && ref.ofType) {
    return schemaForTypeRef(ref.ofType as any, typeMap, depth);
  }

  if (ref.kind === "LIST" && ref.ofType) {
    return {
      type: "array",
      items: schemaForTypeRef(ref.ofType as any, typeMap, depth),
    };
  }

  const name = typeof ref.name === "string" ? ref.name : "";
  if (!name) return {};

  const resolved = typeMap.get(name);
  if (resolved?.kind === "ENUM" && resolved.enumValues && resolved.enumValues.length > 0) {
    return { type: "string", enum: resolved.enumValues.map((v) => v.name).slice(0, 200) };
  }

  if (resolved?.kind === "INPUT_OBJECT" && resolved.inputFields && depth < 2) {
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    for (const field of resolved.inputFields) {
      if (!field?.name) continue;
      props[field.name] = schemaForTypeRef(field.type as any, typeMap, depth + 1);
      const unwrapped = unwrapNonNull(field.type as any) as any;
      if ((field.type as any)?.kind === "NON_NULL") {
        required.push(field.name);
      }
      // Prevent unused variable lint: unwrapped is kept for future enhancements.
      void unwrapped;
    }
    return {
      type: "object",
      properties: props,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  return schemaForNamedScalar(name);
}

function buildArgsObjectSchema(
  args: Array<{ name: string; type: unknown }>,
  typeMap: Map<string, GqlType>,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const required: string[] = [];

  for (const arg of args) {
    const name = typeof arg?.name === "string" ? arg.name : "";
    if (!name) continue;
    props[name] = schemaForTypeRef(arg.type as any, typeMap);
    if ((arg.type as any)?.kind === "NON_NULL") {
      required.push(name);
    }
  }

  return {
    type: "object",
    properties: props,
    ...(required.length > 0 ? { required } : {}),
  };
}

export async function loadGraphqlTools(config: GraphqlToolSourceConfig): Promise<ToolDefinition[]> {
  const authHeaders = buildStaticAuthHeaders(config.auth);
  const sourceKey = `graphql:${config.name}`;
  const credentialSpec = buildCredentialSpec(getCredentialSourceKey(config), config.auth);
  const sourceName = sanitizeSegment(config.name);

  // Introspect the schema
  const introspectionResult = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  });

  if (!introspectionResult.ok) {
    const text = await introspectionResult.text().catch(() => "");
    throw new Error(`GraphQL introspection failed: HTTP ${introspectionResult.status}: ${text.slice(0, 300)}`);
  }

  const introspectionJson = (await introspectionResult.json()) as { data?: { __schema?: GqlSchema }; errors?: unknown[] };
  if (introspectionJson.errors) {
    throw new Error(`GraphQL introspection errors: ${JSON.stringify(introspectionJson.errors).slice(0, 500)}`);
  }
  const schema = introspectionJson.data?.__schema;
  if (!schema) {
    throw new Error("GraphQL introspection returned no schema");
  }

  // Index types by name
  const typeMap = new Map<string, GqlType>();
  for (const t of schema.types) {
    typeMap.set(t.name, t);
  }

  const tools: ToolDefinition[] = [];

  // Create the main graphql tool — this is the one that actually executes queries
  const mainToolPath = `${sourceName}.graphql`;
  tools.push({
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
      const payload = asRecord(input);
      const query = String(payload.query ?? "");
      const variables = payload.variables ?? undefined;

      if (!query.trim()) {
        throw new Error("GraphQL query string is required");
      }
      return await executeGraphqlRequest(
        config.endpoint,
        authHeaders,
        query,
        variables,
        context.credential?.headers,
      );
    },
  } as ToolDefinition & { _graphqlSource: string });

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
      const inputSchema = buildArgsObjectSchema(field.args as any, typeMap);
      const requiredInputKeys = extractTopLevelRequiredKeys(inputSchema);
      const previewInputKeys = buildPreviewKeys(inputSchema);

      // Build the example query for the description
      const exampleQuery = buildFieldQuery(operationType, field.name, field.args, field.type, typeMap);
      const directCallExample = field.args.length === 0
        ? `tools.${fieldPath}({})`
        : `tools.${fieldPath}({ ${field.args.map((arg) => `${arg.name}: ...`).join(", ")} })`;

      tools.push({
        path: fieldPath,
        source: sourceKey,
        description: field.description
          ? `${field.description}\n\nPreferred: ${directCallExample}\nReturns: { data, errors }\nRaw GraphQL: ${sourceName}.graphql({ query: \`${exampleQuery}\`, variables: {...} })`
          : `GraphQL ${operationType}: ${field.name}\n\nPreferred: ${directCallExample}\nReturns: { data, errors }\nRaw GraphQL: ${sourceName}.graphql({ query: \`${exampleQuery}\`, variables: {...} })`,
        approval,
        credential: credentialSpec,
        typing: {
          inputSchema,
          outputSchema: {
            type: "object",
            properties: {
              data: {},
              errors: { type: "array", items: {} },
            },
            required: ["data"],
          },
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
          const payload = asRecord(input);
          const hasExplicitQuery = typeof payload.query === "string" && payload.query.trim().length > 0;
          if (!hasExplicitQuery) {
            // Auto-build the query from the variables
            payload.query = buildFieldQuery(operationType, field.name, field.args, field.type, typeMap);
            if (payload.variables === undefined) {
              payload.variables = normalizeGraphqlFieldVariables(
                field.args.map((arg) => arg.name),
                payload,
              );
            }
          }
          // Find and invoke the main tool
          const mainTool = tools.find((t) => t.path === mainToolPath);
          if (!mainTool) throw new Error("Main GraphQL tool not found");
          const envelope = await mainTool.run(payload, context) as GraphqlExecutionEnvelope;
          return selectGraphqlFieldEnvelope(envelope, field.name);
        },
      } as ToolDefinition & { _pseudoTool: boolean });
    }
  }

  return tools;
}
