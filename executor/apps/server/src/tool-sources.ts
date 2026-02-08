import SwaggerParser from "@apidevtools/swagger-parser";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { astToString, transformSchemaObject } from "openapi-typescript";
import type { ToolApprovalMode, ToolCredentialSpec, ToolDefinition } from "./types";
import { asRecord } from "./utils";

type JsonSchema = Record<string, unknown>;

export interface McpToolSourceConfig {
  type: "mcp";
  name: string;
  url: string;
  transport?: "sse" | "streamable-http";
  queryParams?: Record<string, string>;
  defaultApproval?: ToolApprovalMode;
  overrides?: Record<string, { approval?: ToolApprovalMode }>;
}

export type OpenApiAuth =
  | { type: "none" }
  | { type: "basic"; mode?: "static" | "workspace" | "actor"; username?: string; password?: string }
  | { type: "bearer"; mode?: "static" | "workspace" | "actor"; token?: string }
  | { type: "apiKey"; mode?: "static" | "workspace" | "actor"; header: string; value?: string };

export interface OpenApiToolSourceConfig {
  type: "openapi";
  name: string;
  spec: string | Record<string, unknown>;
  baseUrl?: string;
  auth?: OpenApiAuth;
  defaultReadApproval?: ToolApprovalMode;
  defaultWriteApproval?: ToolApprovalMode;
  overrides?: Record<string, { approval?: ToolApprovalMode }>;
}

export interface GraphqlToolSourceConfig {
  type: "graphql";
  name: string;
  endpoint: string;
  /** Optional static introspection result — if omitted, we introspect at load time */
  schema?: Record<string, unknown>;
  auth?: OpenApiAuth;
  defaultQueryApproval?: ToolApprovalMode;
  defaultMutationApproval?: ToolApprovalMode;
  overrides?: Record<string, { approval?: ToolApprovalMode }>;
}

export type ExternalToolSourceConfig =
  | McpToolSourceConfig
  | OpenApiToolSourceConfig
  | GraphqlToolSourceConfig;

function sanitizeSegment(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return cleaned.length > 0 ? cleaned : "default";
}

// openapi-typescript context for standalone schema conversion
function makeTransformCtx() {
  return {
    additionalProperties: false,
    alphabetize: false,
    arrayLength: false,
    defaultNonNullable: true,
    discriminators: { refsHandled: [] as string[], objects: {} as Record<string, unknown> },
    emptyObjectsUnknown: false,
    enum: false,
    enumValues: false,
    excludeDeprecated: false,
    exportType: false,
    immutable: false,
    indentLv: 0,
    pathParamsAsTypes: false,
    postTransform: undefined,
    propertiesRequiredByDefault: false,
    redoc: undefined,
    silent: true,
    resolve(_ref: string) { return undefined as unknown; },
  };
}

/**
 * Convert a JSON Schema to a TypeScript type string using openapi-typescript.
 * Handles allOf, oneOf, enums, nullable, additionalProperties, etc.
 * Falls back to the simple hand-rolled version on error.
 */
function jsonSchemaToTypeString(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "unknown";
  try {
    const node = transformSchemaObject(schema as never, {
      path: "#",
      ctx: makeTransformCtx() as never,
    });
    const result = astToString(node).trim();
    return result || "unknown";
  } catch {
    return jsonSchemaTypeHintFallback(schema);
  }
}

