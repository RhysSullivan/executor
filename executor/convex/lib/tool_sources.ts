"use node";

import SwaggerParser from "@apidevtools/swagger-parser";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import openapiTS, { astToString } from "openapi-typescript";
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

// ── Type generation from OpenAPI specs ──────────────────────────────────────
//
// We use `openapiTS(spec)` — the same thing as `npx openapi-typescript` — to
// generate a full .d.ts from the spec. This handles $ref resolution, circular
// references, discriminators, etc. correctly by emitting named type aliases
// instead of inlining everything.
//
// From the generated output we extract per-operation type strings. The output
// has a predictable structure:
//
//   export interface operations {
//     operationId: {
//       parameters: { query: { ... }; path: { ... }; ... };
//       requestBody?: { content: { "application/json": { ... } } };
//       responses: { 200: { content: { "application/json": { ... } } } };
//     };
//   }
//
// We parse this with TypeScript's compiler API to extract the parameter,
// request body, and response types per operation.

/**
 * Generate TypeScript types for an entire OpenAPI spec using openapi-typescript.
 * Returns a map of operationId → { argsType, returnsType } strings.
 *
 * Falls back to the hand-rolled type hint generator on failure (e.g. Swagger 2.0
 * specs, broken $refs).
 */
async function generateOpenApiTypes(
  spec: string | Record<string, unknown>,
): Promise<ExtractedTypes | null> {
  try {
    const input = typeof spec === "string" ? new URL(spec) : (spec as never);
    const ast = await openapiTS(input, { silent: true });
    const dts = astToString(ast);
    return extractOperationTypes(dts);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[executor] openapi-typescript failed, using fallback types: ${msg}`);
    return null;
  }
}

/** Result of extracting types from a generated .d.ts */
interface ExtractedTypes {
  /** Per-operation type strings (operationId → args/returns) */
  operations: Map<string, { argsType: string; returnsType: string }>;
  /**
   * Schema type aliases referenced by operations. These need to be included
   * in the typechecker context for the operation types to be valid.
   * e.g. `{ "Account": "{ id: string; type: string; ... }" }`
   */
  schemas: Map<string, string>;
}

/**
 * Parse the generated .d.ts to extract per-operation args/returns type strings.
 * Resolves `components["schemas"]["X"]` references into named type aliases
 * so the extracted types are self-contained.
 */
function extractOperationTypes(dts: string): ExtractedTypes {
  let ts: typeof import("typescript");
  try {
    ts = require("typescript");
  } catch {
    return { operations: new Map(), schemas: new Map() };
  }

  const sourceFile = ts.createSourceFile("openapi.d.ts", dts, ts.ScriptTarget.ESNext, true);
  const operations = new Map<string, { argsType: string; returnsType: string }>();

  // Find the `operations` interface
  let operationsInterface: import("typescript").InterfaceDeclaration | undefined;
  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === "operations") {
      operationsInterface = stmt;
      break;
    }
  }
  if (!operationsInterface) return { operations, schemas: new Map() };

  // Extract raw per-operation types (may contain components["schemas"]["..."] refs)
  for (const member of operationsInterface.members) {
    if (!ts.isPropertySignature(member) || !member.name) continue;
    const operationId = ts.isStringLiteral(member.name)
      ? member.name.text
      : ts.isIdentifier(member.name)
        ? member.name.text
        : undefined;
    if (!operationId || !member.type || !ts.isTypeLiteralNode(member.type)) continue;

    const opType = member.type;
    const argsType = extractArgsType(ts, opType, sourceFile);
    const returnsType = extractReturnsType(ts, opType, sourceFile);

    operations.set(operationId, { argsType, returnsType });
  }

  // Collect all referenced schema names from the operation type strings
  const referencedSchemas = new Set<string>();
  const refPattern = /components\["schemas"\]\["([^"]+)"\]/g;
  for (const { argsType, returnsType } of operations.values()) {
    for (const match of argsType.matchAll(refPattern)) referencedSchemas.add(match[1]!);
    for (const match of returnsType.matchAll(refPattern)) referencedSchemas.add(match[1]!);
  }

  // Build schema lookup from the components interface in the .d.ts
  const schemaTypeMap = new Map<string, string>();
  if (referencedSchemas.size > 0) {
    const schemasNode = findComponentsSchemas(ts, sourceFile);
    if (schemasNode) {
      // First pass: extract all schema type texts (we need them for transitive refs)
      const allSchemaTexts = new Map<string, string>();
      for (const m of schemasNode.members) {
        if (!ts.isPropertySignature(m) || !m.name || !m.type) continue;
        const name = ts.isIdentifier(m.name) ? m.name.text : ts.isStringLiteral(m.name) ? m.name.text : undefined;
        if (!name) continue;
        allSchemaTexts.set(name, m.type.getText(sourceFile).replace(/\s+/g, " ").trim());
      }

      // Resolve referenced schemas (one level deep — resolve transitive refs too)
      const toResolve = new Set(referencedSchemas);
      const resolved = new Set<string>();
      while (toResolve.size > 0) {
        const next = toResolve.values().next().value!;
        toResolve.delete(next);
        if (resolved.has(next)) continue;
        resolved.add(next);

        const typeText = allSchemaTexts.get(next);
        if (!typeText) continue;

        schemaTypeMap.set(next, typeText);

        // Find transitive refs in this schema — but cap total schemas to avoid blowup
        if (resolved.size < 200) {
          for (const match of typeText.matchAll(refPattern)) {
            if (!resolved.has(match[1]!)) toResolve.add(match[1]!);
          }
        }
      }
    }
  }

  // Replace components["schemas"]["X"] with the schema name as a type alias
  // in all operation type strings, and collect the needed schema definitions
  const schemas = new Map<string, string>();
  const schemaNameMap = new Map<string, string>(); // "checkout.session" → "CheckoutSession"

  for (const schemaName of schemaTypeMap.keys()) {
    // Convert schema name to a valid TS identifier: "checkout.session" → "CheckoutSession"
    const tsName = schemaName
      .split(/[._-]/)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join("");
    schemaNameMap.set(schemaName, tsName);
  }

  // Replace refs in schema definitions themselves (transitive refs)
  for (const [schemaName, typeText] of schemaTypeMap) {
    const tsName = schemaNameMap.get(schemaName)!;
    let resolved = typeText;
    for (const [refName, refTsName] of schemaNameMap) {
      resolved = resolved.replaceAll(`components["schemas"]["${refName}"]`, refTsName);
    }
    // Any remaining unresolved refs → unknown
    resolved = resolved.replace(refPattern, "unknown");
    schemas.set(tsName, resolved);
  }

  // Replace refs in operation type strings
  for (const [opId, types] of operations) {
    let { argsType, returnsType } = types;
    for (const [refName, refTsName] of schemaNameMap) {
      argsType = argsType.replaceAll(`components["schemas"]["${refName}"]`, refTsName);
      returnsType = returnsType.replaceAll(`components["schemas"]["${refName}"]`, refTsName);
    }
    // Any remaining unresolved refs → unknown
    argsType = argsType.replace(refPattern, "unknown");
    returnsType = returnsType.replace(refPattern, "unknown");
    operations.set(opId, { argsType, returnsType });
  }

  // Also resolve components["parameters"]["X"] refs to unknown (less common)
  const paramRefPattern = /components\["parameters"\]\["[^"]+"\]/g;
  for (const [opId, types] of operations) {
    operations.set(opId, {
      argsType: types.argsType.replace(paramRefPattern, "unknown"),
      returnsType: types.returnsType.replace(paramRefPattern, "unknown"),
    });
  }

  return { operations, schemas };
}

/** Find the components.schemas type literal in the .d.ts AST */
function findComponentsSchemas(
  ts: typeof import("typescript"),
  sourceFile: import("typescript").SourceFile,
): import("typescript").TypeLiteralNode | undefined {
  for (const stmt of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(stmt) || stmt.name.text !== "components") continue;
    for (const member of stmt.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      const name = ts.isIdentifier(member.name) ? member.name.text : undefined;
      if (name === "schemas" && member.type && ts.isTypeLiteralNode(member.type)) {
        return member.type;
      }
    }
  }
  return undefined;
}

function extractArgsType(
  ts: typeof import("typescript"),
  opType: import("typescript").TypeLiteralNode,
  sourceFile: import("typescript").SourceFile,
): string {
  const parts: string[] = [];

  // Extract parameters (query, path, header)
  const paramsMember = findMember(ts, opType, "parameters");
  if (paramsMember?.type && ts.isTypeLiteralNode(paramsMember.type)) {
    for (const locationMember of paramsMember.type.members) {
      if (!ts.isPropertySignature(locationMember) || !locationMember.name) continue;
      const locName = ts.isIdentifier(locationMember.name) ? locationMember.name.text : "";
      if (!["query", "path", "header"].includes(locName)) continue;
      if (!locationMember.type || !ts.isTypeLiteralNode(locationMember.type)) continue;

      for (const param of locationMember.type.members) {
        if (!ts.isPropertySignature(param) || !param.name || !param.type) continue;
        const paramName = ts.isIdentifier(param.name)
          ? param.name.text
          : ts.isStringLiteral(param.name)
            ? param.name.text
            : undefined;
        if (!paramName) continue;
        const optional = param.questionToken ? "?" : "";
        const typeText = param.type.getText(sourceFile).replace(/\s+/g, " ").trim();
        parts.push(`${paramName}${optional}: ${typeText}`);
      }
    }
  }

  // Extract requestBody content
  const bodyMember = findMember(ts, opType, "requestBody");
  if (bodyMember?.type) {
    const bodyTypeNode = ts.isTypeLiteralNode(bodyMember.type) ? bodyMember.type : null;
    if (bodyTypeNode) {
      const contentMember = findMember(ts, bodyTypeNode, "content");
      if (contentMember?.type && ts.isTypeLiteralNode(contentMember.type)) {
        // Look for application/json or */* or first content type
        for (const ct of contentMember.type.members) {
          if (!ts.isPropertySignature(ct) || !ct.name || !ct.type) continue;
          const ctName = ts.isStringLiteral(ct.name) ? ct.name.text : ts.isIdentifier(ct.name) ? ct.name.text : "";
          if (ctName === "application/json" || ctName === "*/*" || ctName.includes("json")) {
            // The body type — try to merge its properties into the args
            if (ts.isTypeLiteralNode(ct.type)) {
              for (const bodyProp of ct.type.members) {
                if (!ts.isPropertySignature(bodyProp) || !bodyProp.name || !bodyProp.type) continue;
                const propName = ts.isIdentifier(bodyProp.name)
                  ? bodyProp.name.text
                  : ts.isStringLiteral(bodyProp.name)
                    ? bodyProp.name.text
                    : undefined;
                if (!propName) continue;
                const optional = bodyProp.questionToken ? "?" : "";
                const typeText = bodyProp.type.getText(sourceFile).replace(/\s+/g, " ").trim();
                parts.push(`${propName}${optional}: ${typeText}`);
              }
            } else {
              // Non-literal body type (e.g. components["schemas"]["..."]) — inline as `body`
              const typeText = ct.type.getText(sourceFile).replace(/\s+/g, " ").trim();
              if (typeText && typeText !== "never") {
                parts.push(`body: ${typeText}`);
              }
            }
            break;
          }
        }
      }
    }
  }

  if (parts.length === 0) return "Record<string, unknown>";
  return `{ ${parts.join("; ")} }`;
}

function extractReturnsType(
  ts: typeof import("typescript"),
  opType: import("typescript").TypeLiteralNode,
  sourceFile: import("typescript").SourceFile,
): string {
  const responsesMember = findMember(ts, opType, "responses");
  if (!responsesMember?.type || !ts.isTypeLiteralNode(responsesMember.type)) return "unknown";

  // Find the first 2xx response
  for (const resp of responsesMember.type.members) {
    if (!ts.isPropertySignature(resp) || !resp.name || !resp.type) continue;
    const status = ts.isNumericLiteral(resp.name)
      ? resp.name.text
      : ts.isStringLiteral(resp.name)
        ? resp.name.text
        : ts.isIdentifier(resp.name)
          ? resp.name.text
          : "";
    if (!status.startsWith("2")) continue;
    if (!ts.isTypeLiteralNode(resp.type)) continue;

    const contentMember = findMember(ts, resp.type, "content");
    if (!contentMember?.type || !ts.isTypeLiteralNode(contentMember.type)) continue;

    let firstTypeText: string | undefined;
    for (const ct of contentMember.type.members) {
      if (!ts.isPropertySignature(ct) || !ct.name || !ct.type) continue;
      const ctName = ts.isStringLiteral(ct.name) ? ct.name.text : ts.isIdentifier(ct.name) ? ct.name.text : "";
      const typeText = ct.type.getText(sourceFile).replace(/\s+/g, " ").trim();
      if (!firstTypeText && typeText && typeText !== "never") firstTypeText = typeText;
      if (ctName === "application/json" || ctName === "*/*" || ctName.includes("json")) {
        return typeText || "unknown";
      }
    }
    if (firstTypeText) return firstTypeText;
  }

  return "unknown";
}

function findMember(
  ts: typeof import("typescript"),
  typeLiteral: import("typescript").TypeLiteralNode,
  name: string,
): import("typescript").PropertySignature | undefined {
  for (const member of typeLiteral.members) {
    if (!ts.isPropertySignature(member) || !member.name) continue;
    const memberName = ts.isIdentifier(member.name)
      ? member.name.text
      : ts.isStringLiteral(member.name)
        ? member.name.text
        : undefined;
    if (memberName === name) return member;
  }
  return undefined;
}

function getPreferredContentSchema(content: Record<string, unknown>): Record<string, unknown> {
  const preferredKeys = ["application/json", "*/*"];

  for (const key of preferredKeys) {
    const schema = asRecord(asRecord(content[key]).schema);
    if (Object.keys(schema).length > 0) return schema;
  }

  for (const [key, value] of Object.entries(content)) {
    if (!key.includes("json")) continue;
    const schema = asRecord(asRecord(value).schema);
    if (Object.keys(schema).length > 0) return schema;
  }

  for (const value of Object.values(content)) {
    const schema = asRecord(asRecord(value).schema);
    if (Object.keys(schema).length > 0) return schema;
  }

  return {};
}

/** Simple depth-limited type hint generator for schemas (used as fallback) */
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
        argsType: jsonSchemaTypeHintFallback(inputSchema),
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

export interface PreparedOpenApiSpec {
  servers: string[];
  paths: Record<string, unknown>;
  operationTypes?: Record<string, { argsType: string; returnsType: string }>;
  schemaTypes?: Record<string, string>;
  warnings: string[];
}

export async function prepareOpenApiSpec(
  spec: string | Record<string, unknown>,
  sourceName = "openapi",
): Promise<PreparedOpenApiSpec> {
  // Run type generation in parallel with spec loading.
  // We prefer `bundle` so external refs are resolved, but some real-world specs
  // contain broken internal refs. In that case, fall back to `parse` so we can
  // still load operation paths and expose usable tools.
  const typeMapPromise = generateOpenApiTypes(spec);
  const parser = SwaggerParser as unknown as {
    bundle(spec: unknown): Promise<unknown>;
    parse(spec: unknown): Promise<unknown>;
  };

  const warnings: string[] = [];
  let bundled: Record<string, unknown>;
  try {
    bundled = await parser.bundle(spec).then((api) => api as Record<string, unknown>);
  } catch (bundleError) {
    const bundleMessage = bundleError instanceof Error ? bundleError.message : String(bundleError);
    warnings.push(`OpenAPI bundle failed for '${sourceName}', using parse-only mode: ${bundleMessage}`);
    try {
      bundled = await parser.parse(spec).then((api) => api as Record<string, unknown>);
    } catch (parseError) {
      const parseMessage = parseError instanceof Error ? parseError.message : String(parseError);
      throw new Error(
        `Failed to load OpenAPI source '${sourceName}': bundle error (${bundleMessage}); parse error (${parseMessage})`,
      );
    }
  }

  const typeMap = await typeMapPromise;
  const servers = Array.isArray(bundled.servers) ? (bundled.servers as Array<{ url?: unknown }>) : [];

  return {
    servers: servers
      .map((server) => (typeof server.url === "string" ? server.url : ""))
      .filter((url) => url.length > 0),
    paths: asRecord(bundled.paths),
    ...(typeMap
      ? {
          operationTypes: Object.fromEntries(typeMap.operations),
          ...(typeMap.schemas.size > 0 ? { schemaTypes: Object.fromEntries(typeMap.schemas) } : {}),
        }
      : {}),
    warnings,
  };
}

export function buildOpenApiToolsFromPrepared(
  config: OpenApiToolSourceConfig,
  prepared: PreparedOpenApiSpec,
): ToolDefinition[] {
  const baseUrl = config.baseUrl ?? prepared.servers[0] ?? "";
  if (!baseUrl) {
    throw new Error(`OpenAPI source ${config.name} has no base URL (set baseUrl)`);
  }

  const authHeaders = buildStaticAuthHeaders(config.auth);
  const sourceKey = `openapi:${config.name}`;
  const credentialSpec = buildCredentialSpec(sourceKey, config.auth);
  const paths = asRecord(prepared.paths);
  const tools: ToolDefinition[] = [];

  // Schema type aliases referenced by operations — stored on the first tool only
  // to avoid duplicating hundreds of KB across every tool from this source.
  const schemaTypes = prepared.schemaTypes && Object.keys(prepared.schemaTypes).length > 0
    ? prepared.schemaTypes
    : undefined;
  let schemaTypesEmitted = false;

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

      // Use openapiTS-generated types if available, otherwise fall back to schema hints
      const generatedTypes = prepared.operationTypes?.[operationIdRaw];
      let argsType: string;
      let returnsType: string;

      if (generatedTypes) {
        argsType = generatedTypes.argsType;
        returnsType = generatedTypes.returnsType;
      } else {
        // Fallback: build types from the bundled schema using the depth-limited hint generator
        const requestBody = asRecord(operation.requestBody);
        const requestBodyContent = asRecord(requestBody.content);
        const requestBodySchema = getPreferredContentSchema(requestBodyContent);

        const responses = asRecord(operation.responses);
        let responseSchema: Record<string, unknown> = {};
        for (const [status, responseValue] of Object.entries(responses)) {
          if (!status.startsWith("2")) continue;
          const responseContent = asRecord(asRecord(responseValue).content);
          responseSchema = getPreferredContentSchema(responseContent);
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

        argsType = jsonSchemaTypeHintFallback(combinedSchema);
        returnsType = jsonSchemaTypeHintFallback(responseSchema);
      }

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
          argsType,
          returnsType,
          // Only attach schemas to the first tool to avoid duplicating hundreds of KB
          ...(schemaTypes && !schemaTypesEmitted ? { schemaTypes } : {}),
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

      // Mark schemas as emitted so subsequent tools from this source don't duplicate them
      if (schemaTypes && !schemaTypesEmitted) {
        schemaTypesEmitted = true;
      }
    }
  }

  return tools;
}

async function loadOpenApiTools(config: OpenApiToolSourceConfig): Promise<ToolDefinition[]> {
  const prepared = await prepareOpenApiSpec(config.spec, config.name);
  return buildOpenApiToolsFromPrepared(config, prepared);
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