/** Simple fallback for when openapi-typescript can't handle the schema */
function jsonSchemaTypeHintFallback(schema: unknown, depth = 0): string {
  if (!schema || typeof schema !== "object") return "unknown";
  if (depth > 4) return "unknown";

  const shape = schema as JsonSchema;
  const enumValues = Array.isArray(shape.enum) ? shape.enum : undefined;
  if (enumValues && enumValues.length > 0) {
    return enumValues.map((value) => JSON.stringify(value)).join(" | ");
  }

  const oneOf = Array.isArray(shape.oneOf) ? shape.oneOf : undefined;
  if (oneOf && oneOf.length > 0) {
    return oneOf.map((entry) => jsonSchemaTypeHintFallback(entry, depth + 1)).join(" | ");
  }

  const anyOf = Array.isArray(shape.anyOf) ? shape.anyOf : undefined;
  if (anyOf && anyOf.length > 0) {
    return anyOf.map((entry) => jsonSchemaTypeHintFallback(entry, depth + 1)).join(" | ");
  }

  const type = typeof shape.type === "string" ? shape.type : undefined;
  if (type === "string" || type === "number" || type === "boolean" || type === "null") {
    return type;
  }

  if (type === "array") {
    return `${jsonSchemaTypeHintFallback(shape.items, depth + 1)}[]`;
  }

  const props = asRecord(shape.properties);
  const requiredRaw = Array.isArray(shape.required) ? shape.required : [];
  const required = new Set(requiredRaw.filter((item): item is string => typeof item === "string"));
  const propEntries = Object.entries(props);
  if (type === "object" || propEntries.length > 0) {
    if (propEntries.length === 0) {
      return "Record<string, unknown>";
    }
    const inner = propEntries
      .slice(0, 12)
      .map(([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${jsonSchemaTypeHintFallback(value, depth + 1)}`)
      .join("; ");
    return `{ ${inner} }`;
  }

  return "unknown";
}

async function connectMcp(
  url: string,
  queryParams: Record<string, string> | undefined,
  preferredTransport?: "sse" | "streamable-http",
): Promise<{ client: Client; close: () => Promise<void> }> {
  const endpoint = new URL(url);
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (!key.trim()) continue;
      endpoint.searchParams.set(key, value);
    }
  }
  const client = new Client(
    { name: "executor-tool-loader", version: "0.1.0" },
    { capabilities: {} },
  );

  if (preferredTransport === "sse") {
    await client.connect(new SSEClientTransport(endpoint));
    return { client, close: () => client.close() };
  }

  if (preferredTransport === "streamable-http") {
    await client.connect(new StreamableHTTPClientTransport(endpoint) as Parameters<Client["connect"]>[0]);
    return { client, close: () => client.close() };
  }

  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint) as Parameters<Client["connect"]>[0]);
    return { client, close: () => client.close() };
  } catch {
    await client.connect(new SSEClientTransport(endpoint));
    return { client, close: () => client.close() };
  }
}

async function loadMcpTools(config: McpToolSourceConfig): Promise<ToolDefinition[]> {
  const queryParams = config.queryParams
    ? Object.fromEntries(
      Object.entries(config.queryParams).map(([key, value]) => [key, String(value)]),
    )
    : undefined;

  let connection = await connectMcp(config.url, queryParams, config.transport);

  async function callToolWithReconnect(name: string, input: Record<string, unknown>): Promise<unknown> {
    try {
      return await connection.client.callTool({ name, arguments: input });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/(socket|closed|ECONNRESET|fetch failed)/i.test(message)) {
        throw error;
      }

      try {
        await connection.close();
      } catch {
        // ignore
      }

      connection = await connectMcp(config.url, queryParams, config.transport);
      return await connection.client.callTool({ name, arguments: input });
    }
  }

  const listed = await connection.client.listTools();
  const tools = Array.isArray((listed as { tools?: unknown }).tools)
    ? ((listed as { tools: Array<Record<string, unknown>> }).tools)
    : [];

  return tools.map((tool) => {
    const toolName = String(tool.name ?? "tool");
    const inputSchema = asRecord(tool.inputSchema);
    return {
      path: `${sanitizeSegment(config.name)}.${sanitizeSegment(toolName)}`,
      source: `mcp:${config.name}`,
      approval: config.overrides?.[toolName]?.approval ?? config.defaultApproval ?? "auto",
      description: String(tool.description ?? `MCP tool ${toolName}`),
      metadata: {
        argsType: jsonSchemaToTypeString(inputSchema),
        returnsType: "unknown",
      },
      run: async (input: unknown) => {
        const payload = asRecord(input);
        const result = await callToolWithReconnect(toolName, payload);
        if (!result || typeof result !== "object") return result;

        const content = (result as { content?: unknown }).content;
        if (!Array.isArray(content)) {
          return result;
        }

        const texts = content
          .map((item) => (item && typeof item === "object" ? (item as { text?: unknown }).text : undefined))
          .filter((item): item is string => typeof item === "string");

        if (texts.length === 0) return content;
        if (texts.length === 1) return texts[0];
        return texts;
      },
    } satisfies ToolDefinition;
  });
}

function buildStaticAuthHeaders(auth?: OpenApiAuth): Record<string, string> {
  if (!auth || auth.type === "none") return {};
  const mode = auth.mode ?? "static";
  if (mode !== "static") return {};

  if (auth.type === "basic") {
    const username = auth.username ?? "";
    const password = auth.password ?? "";
    if (!username && !password) return {};
    const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    return { authorization: `Basic ${encoded}` };
  }
  if (auth.type === "bearer") {
    if (!auth.token) return {};
    return { authorization: `Bearer ${auth.token}` };
  }
  if (!auth.value) return {};
  return { [auth.header]: auth.value };
}

function buildCredentialSpec(sourceKey: string, auth?: OpenApiAuth): ToolCredentialSpec | undefined {
  if (!auth || auth.type === "none") return undefined;
  const mode = auth.mode ?? "static";
  if (mode === "static") return undefined;

  if (auth.type === "bearer") {
    return {
      sourceKey,
      mode,
      authType: "bearer",
    };
  }
  if (auth.type === "basic") {
    return {
      sourceKey,
      mode,
      authType: "basic",
    };
  }

  return {
    sourceKey,
    mode,
    authType: "apiKey",
    headerName: auth.header,
  };
}

function buildOpenApiUrl(
  baseUrl: string,
  pathTemplate: string,
  parameters: Array<{ name: string; in: string }>,
  input: Record<string, unknown>,
): { url: string; bodyInput: Record<string, unknown> } {
  let resolvedPath = pathTemplate;
  const bodyInput = { ...input };
  const searchParams = new URLSearchParams();

  for (const parameter of parameters) {
    const value = input[parameter.name];
    if (value === undefined) continue;

    if (parameter.in === "path") {
      resolvedPath = resolvedPath.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
      delete bodyInput[parameter.name];
      continue;
    }

    if (parameter.in === "query") {
      searchParams.set(parameter.name, String(value));
      delete bodyInput[parameter.name];
    }
  }

  const url = new URL(`${baseUrl.replace(/\/$/, "")}${resolvedPath}`);
  for (const [key, value] of searchParams.entries()) {
    url.searchParams.set(key, value);
  }

  return {
    url: url.toString(),
    bodyInput,
  };
}

async function loadOpenApiTools(config: OpenApiToolSourceConfig): Promise<ToolDefinition[]> {
  const api = (await (SwaggerParser as unknown as {
    dereference(spec: unknown): Promise<unknown>;
  }).dereference(config.spec)) as Record<string, unknown>;
  const servers = Array.isArray(api.servers) ? (api.servers as Array<{ url?: unknown }>) : [];
  const baseUrl = config.baseUrl ?? String(servers[0]?.url ?? "");
  if (!baseUrl) {
    throw new Error(`OpenAPI source ${config.name} has no base URL (set baseUrl)`);
  }

  const authHeaders = buildStaticAuthHeaders(config.auth);
  const sourceKey = `openapi:${config.name}`;
  const credentialSpec = buildCredentialSpec(sourceKey, config.auth);
  const paths = asRecord(api.paths);
  const tools: ToolDefinition[] = [];

  const methods = ["get", "post", "put", "delete", "patch", "head", "options"] as const;
  const readMethods = new Set(["get", "head", "options"]);

  for (const [pathTemplate, pathValue] of Object.entries(paths)) {
    const pathObject = asRecord(pathValue);
    const sharedParameters = Array.isArray(pathObject.parameters)
      ? (pathObject.parameters as Array<Record<string, unknown>>)
      : [];

    for (const method of methods) {
      const operation = asRecord(pathObject[method]);
      if (Object.keys(operation).length === 0) continue;

      const tags = Array.isArray(operation.tags) ? (operation.tags as unknown[]) : [];
      const tag = sanitizeSegment(String(tags[0] ?? "default"));
      const operationIdRaw = String(operation.operationId ?? `${method}_${pathTemplate}`);
      const operationId = sanitizeSegment(operationIdRaw);
      const parameters = [
        ...sharedParameters,
        ...(Array.isArray(operation.parameters)
          ? (operation.parameters as Array<Record<string, unknown>>)
          : []),
      ].map((entry) => ({
        name: String(entry.name ?? ""),
        in: String(entry.in ?? "query"),
        required: Boolean(entry.required),
        schema: asRecord(entry.schema),
      }));

      const requestBody = asRecord(operation.requestBody);
      const requestBodyContent = asRecord(requestBody.content);
      const requestBodySchema = asRecord(
        asRecord(requestBodyContent["application/json"])["schema"] ??
        asRecord(requestBodyContent["*/*"])["schema"],
      );

      const responses = asRecord(operation.responses);
      let responseSchema: Record<string, unknown> = {};
      for (const [status, responseValue] of Object.entries(responses)) {
        if (!status.startsWith("2")) continue;
        const responseContent = asRecord(asRecord(responseValue).content);
        responseSchema = asRecord(
          asRecord(responseContent["application/json"])["schema"] ??
          asRecord(responseContent["*/*"])["schema"],
        );
        if (Object.keys(responseSchema).length > 0) break;
      }

      const combinedSchema: JsonSchema = {
        type: "object",
        properties: {
          ...Object.fromEntries(parameters.map((param) => [param.name, param.schema])),
          ...asRecord(requestBodySchema.properties),
        },
        required: [
          ...parameters.filter((param) => param.required).map((param) => param.name),
          ...((Array.isArray(requestBodySchema.required)
            ? requestBodySchema.required.filter((item): item is string => typeof item === "string")
            : []) as string[]),
        ],
      };

      const approval = config.overrides?.[operationIdRaw]?.approval
        ?? (readMethods.has(method)
          ? config.defaultReadApproval ?? "auto"
          : config.defaultWriteApproval ?? "required");

      tools.push({
        path: `${sanitizeSegment(config.name)}.${tag}.${operationId}`,
        source: sourceKey,
        approval,
        description: String(operation.summary ?? operation.description ?? `${method.toUpperCase()} ${pathTemplate}`),
        metadata: {
          argsType: jsonSchemaToTypeString(combinedSchema),
          returnsType: jsonSchemaToTypeString(responseSchema),
        },
        credential: credentialSpec,
        run: async (input: unknown, context) => {
          const payload = asRecord(input);
          const { url, bodyInput } = buildOpenApiUrl(baseUrl, pathTemplate, parameters, payload);
          const hasBody = !readMethods.has(method) && Object.keys(bodyInput).length > 0;

          const response = await fetch(url, {
            method: method.toUpperCase(),
            headers: {
              ...authHeaders,
              ...(context.credential?.headers ?? {}),
              ...(hasBody ? { "content-type": "application/json" } : {}),
            },
            body: hasBody ? JSON.stringify(bodyInput) : undefined,
          });

          if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
          }

          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("json")) {
            return await response.json();
          }
          return await response.text();
        },
      });
    }
  }

  return tools;
}

// ── GraphQL introspection ──

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

interface GqlTypeRef {
  kind: string;
  name: string | null;
  ofType?: GqlTypeRef | null;
}

interface GqlField {
  name: string;
  description: string | null;
  args: Array<{
    name: string;
    description: string | null;
    type: GqlTypeRef;
    defaultValue: string | null;
  }>;
  type: GqlTypeRef;
}

interface GqlInputField {
  name: string;
  description: string | null;
  type: GqlTypeRef;
  defaultValue: string | null;
}

interface GqlEnumValue {
  name: string;
  description: string | null;
}

interface GqlType {
  kind: string;
  name: string;
  fields: GqlField[] | null;
  inputFields: GqlInputField[] | null;
  enumValues: GqlEnumValue[] | null;
}

interface GqlSchema {
  queryType: { name: string } | null;
  mutationType: { name: string } | null;
  types: GqlType[];
}

/** Resolve a GqlTypeRef to the underlying named type (unwrapping NON_NULL/LIST wrappers) */
function unwrapType(ref: GqlTypeRef): string | null {
  if (ref.kind === "NON_NULL" && ref.ofType) return unwrapType(ref.ofType);
  if (ref.kind === "LIST" && ref.ofType) return unwrapType(ref.ofType);
  return ref.name;
}

/**
 * Convert a GraphQL type reference to a TypeScript-like type hint,
 * recursively expanding INPUT_OBJECT types so the model sees actual fields.
 */
function gqlTypeToHint(ref: GqlTypeRef, typeMap?: Map<string, GqlType>, depth = 0): string {
  if (ref.kind === "NON_NULL" && ref.ofType) return gqlTypeToHint(ref.ofType, typeMap, depth);
  if (ref.kind === "LIST" && ref.ofType) return `${gqlTypeToHint(ref.ofType, typeMap, depth)}[]`;

  if (ref.name && typeMap && depth < 3) {
    const resolved = typeMap.get(ref.name);
    if (resolved?.kind === "INPUT_OBJECT" && resolved.inputFields) {
      return expandInputObject(resolved, typeMap, depth);
    }
    if (resolved?.kind === "ENUM" && resolved.enumValues && resolved.enumValues.length > 0) {
      const values = resolved.enumValues.slice(0, 8).map((v) => `"${v.name}"`);
      const suffix = resolved.enumValues.length > 8 ? " | ..." : "";
      return values.join(" | ") + suffix;
    }
  }

  // Map common GraphQL scalars to TS primitives
  if (ref.name) {
    switch (ref.name) {
      case "String":
      case "ID":
      case "DateTime":
      case "Date":
      case "UUID":
      case "JSONString":
      case "TimelessDate":
        return "string";
      case "Int":
      case "Float":
        return "number";
      case "Boolean":
        return "boolean";
      case "JSON":
      case "JSONObject":
        return "Record<string, unknown>";
      default:
        return ref.name;
    }
  }
  return "unknown";
}

function expandInputObject(type: GqlType, typeMap: Map<string, GqlType>, depth: number): string {
  const fields = type.inputFields;
  if (!fields || fields.length === 0) return "Record<string, unknown>";
  const entries = fields.slice(0, 16).map((f) => {
    const required = f.type.kind === "NON_NULL";
    return `${f.name}${required ? "" : "?"}: ${gqlTypeToHint(f.type, typeMap, depth + 1)}`;
  });
  const suffix = fields.length > 16 ? "; ..." : "";
  return `{ ${entries.join("; ")}${suffix} }`;
}

function gqlFieldArgsTypeHint(args: GqlField["args"], typeMap?: Map<string, GqlType>): string {
  if (args.length === 0) return "{}";
  const entries = args.slice(0, 12).map((a) => {
    const required = a.type.kind === "NON_NULL";
    return `${a.name}${required ? "" : "?"}: ${gqlTypeToHint(a.type, typeMap)}`;
  });
  return `{ ${entries.join("; ")} }`;
}

/** Build a minimal GraphQL document for a single root field with its arguments */
function buildFieldQuery(
  operationType: "query" | "mutation",
  fieldName: string,
  args: GqlField["args"],
): string {
  if (args.length === 0) {
    return `${operationType} { ${fieldName} }`;
  }
  const varDefs = args.map((a) => `$${a.name}: ${printGqlType(a.type)}`).join(", ");
  const fieldArgs = args.map((a) => `${a.name}: $${a.name}`).join(", ");
  return `${operationType}(${varDefs}) { ${fieldName}(${fieldArgs}) }`;
}

function printGqlType(ref: GqlTypeRef): string {
  if (ref.kind === "NON_NULL" && ref.ofType) return `${printGqlType(ref.ofType)}!`;
  if (ref.kind === "LIST" && ref.ofType) return `[${printGqlType(ref.ofType)}]`;
  return ref.name ?? "String";
}

/**
 * Parse a GraphQL query string to extract the operation type and root field names.
 * This is intentionally simple — no full parser needed, just enough for policy routing.
 */
export function parseGraphqlOperationPaths(
  sourceName: string,
  queryString: string,
): { operationType: "query" | "mutation" | "subscription"; fieldPaths: string[] } {
  const trimmed = queryString.trim();

  // Determine operation type
  let operationType: "query" | "mutation" | "subscription" = "query";
  if (/^mutation\b/i.test(trimmed)) operationType = "mutation";
  else if (/^subscription\b/i.test(trimmed)) operationType = "subscription";

  // Find the first { ... } block and extract top-level field names
  const braceStart = trimmed.indexOf("{");
  if (braceStart === -1) return { operationType, fieldPaths: [] };

  // Walk the content inside the first braces, extract field names at depth 0
  const content = trimmed.slice(braceStart + 1);
  const fieldPaths: string[] = [];
  let depth = 0;
  let current = "";

  for (const char of content) {
    if (char === "{") {
      if (depth === 0 && current.trim()) {
        // Grab the field name (before any args in parens)
        const fieldName = current.trim().split(/[\s(]/)[0];
        if (fieldName && !fieldName.startsWith("__")) {
          fieldPaths.push(`${sanitizeSegment(sourceName)}.${operationType}.${sanitizeSegment(fieldName)}`);
        }
      }
      depth++;
      current = "";
    } else if (char === "}") {
      if (depth === 0) {
        // End of top-level block — grab last field if any
        const fieldName = current.trim().split(/[\s(]/)[0];
        if (fieldName && !fieldName.startsWith("__")) {
          fieldPaths.push(`${sanitizeSegment(sourceName)}.${operationType}.${sanitizeSegment(fieldName)}`);
        }
        break;
      }
      depth--;
      current = "";
    } else if (depth === 0) {
      if (char === "\n" || char === ",") {
        const fieldName = current.trim().split(/[\s(]/)[0];
        if (fieldName && !fieldName.startsWith("__")) {
          fieldPaths.push(`${sanitizeSegment(sourceName)}.${operationType}.${sanitizeSegment(fieldName)}`);
        }
        current = "";
      } else {
        current += char;
      }
    }
  }

  return { operationType, fieldPaths };
}

async function loadGraphqlTools(config: GraphqlToolSourceConfig): Promise<ToolDefinition[]> {
  const authHeaders = buildStaticAuthHeaders(config.auth);
  const sourceKey = `graphql:${config.name}`;
  const credentialSpec = buildCredentialSpec(sourceKey, config.auth);
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
    description: `Execute a GraphQL query or mutation against ${config.name}. Use the ${sourceName}.query.* and ${sourceName}.mutation.* tool descriptions to see available operations.`,
    approval: "auto", // Actual approval is determined dynamically per-invocation
    metadata: {
      argsType: "{ query: string; variables?: Record<string, unknown> }",
      returnsType: "unknown",
    },
    credential: credentialSpec,
    // Tag as graphql source so invokeTool knows to do dynamic path extraction
    _graphqlSource: config.name,
    run: async (input: unknown, context) => {
      const payload = asRecord(input);
      const query = String(payload.query ?? "");
      const variables = payload.variables ?? undefined;

      if (!query.trim()) {
        throw new Error("GraphQL query string is required");
      }

      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders,
          ...(context.credential?.headers ?? {}),
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
      }

      const result = await response.json() as { data?: unknown; errors?: unknown[] };
      if (result.errors && (!result.data || Object.keys(result.data as object).length === 0)) {
        throw new Error(`GraphQL errors: ${JSON.stringify(result.errors).slice(0, 1000)}`);
      }
      // Return both data and errors if partial
      if (result.errors) return result;
      return result.data;
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

      // Build the example query for the description
      const exampleQuery = buildFieldQuery(operationType, field.name, field.args);

      tools.push({
        path: fieldPath,
        source: sourceKey,
        description: field.description
          ? `${field.description}\n\nExample: ${sourceName}.graphql({ query: \`${exampleQuery}\`, variables: {...} })`
          : `GraphQL ${operationType}: ${field.name}\n\nExample: ${sourceName}.graphql({ query: \`${exampleQuery}\`, variables: {...} })`,
        approval,
        metadata: {
          argsType: gqlFieldArgsTypeHint(field.args, typeMap),
          returnsType: gqlTypeToHint(field.type, typeMap),
        },
        // Pseudo-tools don't have a run — they exist for discovery and policy matching only
        _pseudoTool: true,
        run: async (input: unknown, context) => {
          // If someone calls this directly, delegate to the main graphql tool
          const payload = asRecord(input);
          if (!payload.query) {
            // Auto-build the query from the variables
            payload.query = buildFieldQuery(operationType, field.name, field.args);
          }
          // Find and invoke the main tool
          const mainTool = tools.find((t) => t.path === mainToolPath);
          if (!mainTool) throw new Error(`Main GraphQL tool not found`);
          return mainTool.run(payload, context);
        },
      } as ToolDefinition & { _pseudoTool: boolean });
    }
  }

  return tools;
}

export function parseToolSourcesFromEnv(raw: string | undefined): ExternalToolSourceConfig[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("EXECUTOR_TOOL_SOURCES must be a JSON array");
  }

  return parsed as ExternalToolSourceConfig[];
}

export async function loadExternalTools(sources: ExternalToolSourceConfig[]): Promise<{ tools: ToolDefinition[]; warnings: string[] }> {
  const results = await Promise.allSettled(
    sources.map(async (source) => {
      if (source.type === "mcp") {
        return await loadMcpTools(source);
      } else if (source.type === "openapi") {
        return await loadOpenApiTools(source);
      } else if (source.type === "graphql") {
        return await loadGraphqlTools(source);
      }
      return [];
    }),
  );

  const loaded: ToolDefinition[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === "fulfilled") {
      loaded.push(...result.value);
    } else {
      const source = sources[i]!;
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      warnings.push(`Failed to load ${source.type} source '${source.name}': ${message}`);
      console.warn(`[executor] failed to load tool source ${source.type}:${source.name}: ${message}`);
    }
  }

  return { tools: loaded, warnings };
}
