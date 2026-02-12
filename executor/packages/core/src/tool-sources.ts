"use node";

import SwaggerParser from "@apidevtools/swagger-parser";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import openapiTS, { astToString } from "openapi-typescript";
import { Kind, parse, type FragmentDefinitionNode, type SelectionSetNode } from "graphql";
import { compactArgKeysHint, compactArgTypeHint, compactReturnTypeHint } from "./type-hints";
import type { ToolApprovalMode, ToolCredentialSpec, ToolDefinition, ToolTypeMetadata } from "./types";
import { asRecord } from "./utils";

type JsonSchema = Record<string, unknown>;

export interface McpToolSourceConfig {
  type: "mcp";
  name: string;
  sourceId?: string;
  sourceKey?: string;
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
  sourceId?: string;
  sourceKey?: string;
  spec: string | Record<string, unknown>;
  /** Optional canonical Postman collection URL for display/debugging. */
  collectionUrl?: string;
  /** Optional override for Postman ws/proxy endpoint (primarily for tests). */
  postmanProxyUrl?: string;
  baseUrl?: string;
  auth?: OpenApiAuth;
  defaultReadApproval?: ToolApprovalMode;
  defaultWriteApproval?: ToolApprovalMode;
  overrides?: Record<string, { approval?: ToolApprovalMode }>;
}

export interface GraphqlToolSourceConfig {
  type: "graphql";
  name: string;
  sourceId?: string;
  sourceKey?: string;
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

interface PostmanSerializedRunSpec {
  kind: "postman";
  method: string;
  url: string;
  headers: Record<string, string>;
  queryParams: Array<{ key: string; value: string }>;
  body?:
    | { kind: "urlencoded"; entries: Array<{ key: string; value: string }> }
    | { kind: "raw"; text: string };
  variables: Record<string, string>;
  authHeaders: Record<string, string>;
}

const POSTMAN_SPEC_PREFIX = "postman:";
const DEFAULT_POSTMAN_PROXY_URL = "https://www.postman.com/_api/ws/proxy";
const POSTMAN_TEMPLATE_PATTERN = /\{\{([^{}]+)\}\}/g;

function sanitizeSegment(value: string): string {
  const cleanedBase = value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  const cleaned = cleanedBase.length > 0 ? cleanedBase : "default";
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

function sanitizeSnakeSegment(value: string): string {
  const withWordBreaks = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([A-Za-z])([0-9])/g, "$1_$2")
    .replace(/([0-9])([A-Za-z])/g, "$1_$2");

  return sanitizeSegment(withWordBreaks);
}

function normalizeOpenApiTag(tagRaw: string): string {
  let tag = sanitizeSnakeSegment(tagRaw);
  tag = tag
    .replace(/^api_?\d{8}_?/, "")
    .replace(/^v\d+_?/, "");
  return tag || "default";
}

function buildOpenApiToolPath(
  sourceName: string,
  tagRaw: string,
  operationIdRaw: string,
  usedPaths: Set<string>,
): string {
  const source = sanitizeSegment(sourceName);
  const tag = normalizeOpenApiTag(tagRaw);
  const operation = sanitizeSnakeSegment(operationIdRaw);
  let operationName = operation;

  if (tag !== "default" && operation.startsWith(`${tag}_`)) {
    operationName = operation.slice(tag.length + 1) || operation;
  }

  const withTag = tag === "default"
    ? `${source}.${operationName}`
    : `${source}.${tag}.${operationName}`;

  const basePath = withTag;

  let path = basePath;
  let suffix = 2;
  while (usedPaths.has(path)) {
    path = `${basePath}_${suffix}`;
    suffix += 1;
  }
  usedPaths.add(path);

  return path;
}

// ── Type generation from OpenAPI specs ──────────────────────────────────────
//
// We use `openapiTS(spec)` — the same thing as `npx openapi-typescript` — to
// generate a full .d.ts from the spec. The raw .d.ts is stored as-is and
// passed directly to the typechecker / Monaco, which use TS helper types
// (`ToolInput<operations["X"]>`, `ToolOutput<operations["X"]>`) to extract
// per-operation arg/return types via indexed access. This avoids the need to
// parse the .d.ts with the TS compiler API to extract per-operation type strings.
//
// For the LLM prompt and discover tool, we generate lightweight type hints
// from the JSON Schema fallback generator (`jsonSchemaTypeHintFallback`).

/**
 * Strip discriminators whose `mapping` values reference non-existent `$ref`
 * paths in the spec. Some specs (e.g. Cloudflare) ship with broken
 * discriminator mappings that cause openapi-typescript to throw. Removing
 * only the broken discriminators is enough to unblock codegen while
 * preserving all valid discriminators.
 *
 * Returns null if no broken discriminators were found (no changes needed).
 */
function stripBrokenDiscriminators(spec: Record<string, unknown>): Record<string, unknown> | null {
  let strippedCount = 0;

  function refExists(ref: string): boolean {
    if (!ref.startsWith("#/")) return true; // external ref — assume valid
    const segments = ref.slice(2).split("/");
    let target: unknown = spec;
    for (const segment of segments) {
      if (target && typeof target === "object") {
        target = (target as Record<string, unknown>)[segment];
      } else {
        return false;
      }
    }
    return target !== undefined;
  }

  // Quick scan: check if there are any broken discriminators at all
  function hasBrokenDiscriminators(obj: unknown): boolean {
    if (Array.isArray(obj)) return obj.some(hasBrokenDiscriminators);
    if (obj && typeof obj === "object") {
      const record = obj as Record<string, unknown>;
      if (record.discriminator && typeof record.discriminator === "object") {
        const disc = record.discriminator as Record<string, unknown>;
        if (disc.mapping && typeof disc.mapping === "object") {
          const mapping = disc.mapping as Record<string, string>;
          if (Object.values(mapping).some((ref) => typeof ref === "string" && !refExists(ref))) {
            return true;
          }
        }
      }
      return Object.values(record).some(hasBrokenDiscriminators);
    }
    return false;
  }

  if (!hasBrokenDiscriminators(spec)) return null;

  function walk(obj: unknown): unknown {
    if (Array.isArray(obj)) return obj.map(walk);
    if (obj && typeof obj === "object") {
      const record = obj as Record<string, unknown>;
      const clone: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (key === "discriminator" && typeof value === "object" && value !== null) {
          const disc = value as Record<string, unknown>;
          if (disc.mapping && typeof disc.mapping === "object") {
            const mapping = disc.mapping as Record<string, string>;
            const hasBroken = Object.values(mapping).some(
              (ref) => typeof ref === "string" && !refExists(ref),
            );
            if (hasBroken) {
              strippedCount++;
              continue; // drop this broken discriminator
            }
          }
        }
        clone[key] = walk(value);
      }
      return clone;
    }
    return obj;
  }

  const result = walk(spec) as Record<string, unknown>;
  console.warn(`[executor] stripped ${strippedCount} broken discriminator(s) from OpenAPI spec`);
  return result;
}

/**
 * Generate a .d.ts string for an OpenAPI spec using openapi-typescript.
 *
 * Accepts a pre-parsed object to avoid a redundant HTTP fetch — the caller
 * should have already fetched and parsed the spec.
 *
 * Falls back to null on failure (e.g. Swagger 2.0, broken $refs).
 */
async function generateOpenApiDts(
  spec: Record<string, unknown>,
): Promise<string | null> {
  try {
    const ast = await openapiTS(spec as never, { silent: true });
    return astToString(ast);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // If the spec has broken discriminator $refs, patch them out and retry.
    // This handles specs like Cloudflare's which have invalid discriminator
    // mappings that cause openapi-typescript to throw.
    const patched = stripBrokenDiscriminators(spec);
    if (patched) {
      console.warn(`[executor] openapi-typescript failed, retrying with patched spec: ${msg}`);
      try {
        const ast = await openapiTS(patched as never, { silent: true });
        return astToString(ast);
      } catch (retryError) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
        console.warn(`[executor] openapi-typescript retry also failed: ${retryMsg}`);
        return null;
      }
    }
    console.warn(`[executor] openapi-typescript failed, using fallback types: ${msg}`);
    return null;
  }
}

/**
 * Extract the set of operationIds present in a .d.ts from openapi-typescript.
 * Used to determine which operations have generated types (for compaction).
 * This is a lightweight regex scan — no TS compiler needed.
 */
function extractOperationIdsFromDts(dts: string): Set<string> {
  const ids = new Set<string>();
  // Match property signatures in the operations interface: `operationId: {` or `"operation-id": {`
  const pattern = /^\s{2,4}(?:"([^"]+)"|([A-Za-z_]\w*))\s*:\s*\{/gm;
  // Only scan the operations interface section
  const opsStart = dts.indexOf("export interface operations {");
  if (opsStart === -1) return ids;
  const opsSection = dts.slice(opsStart, opsStart + dts.length);
  for (const match of opsSection.matchAll(pattern)) {
    const id = match[1] ?? match[2];
    if (id) ids.add(id);
  }
  return ids;
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

function getPreferredResponseSchema(responseValue: Record<string, unknown>): Record<string, unknown> {
  // OpenAPI 3.x response shape
  const contentSchema = getPreferredContentSchema(asRecord(responseValue.content));
  if (Object.keys(contentSchema).length > 0) {
    return contentSchema;
  }

  // Swagger 2.x response shape
  const schema = asRecord(responseValue.schema);
  if (Object.keys(schema).length > 0) {
    return schema;
  }

  return {};
}

function resolveSchemaRef(
  schema: Record<string, unknown>,
  componentSchemas: Record<string, unknown>,
): Record<string, unknown> {
  const ref = typeof schema.$ref === "string" ? schema.$ref : "";
  const prefix = "#/components/schemas/";
  if (!ref.startsWith(prefix)) {
    return schema;
  }

  const key = ref.slice(prefix.length);
  const resolved = asRecord(componentSchemas[key]);
  if (Object.keys(resolved).length === 0) {
    return schema;
  }
  return resolved;
}

function resolveRequestBodyRef(
  requestBody: Record<string, unknown>,
  componentRequestBodies: Record<string, unknown>,
): Record<string, unknown> {
  const ref = typeof requestBody.$ref === "string" ? requestBody.$ref : "";
  const prefix = "#/components/requestBodies/";
  if (!ref.startsWith(prefix)) {
    return requestBody;
  }

  const key = ref.slice(prefix.length);
  const resolved = asRecord(componentRequestBodies[key]);
  if (Object.keys(resolved).length === 0) {
    return requestBody;
  }
  return resolved;
}

function resolveResponseRef(
  response: Record<string, unknown>,
  componentResponses: Record<string, unknown>,
): Record<string, unknown> {
  const ref = typeof response.$ref === "string" ? response.$ref : "";
  const prefix = "#/components/responses/";
  if (!ref.startsWith(prefix)) {
    return response;
  }

  const key = ref.slice(prefix.length);
  const resolved = asRecord(componentResponses[key]);
  if (Object.keys(resolved).length === 0) {
    return response;
  }
  return resolved;
}

function parameterSchemaFromEntry(entry: Record<string, unknown>): Record<string, unknown> {
  // OpenAPI 3.x (and Swagger body params) use `schema`
  const schema = asRecord(entry.schema);
  if (Object.keys(schema).length > 0) {
    return schema;
  }

  // Swagger 2.x non-body params use top-level `type`, `enum`, `items`, etc.
  const type = typeof entry.type === "string" ? entry.type : "";
  if (!type) {
    return {};
  }

  const fallback: Record<string, unknown> = { type };
  if (Array.isArray(entry.enum) && entry.enum.length > 0) {
    fallback.enum = entry.enum;
  }
  const items = asRecord(entry.items);
  if (Object.keys(items).length > 0) {
    fallback.items = items;
  }

  return fallback;
}

function responseTypeHintFromSchema(
  responseSchema: Record<string, unknown>,
  responseStatus: string,
  componentSchemas?: Record<string, unknown>,
): string {
  if (Object.keys(responseSchema).length > 0) {
    return jsonSchemaTypeHintFallback(responseSchema, 0, componentSchemas);
  }

  // No-content success responses should be represented as void.
  if (responseStatus === "204" || responseStatus === "205") {
    return "void";
  }

  return "unknown";
}

function formatTsPropertyKey(key: string): string {
  // Keep simple identifiers unquoted for readability.
  // Quote keys with dashes/spaces or other punctuation (e.g. headers).
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return key;
  }
  return JSON.stringify(key);
}

/** Depth-limited + cycle-safe type hint generator for schemas (used as fallback). */
function jsonSchemaTypeHintFallback(
  schema: unknown,
  depth = 0,
  componentSchemas?: Record<string, unknown>,
  seenRefs: Set<string> = new Set(),
): string {
  if (!schema || typeof schema !== "object") return "unknown";
  if (depth > 12) return "unknown";

  const shape = schema as JsonSchema;
  if (typeof shape.$ref === "string") {
    const ref = shape.$ref;
    const prefix = "#/components/schemas/";
    if (ref.startsWith(prefix)) {
      if (seenRefs.has(ref)) {
        return "unknown";
      }
      const key = ref.slice(prefix.length);
      const resolved = componentSchemas ? asRecord(componentSchemas[key]) : {};
      if (Object.keys(resolved).length > 0) {
        const nextSeen = new Set(seenRefs);
        nextSeen.add(ref);
        return jsonSchemaTypeHintFallback(resolved, depth + 1, componentSchemas, nextSeen);
      }
    }
  }

  const enumValues = Array.isArray(shape.enum) ? shape.enum : undefined;
  if (enumValues && enumValues.length > 0) {
    return enumValues.map((value) => JSON.stringify(value)).join(" | ");
  }

  const oneOf = Array.isArray(shape.oneOf) ? shape.oneOf : undefined;
  if (oneOf && oneOf.length > 0) {
    return oneOf.map((entry) => jsonSchemaTypeHintFallback(entry, depth + 1, componentSchemas, seenRefs)).join(" | ");
  }

  const anyOf = Array.isArray(shape.anyOf) ? shape.anyOf : undefined;
  if (anyOf && anyOf.length > 0) {
    return anyOf.map((entry) => jsonSchemaTypeHintFallback(entry, depth + 1, componentSchemas, seenRefs)).join(" | ");
  }

  const allOf = Array.isArray(shape.allOf) ? shape.allOf : undefined;
  if (allOf && allOf.length > 0) {
    const parts = allOf
      .map((entry) => jsonSchemaTypeHintFallback(entry, depth + 1, componentSchemas, seenRefs))
      .filter((part) => part.length > 0 && part !== "unknown");
    if (parts.length > 0) {
      return parts.join(" & ");
    }
  }

  const type = typeof shape.type === "string" ? shape.type : undefined;
  const tupleItems = Array.isArray(shape.items) ? shape.items : undefined;
  if (!type && tupleItems && tupleItems.length > 0) {
    return tupleItems
      .map((entry) => jsonSchemaTypeHintFallback(entry, depth + 1, componentSchemas, seenRefs))
      .join(" | ");
  }
  if (type === "integer") return "number";
  if (type === "string" || type === "number" || type === "boolean" || type === "null") {
    return type;
  }

  if (type === "array") {
    return `${jsonSchemaTypeHintFallback(shape.items, depth + 1, componentSchemas, seenRefs)}[]`;
  }

  const props = asRecord(shape.properties);
  const additionalProperties = shape.additionalProperties;
  const requiredRaw = Array.isArray(shape.required) ? shape.required : [];
  const required = new Set(requiredRaw.filter((item): item is string => typeof item === "string"));
  const propEntries = Object.entries(props);
  if (type === "object" || propEntries.length > 0) {
    if (propEntries.length === 0) {
      if (additionalProperties && typeof additionalProperties === "object") {
        return `Record<string, ${jsonSchemaTypeHintFallback(additionalProperties, depth + 1, componentSchemas, seenRefs)}>`;
      }
      return "Record<string, unknown>";
    }
    const maxInlineProps = 12;
    const isTruncated = propEntries.length > maxInlineProps;
    const inner = propEntries
      .slice(0, maxInlineProps)
      .map(([key, value]) => `${formatTsPropertyKey(key)}${required.has(key) ? "" : "?"}: ${jsonSchemaTypeHintFallback(value, depth + 1, componentSchemas, seenRefs)}`)
      .join("; ");
    const indexSignature = isTruncated ? `${inner ? "; " : ""}[key: string]: any` : "";
    return `{ ${inner}${indexSignature} }`;
  }

  return "unknown";
}

type OpenApiParameterHint = {
  name: string;
  required: boolean;
  schema: Record<string, unknown>;
};

function pushUnique(values: string[], seen: Set<string>, raw: string): void {
  const value = raw.trim();
  if (!value || seen.has(value)) return;
  seen.add(value);
  values.push(value);
}

function collectTopLevelSchemaKeys(
  schema: unknown,
  componentSchemas?: Record<string, unknown>,
  seenRefs: Set<string> = new Set(),
): string[] {
  if (!schema || typeof schema !== "object") return [];

  const record = schema as Record<string, unknown>;
  const ref = typeof record.$ref === "string" ? record.$ref : "";
  if (ref.startsWith("#/components/schemas/")) {
    if (seenRefs.has(ref)) return [];
    const key = ref.slice("#/components/schemas/".length);
    const resolved = componentSchemas ? asRecord(componentSchemas[key]) : {};
    if (Object.keys(resolved).length === 0) return [];
    const nextSeen = new Set(seenRefs);
    nextSeen.add(ref);
    return collectTopLevelSchemaKeys(resolved, componentSchemas, nextSeen);
  }

  const keys: string[] = [];
  const seen = new Set<string>();

  for (const key of Object.keys(asRecord(record.properties))) {
    pushUnique(keys, seen, key);
  }

  const combinators: unknown[] = [
    ...(Array.isArray(record.allOf) ? record.allOf : []),
    ...(Array.isArray(record.oneOf) ? record.oneOf : []),
    ...(Array.isArray(record.anyOf) ? record.anyOf : []),
  ];

  for (const entry of combinators) {
    for (const key of collectTopLevelSchemaKeys(entry, componentSchemas, seenRefs)) {
      pushUnique(keys, seen, key);
    }
  }

  return keys;
}

function buildOpenApiInputSchema(
  parameters: OpenApiParameterHint[],
  requestBodySchema: Record<string, unknown>,
): JsonSchema {
  const hasBodySchema = Object.keys(requestBodySchema).length > 0;
  const hasParams = parameters.length > 0;

  if (!hasBodySchema && !hasParams) {
    return {};
  }

  const parameterSchema: JsonSchema = {
    type: "object",
    properties: Object.fromEntries(parameters.map((param) => [param.name, param.schema])),
    required: parameters.filter((param) => param.required).map((param) => param.name),
  };

  if (!hasBodySchema) {
    return parameterSchema;
  }

  if (!hasParams) {
    return requestBodySchema;
  }

  return {
    allOf: [parameterSchema, requestBodySchema],
  };
}

function buildOpenApiArgPreviewKeys(
  parameters: OpenApiParameterHint[],
  requestBodySchema: Record<string, unknown>,
  componentSchemas?: Record<string, unknown>,
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();

  for (const parameter of parameters) {
    if (!parameter.required) continue;
    pushUnique(keys, seen, parameter.name);
  }

  for (const key of collectTopLevelSchemaKeys(requestBodySchema, componentSchemas)) {
    pushUnique(keys, seen, key);
  }

  for (const parameter of parameters) {
    if (parameter.required) continue;
    pushUnique(keys, seen, parameter.name);
  }

  return keys;
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
    const argPreviewKeys = Object.keys(asRecord(inputSchema.properties)).filter((key) => key.length > 0);
    const argsType = jsonSchemaTypeHintFallback(inputSchema);
    const returnsType = "unknown";
    return {
      path: `${sanitizeSegment(config.name)}.${sanitizeSegment(toolName)}`,
      source: `mcp:${config.name}`,
      approval: config.overrides?.[toolName]?.approval ?? config.defaultApproval ?? "auto",
      description: String(tool.description ?? `MCP tool ${toolName}`),
      metadata: {
        argsType,
        returnsType,
        displayArgsType: compactArgTypeHint(argsType),
        displayReturnsType: compactReturnTypeHint(returnsType),
        ...(argPreviewKeys.length > 0 ? { argPreviewKeys } : {}),
      },
      _runSpec: {
        kind: "mcp" as const,
        url: config.url,
        transport: config.transport,
        queryParams: config.queryParams,
        toolName,
      },
      run: async (input: unknown) => {
        const payload = asRecord(input);
        const result = await callToolWithReconnect(toolName, payload);
        return extractMcpResult(result);
      },
    } satisfies ToolDefinition & { _runSpec: SerializedTool["runSpec"] };
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

function getCredentialSourceKey(config: {
  type: ExternalToolSourceConfig["type"];
  name: string;
  sourceKey?: string;
}): string {
  return config.sourceKey ?? `${config.type}:${config.name}`;
}

export function parsePostmanCollectionUid(spec: string): string | null {
  if (!spec.startsWith(POSTMAN_SPEC_PREFIX)) {
    return null;
  }

  const uid = spec.slice(POSTMAN_SPEC_PREFIX.length).trim();
  if (!uid) {
    return null;
  }

  return uid;
}

function stringifyTemplateValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function interpolatePostmanTemplate(value: string, variables: Record<string, string>): string {
  return value.replace(POSTMAN_TEMPLATE_PATTERN, (_, rawKey: string) => {
    const key = rawKey.trim();
    return Object.prototype.hasOwnProperty.call(variables, key)
      ? variables[key]!
      : `{{${key}}}`;
  });
}

function findUnresolvedPostmanTemplateKeys(value: string): string[] {
  const keys = new Set<string>();
  let match: RegExpExecArray | null;
  const pattern = new RegExp(POSTMAN_TEMPLATE_PATTERN.source, "g");
  while ((match = pattern.exec(value)) !== null) {
    const key = String(match[1] ?? "").trim();
    if (key) keys.add(key);
  }
  return [...keys];
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key) continue;
    result[key] = stringifyTemplateValue(entry);
  }
  return result;
}

function detectJsonContentType(headers: Record<string, string>): boolean {
  const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
  return contentType.toLowerCase().includes("json");
}

async function executePostmanRequest(
  runSpec: PostmanSerializedRunSpec,
  payload: Record<string, unknown>,
  credentialHeaders?: Record<string, string>,
): Promise<unknown> {
  const variables = {
    ...runSpec.variables,
    ...asStringRecord(payload.variables),
  };

  const interpolatedUrl = interpolatePostmanTemplate(runSpec.url, variables);
  const unresolvedUrlKeys = findUnresolvedPostmanTemplateKeys(interpolatedUrl);
  if (unresolvedUrlKeys.length > 0) {
    throw new Error(`Missing required URL variables: ${unresolvedUrlKeys.join(", ")}`);
  }

  let url: URL;
  try {
    url = new URL(interpolatedUrl);
  } catch {
    throw new Error(`Invalid request URL: ${interpolatedUrl}`);
  }

  for (const entry of runSpec.queryParams) {
    if (!entry.key) continue;
    const value = interpolatePostmanTemplate(entry.value, variables);
    if (value.length > 0) {
      url.searchParams.set(entry.key, value);
    }
  }

  const queryOverrides = asRecord(payload.query);
  for (const [key, value] of Object.entries(queryOverrides)) {
    if (!key || value === undefined || value === null) continue;
    url.searchParams.set(key, stringifyTemplateValue(value));
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(runSpec.headers)) {
    if (!name) continue;
    headers[name] = interpolatePostmanTemplate(value, variables);
  }
  Object.assign(headers, runSpec.authHeaders);
  Object.assign(headers, credentialHeaders ?? {});

  const headerOverrides = asRecord(payload.headers);
  for (const [name, value] of Object.entries(headerOverrides)) {
    if (!name || value === undefined || value === null) continue;
    headers[name] = stringifyTemplateValue(value);
  }

  const method = runSpec.method.toUpperCase();
  const readMethods = new Set(["GET", "HEAD", "OPTIONS"]);
  let body: string | undefined;

  if (!readMethods.has(method)) {
    const hasExplicitBody = Object.prototype.hasOwnProperty.call(payload, "body");
    if (hasExplicitBody) {
      const bodyValue = payload.body;
      if (typeof bodyValue === "string") {
        body = bodyValue;
      } else if (bodyValue !== undefined) {
        body = JSON.stringify(bodyValue);
        if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
          headers["content-type"] = "application/json";
        }
      }
    } else if (runSpec.body?.kind === "urlencoded") {
      const params = new URLSearchParams();
      for (const entry of runSpec.body.entries) {
        if (!entry.key) continue;
        params.set(entry.key, interpolatePostmanTemplate(entry.value, variables));
      }
      body = params.toString();
      if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/x-www-form-urlencoded";
      }
    } else if (runSpec.body?.kind === "raw") {
      body = interpolatePostmanTemplate(runSpec.body.text, variables);
    }
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }

  if (detectJsonContentType(headers) || (response.headers.get("content-type") ?? "").includes("json")) {
    return await response.json();
  }

  return await response.text();
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

function compactOpenApiPaths(
  pathsValue: unknown,
  operationTypeIds: Set<string>,
  componentParameters?: Record<string, unknown>,
  componentSchemas?: Record<string, unknown>,
  componentResponses?: Record<string, unknown>,
  componentRequestBodies?: Record<string, unknown>,
): Record<string, unknown> {
  const paths = asRecord(pathsValue);
  const methods = ["get", "post", "put", "delete", "patch", "head", "options"] as const;
  const compactPaths: Record<string, unknown> = {};
  const compParams = componentParameters ? asRecord(componentParameters) : {};
  const compSchemas = componentSchemas ? asRecord(componentSchemas) : {};
  const compResponses = componentResponses ? asRecord(componentResponses) : {};
  const compRequestBodies = componentRequestBodies ? asRecord(componentRequestBodies) : {};

  const resolveParam = (entry: Record<string, unknown>): Record<string, unknown> => {
    if (typeof entry.$ref === "string") {
      // Resolve "#/components/parameters/foo" → components.parameters.foo
      const ref = entry.$ref;
      const prefix = "#/components/parameters/";
      if (ref.startsWith(prefix)) {
        const key = ref.slice(prefix.length);
        const resolved = asRecord(compParams[key]);
        if (Object.keys(resolved).length > 0) return resolved;
      }
    }
    return entry;
  };

  const normalizeParameters = (entries: unknown): Array<OpenApiParameterHint & { in: string }> => {
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry) => resolveParam(asRecord(entry)))
      .filter((entry) => typeof entry.name === "string" && typeof entry.in === "string")
      .map((entry) => ({
        name: String(entry.name),
        in: String(entry.in),
        required: Boolean(entry.required),
        schema: parameterSchemaFromEntry(entry),
      }));
  };

  for (const [pathTemplate, pathValue] of Object.entries(paths)) {
    const pathObject = asRecord(pathValue);
    const compactPathObject: Record<string, unknown> = {};
    const sharedParameters = normalizeParameters(pathObject.parameters);
    if (sharedParameters.length > 0) {
      compactPathObject.parameters = sharedParameters;
    }

    for (const method of methods) {
      const operation = asRecord(pathObject[method]);
      if (Object.keys(operation).length === 0) continue;

      const operationIdRaw = String(operation.operationId ?? `${method}_${pathTemplate}`);
      const hasGeneratedTypes = operationTypeIds.has(operationIdRaw);

      const compactOperation: Record<string, unknown> = {};
      if (Array.isArray(operation.tags) && operation.tags.length > 0) {
        compactOperation.tags = operation.tags;
      }
      if (operation.operationId !== undefined) {
        compactOperation.operationId = operationIdRaw;
      }
      if (typeof operation.summary === "string") {
        compactOperation.summary = operation.summary;
      }
      if (typeof operation.description === "string") {
        compactOperation.description = operation.description;
      }

      const operationParameters = normalizeParameters(operation.parameters);
      if (operationParameters.length > 0) {
        compactOperation.parameters = operationParameters;
      }

      // Extract request/response schemas for type hints.
      // When .d.ts types exist, pre-compute lightweight hints and skip storing full schemas.
      {
        const requestBody = resolveRequestBodyRef(asRecord(operation.requestBody), compRequestBodies);
        const requestBodyContent = asRecord(requestBody.content);
        const rawRequestBodySchema = getPreferredContentSchema(requestBodyContent);
        const requestBodySchema = resolveSchemaRef(rawRequestBodySchema, compSchemas);

        const responses = asRecord(operation.responses);
        let responseSchema: Record<string, unknown> = {};
        let responseStatus = "";
        for (const [status, responseValue] of Object.entries(responses)) {
          if (!status.startsWith("2")) continue;
          responseStatus = status;
          const resolvedResponse = resolveResponseRef(asRecord(responseValue), compResponses);
          responseSchema = resolveSchemaRef(
            getPreferredResponseSchema(resolvedResponse),
            compSchemas,
          );
          if (Object.keys(responseSchema).length > 0) break;
        }

        if (hasGeneratedTypes) {
          // Pre-compute lightweight type hint strings (the full schemas are in the .d.ts)
          const mergedParameters = normalizeParameters(operation.parameters).concat(sharedParameters);
          const hasInputSchema =
            mergedParameters.length > 0 || Object.keys(requestBodySchema).length > 0;
          const combinedSchema = buildOpenApiInputSchema(mergedParameters, requestBodySchema);
          compactOperation._argsTypeHint = hasInputSchema
            ? jsonSchemaTypeHintFallback(combinedSchema, 0, compSchemas)
            : "{}";
          compactOperation._returnsTypeHint = responseTypeHintFromSchema(responseSchema, responseStatus, compSchemas);
          const previewKeys = buildOpenApiArgPreviewKeys(mergedParameters, requestBodySchema, compSchemas);
          if (previewKeys.length > 0) {
            compactOperation._argPreviewKeys = [...new Set(previewKeys)];
          }
        } else {
          // Keep full schemas for the fallback path
          if (Object.keys(requestBodySchema).length > 0) {
            compactOperation.requestBody = {
              content: {
                "application/json": {
                  schema: requestBodySchema,
                },
              },
            };
          }

          if (responseStatus) {
            compactOperation.responses = {
              [responseStatus]: Object.keys(responseSchema).length > 0
                ? {
                    content: {
                      "application/json": {
                        schema: responseSchema,
                      },
                    },
                  }
                : {},
            };
          }
        }
      }

      compactPathObject[method] = compactOperation;
    }

    if (Object.keys(compactPathObject).length > 0) {
      compactPaths[pathTemplate] = compactPathObject;
    }
  }

  return compactPaths;
}

export interface PreparedOpenApiSpec {
  servers: string[];
  paths: Record<string, unknown>;
  /** Raw .d.ts from openapiTS — cached as-is, extracted lazily on read */
  dts?: string;
  /** Auth inferred from OpenAPI security schemes when explicit source auth is not configured. */
  inferredAuth?: OpenApiAuth;
  warnings: string[];
}

function inferOpenApiAuth(spec: Record<string, unknown>): OpenApiAuth | undefined {
  const components = asRecord(spec.components);
  const securitySchemes = asRecord(components.securitySchemes);
  if (Object.keys(securitySchemes).length === 0) {
    return undefined;
  }

  const security = Array.isArray(spec.security)
    ? spec.security.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    : [];

  const referencedSchemeName = security
    .flatMap((entry) => Object.keys(entry))
    .find((name) => typeof securitySchemes[name] === "object");

  const schemeName = referencedSchemeName ?? Object.keys(securitySchemes)[0];
  if (!schemeName) return undefined;

  const scheme = asRecord(securitySchemes[schemeName]);
  const type = String(scheme.type ?? "").toLowerCase();

  if (type === "http") {
    const httpScheme = String(scheme.scheme ?? "").toLowerCase();
    if (httpScheme === "bearer") {
      return { type: "bearer", mode: "workspace" };
    }
    if (httpScheme === "basic") {
      return { type: "basic", mode: "workspace" };
    }
    return undefined;
  }

  if (type === "apikey") {
    const location = String(scheme.in ?? "").toLowerCase();
    const header = typeof scheme.name === "string" ? scheme.name.trim() : "";
    if (location === "header" && header.length > 0) {
      return { type: "apiKey", mode: "workspace", header };
    }
    return undefined;
  }

  if (type === "oauth2" || type === "openidconnect") {
    return { type: "bearer", mode: "workspace" };
  }

  return undefined;
}

export async function prepareOpenApiSpec(
  spec: string | Record<string, unknown>,
  sourceName = "openapi",
): Promise<PreparedOpenApiSpec> {
  const parser = SwaggerParser as unknown as {
    bundle(spec: unknown): Promise<unknown>;
    parse(spec: unknown): Promise<unknown>;
  };

  const warnings: string[] = [];

  // ── Step 1: Single fetch ──────────────────────────────────────────────
  // If `spec` is a URL string, parse it once to get a JS object.
  // Both openapiTS and SwaggerParser.bundle then work from this object
  // instead of each independently fetching the same multi-MB URL.
  let parsed: Record<string, unknown>;
  if (typeof spec === "string") {
    try {
      parsed = (await parser.parse(spec)) as Record<string, unknown>;
    } catch (parseError) {
      const msg = parseError instanceof Error ? parseError.message : String(parseError);
      throw new Error(`Failed to fetch/parse OpenAPI source '${sourceName}': ${msg}`);
    }
  } else {
    parsed = spec;
  }

  // ── Step 2: Generate .d.ts and bundle in parallel ─────────────────────
  // Both now operate on the in-memory object — no additional HTTP fetches.
  let dts: string | null;
  let bundled: Record<string, unknown>;
  const dtsPromise = generateOpenApiDts(parsed);
  try {
    bundled = (await parser.bundle(parsed)) as Record<string, unknown>;
  } catch (bundleError) {
    const bundleMessage = bundleError instanceof Error ? bundleError.message : String(bundleError);
    warnings.push(`OpenAPI bundle failed for '${sourceName}', using parse-only mode: ${bundleMessage}`);
    bundled = parsed;
  }
  dts = await dtsPromise;

  // ── Step 3: Extract operation IDs for compaction ───────────────────────
  // If we have a .d.ts, we know which operations have full generated types.
  // compactOpenApiPaths uses this to strip request/response schemas from
  // operations that don't need the fallback hint generator.
  const operationTypeIds = dts ? extractOperationIdsFromDts(dts) : new Set<string>();

  const servers = Array.isArray(bundled.servers) ? (bundled.servers as Array<{ url?: unknown }>) : [];
  const inferredAuth = inferOpenApiAuth(bundled);

  return {
    servers: servers
      .map((server) => (typeof server.url === "string" ? server.url : ""))
      .filter((url) => url.length > 0),
    paths: compactOpenApiPaths(
      bundled.paths,
      operationTypeIds,
      asRecord(asRecord(bundled.components).parameters),
      asRecord(asRecord(bundled.components).schemas),
      asRecord(asRecord(bundled.components).responses),
      asRecord(asRecord(bundled.components).requestBodies),
    ),
    dts: dts ?? undefined,
    ...(inferredAuth ? { inferredAuth } : {}),
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

  const effectiveAuth = config.auth ?? prepared.inferredAuth;
  const authHeaders = buildStaticAuthHeaders(effectiveAuth);
  const sourceLabel = `openapi:${config.name}`;
  const credentialSourceKey = getCredentialSourceKey(config);
  const credentialSpec = buildCredentialSpec(credentialSourceKey, effectiveAuth);
  const paths = asRecord(prepared.paths);
  const tools: ToolDefinition[] = [];

  // The raw .d.ts is attached to the first tool only (one per source to avoid duplication).
  // The typechecker/Monaco use this directly via indexed access types.
  const sourceDts = prepared.dts
    ? prepared.dts.replace(/^export /gm, "")  // strip 'export' so types are ambient
    : undefined;
  let sourceDtsEmitted = false;

  const methods = ["get", "post", "put", "delete", "patch", "head", "options"] as const;
  const readMethods = new Set(["get", "head", "options"]);
  const usedToolPaths = new Set<string>();

  for (const [pathTemplate, pathValue] of Object.entries(paths)) {
    const pathObject = asRecord(pathValue);
    const sharedParameters = Array.isArray(pathObject.parameters)
      ? (pathObject.parameters as Array<Record<string, unknown>>)
      : [];

    for (const method of methods) {
      const operation = asRecord(pathObject[method]);
      if (Object.keys(operation).length === 0) continue;

      const tags = Array.isArray(operation.tags) ? (operation.tags as unknown[]) : [];
      const tagRaw = String(tags[0] ?? "default");
      const operationIdRaw = String(operation.operationId ?? `${method}_${pathTemplate}`);
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

      // Lightweight type hints for LLM prompt / discover tool.
      // Pre-computed during compaction when .d.ts types exist (schemas stripped to save space).
      let argsType: string;
      let returnsType: string;
      let argPreviewKeys: string[] = Array.isArray(operation._argPreviewKeys)
        ? operation._argPreviewKeys.filter((value): value is string => typeof value === "string")
        : [];
      if (typeof operation._argsTypeHint === "string" && typeof operation._returnsTypeHint === "string") {
        argsType = operation._argsTypeHint as string;
        returnsType = operation._returnsTypeHint as string;
      } else {
        const requestBody = asRecord(operation.requestBody);
        const requestBodyContent = asRecord(requestBody.content);
        const requestBodySchema = getPreferredContentSchema(requestBodyContent);

        const responses = asRecord(operation.responses);
        let responseSchema: Record<string, unknown> = {};
        let responseStatus = "";
        for (const [status, responseValue] of Object.entries(responses)) {
          if (!status.startsWith("2")) continue;
          responseSchema = getPreferredResponseSchema(asRecord(responseValue));
          responseStatus = status;
          if (Object.keys(responseSchema).length > 0) break;
        }

        const hasInputSchema = parameters.length > 0 || Object.keys(requestBodySchema).length > 0;
        const combinedSchema = buildOpenApiInputSchema(parameters, requestBodySchema);

        argsType = hasInputSchema ? jsonSchemaTypeHintFallback(combinedSchema) : "{}";
        returnsType = responseTypeHintFromSchema(responseSchema, responseStatus);
        if (argPreviewKeys.length === 0) {
          argPreviewKeys = buildOpenApiArgPreviewKeys(parameters, requestBodySchema);
        }
      }

      const displayArgsType = argPreviewKeys.length > 0
        ? compactArgKeysHint(argPreviewKeys)
        : compactArgTypeHint(argsType);
      const displayReturnsType = compactReturnTypeHint(returnsType);

      const approval = config.overrides?.[operationIdRaw]?.approval
        ?? (readMethods.has(method)
          ? config.defaultReadApproval ?? "auto"
          : config.defaultWriteApproval ?? "required");

      const runSpec: SerializedTool["runSpec"] = {
        kind: "openapi",
        baseUrl,
        method,
        pathTemplate,
        parameters,
        authHeaders,
      };

      const tool: ToolDefinition & { _runSpec: SerializedTool["runSpec"] } = {
        path: buildOpenApiToolPath(config.name, tagRaw, operationIdRaw, usedToolPaths),
        source: sourceLabel,
        approval,
        description: String(operation.summary ?? operation.description ?? `${method.toUpperCase()} ${pathTemplate}`),
        metadata: {
          argsType,
          returnsType,
          displayArgsType,
          displayReturnsType,
          ...(argPreviewKeys.length > 0 ? { argPreviewKeys } : {}),
          operationId: operationIdRaw,
          // Only attach sourceDts to the first tool to avoid duplicating the full .d.ts
          ...(sourceDts && !sourceDtsEmitted ? { sourceDts } : {}),
        },
        credential: credentialSpec,
        _runSpec: runSpec,
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
      };
      tools.push(tool);

      if (sourceDts && !sourceDtsEmitted) {
        sourceDtsEmitted = true;
      }
    }
  }

  return tools;
}

function buildPostmanToolPath(
  sourceName: string,
  requestName: string,
  folderPath: string[],
  usedPaths: Set<string>,
): string {
  const source = sanitizeSegment(sourceName);
  const segments = [
    source,
    ...folderPath.map((segment) => sanitizeSegment(segment)).filter((segment) => segment.length > 0),
    sanitizeSnakeSegment(requestName),
  ];
  const basePath = segments.join(".");

  let path = basePath;
  let suffix = 2;
  while (usedPaths.has(path)) {
    path = `${basePath}_${suffix}`;
    suffix += 1;
  }
  usedPaths.add(path);
  return path;
}

function resolvePostmanFolderPath(
  folderId: string | undefined,
  folderById: Map<string, { name: string; parentId?: string }>,
): string[] {
  const path: string[] = [];
  let cursor = folderId;
  let safety = 0;
  while (cursor && safety < 100) {
    safety += 1;
    const folder = folderById.get(cursor);
    if (!folder) break;
    path.unshift(folder.name);
    cursor = folder.parentId;
  }
  return path;
}

function extractPostmanVariableMap(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (!key) continue;
    if (record.disabled === true) continue;
    result[key] = stringifyTemplateValue(record.value);
  }
  return result;
}

function extractPostmanHeaderMap(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (!key || record.disabled === true) continue;
    result[key] = stringifyTemplateValue(record.value);
  }
  return result;
}

function extractPostmanQueryEntries(value: unknown): Array<{ key: string; value: string }> {
  if (!Array.isArray(value)) return [];
  const entries: Array<{ key: string; value: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (!key || record.disabled === true) continue;
    entries.push({ key, value: stringifyTemplateValue(record.value) });
  }
  return entries;
}

function extractPostmanBody(record: Record<string, unknown>): PostmanSerializedRunSpec["body"] {
  const dataMode = typeof record.dataMode === "string" ? record.dataMode.toLowerCase() : "";
  if (dataMode === "urlencoded" && Array.isArray(record.data)) {
    const entries: Array<{ key: string; value: string }> = [];
    for (const item of record.data) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const key = typeof entry.key === "string" ? entry.key.trim() : "";
      if (!key || entry.disabled === true) continue;
      entries.push({ key, value: stringifyTemplateValue(entry.value) });
    }
    return entries.length > 0 ? { kind: "urlencoded", entries } : undefined;
  }

  if (typeof record.rawModeData === "string" && record.rawModeData.length > 0) {
    return { kind: "raw", text: record.rawModeData };
  }

  return undefined;
}

async function loadPostmanCollectionTools(
  config: OpenApiToolSourceConfig,
  collectionUid: string,
): Promise<ToolDefinition[]> {
  const proxyUrl = config.postmanProxyUrl ?? DEFAULT_POSTMAN_PROXY_URL;
  const payload = {
    service: "sync",
    method: "GET",
    path: `/collection/${collectionUid}?populate=true`,
  };

  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to fetch API collection ${collectionUid}: HTTP ${response.status} ${text.slice(0, 300)}`);
  }

  const raw = await response.json() as Record<string, unknown>;
  const collection = asRecord(raw.data);
  const requests = Array.isArray(collection.requests)
    ? collection.requests.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    : [];

  const folders = Array.isArray(collection.folders)
    ? collection.folders.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    : [];

  const folderById = new Map<string, { name: string; parentId?: string }>();
  for (const folder of folders) {
    const id = typeof folder.id === "string" ? folder.id : "";
    if (!id) continue;
    const name = typeof folder.name === "string" && folder.name.trim().length > 0 ? folder.name : "folder";
    const parentId = typeof folder.folder === "string" ? folder.folder : undefined;
    folderById.set(id, { name, parentId });
  }

  const sourceLabel = `catalog:${config.name}`;
  const authHeaders = buildStaticAuthHeaders(config.auth);
  const credentialSourceKey = getCredentialSourceKey(config);
  const credentialSpec = buildCredentialSpec(credentialSourceKey, config.auth);
  const readMethods = new Set(["get", "head", "options"]);
  const usedPaths = new Set<string>();
  const collectionVariables = extractPostmanVariableMap(collection.variables);
  const argsType = "{ variables?: Record<string, string | number | boolean>; query?: Record<string, string | number | boolean>; headers?: Record<string, string>; body?: unknown }";
  const returnsType = "unknown";

  const tools: ToolDefinition[] = [];

  for (const request of requests) {
    const methodRaw = typeof request.method === "string" ? request.method.toLowerCase() : "get";
    const method = methodRaw.length > 0 ? methodRaw : "get";
    const url = typeof request.url === "string" ? request.url : "";
    if (!url) continue;

    const requestId = typeof request.id === "string" ? request.id : "";
    const requestName = typeof request.name === "string" && request.name.trim().length > 0
      ? request.name.trim()
      : requestId || `${method.toUpperCase()} request`;
    const folderId = typeof request.folder === "string" ? request.folder : undefined;
    const folderPath = resolvePostmanFolderPath(folderId, folderById);
    const requestVariables = {
      ...collectionVariables,
      ...extractPostmanVariableMap(request.pathVariableData),
    };

    const runSpec: PostmanSerializedRunSpec = {
      kind: "postman",
      method,
      url,
      headers: extractPostmanHeaderMap(request.headerData),
      queryParams: extractPostmanQueryEntries(request.queryParams),
      body: extractPostmanBody(request),
      variables: requestVariables,
      authHeaders,
    };

    const approval = config.overrides?.[requestId]?.approval
      ?? config.overrides?.[requestName]?.approval
      ?? (readMethods.has(method)
        ? config.defaultReadApproval ?? "auto"
        : config.defaultWriteApproval ?? "required");

    const tool: ToolDefinition & { _runSpec: SerializedTool["runSpec"] } = {
      path: buildPostmanToolPath(config.name, requestName, folderPath, usedPaths),
      source: sourceLabel,
      approval,
      description: typeof request.description === "string" && request.description.trim().length > 0
        ? request.description
        : `${method.toUpperCase()} ${url}`,
      metadata: {
        argsType,
        returnsType,
        displayArgsType: compactArgTypeHint(argsType),
        displayReturnsType: compactReturnTypeHint(returnsType),
        argPreviewKeys: ["variables", "query", "headers", "body"],
        operationId: requestId || requestName,
      },
      credential: credentialSpec,
      _runSpec: runSpec,
      run: async (input: unknown, context) => {
        const payloadRecord = asRecord(input);
        return await executePostmanRequest(runSpec, payloadRecord, context.credential?.headers);
      },
    };

    tools.push(tool);
  }

  return tools;
}

async function loadOpenApiTools(config: OpenApiToolSourceConfig): Promise<ToolDefinition[]> {
  if (typeof config.spec === "string") {
    const collectionUid = parsePostmanCollectionUid(config.spec);
    if (collectionUid) {
      return await loadPostmanCollectionTools(config, collectionUid);
    }
  }

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

interface GraphqlExecutionEnvelope {
  data: unknown;
  errors: unknown[];
}

function hasGraphqlData(data: unknown): boolean {
  if (data === null || data === undefined) return false;
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data === "object") return Object.keys(data as Record<string, unknown>).length > 0;
  return true;
}

function normalizeGraphqlEnvelope(result: { data?: unknown; errors?: unknown[] }): GraphqlExecutionEnvelope {
  return {
    data: result.data ?? null,
    errors: Array.isArray(result.errors) ? result.errors : [],
  };
}

function selectGraphqlFieldEnvelope(
  envelope: GraphqlExecutionEnvelope,
  operationName: string,
): GraphqlExecutionEnvelope {
  const data = envelope.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, operationName)) {
      return {
        data: record[operationName],
        errors: envelope.errors,
      };
    }
  }

  return envelope;
}

function normalizeGraphqlFieldVariables(
  argNames: string[],
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const variablePayload: Record<string, unknown> = { ...payload };
  delete variablePayload.query;
  delete variablePayload.variables;

  if (Object.keys(variablePayload).length === 0) {
    return undefined;
  }

  if (argNames.length === 1) {
    const argName = argNames[0]!;
    if (Object.prototype.hasOwnProperty.call(variablePayload, argName)) {
      const value = variablePayload[argName];
      if (
        Object.keys(variablePayload).length === 1
        && value
        && typeof value === "object"
        && !Array.isArray(value)
      ) {
        const nested = value as Record<string, unknown>;
        if (Object.keys(nested).length === 1 && Object.prototype.hasOwnProperty.call(nested, argName)) {
          return { [argName]: nested[argName] };
        }
      }
      return variablePayload;
    }

    // Common LLM shape: pass fields directly for single `input` argument.
    return { [argName]: variablePayload };
  }

  return variablePayload;
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

function isGraphqlLeafType(ref: GqlTypeRef, typeMap: Map<string, GqlType>): boolean {
  const name = unwrapType(ref);
  if (!name) return true;
  const resolved = typeMap.get(name);
  if (!resolved) return true;
  return resolved.kind === "SCALAR" || resolved.kind === "ENUM";
}

function buildFieldSelectionSet(
  typeRef: GqlTypeRef,
  typeMap: Map<string, GqlType>,
  depth = 0,
  seenTypes = new Set<string>(),
): string {
  const namedType = unwrapType(typeRef);
  if (!namedType) return "";

  const resolved = typeMap.get(namedType);
  if (!resolved) return "";

  if (resolved.kind === "SCALAR" || resolved.kind === "ENUM") {
    return "";
  }

  if (resolved.kind === "UNION") {
    return "{ __typename }";
  }

  if (depth >= 2 || seenTypes.has(namedType)) {
    return "{ __typename }";
  }

  const nextSeen = new Set(seenTypes);
  nextSeen.add(namedType);

  if ((resolved.kind === "OBJECT" || resolved.kind === "INTERFACE") && resolved.fields) {
    const preferredLeafNames = ["id", "identifier", "key", "name", "title", "number", "url", "success"];
    const preferredNestedNames = ["nodes", "edges", "node", "items", "issue", "issues", "team", "teams", "viewer", "user"];

    const fields = resolved.fields.filter((field) => !field.name.startsWith("__"));
    const leafFields = resolved.fields
      .filter((field) => !field.name.startsWith("__"))
      .filter((field) => isGraphqlLeafType(field.type, typeMap));
    const nestedFields = fields.filter((field) => !isGraphqlLeafType(field.type, typeMap));

    const selectedParts: string[] = [];
    const selectedNames = new Set<string>();

    for (const preferred of preferredLeafNames) {
      const match = leafFields.find((field) => field.name === preferred);
      if (!match || selectedNames.has(match.name)) continue;
      selectedNames.add(match.name);
      selectedParts.push(match.name);
      if (selectedParts.length >= 2) break;
    }

    if (selectedParts.length < 2) {
      for (const field of leafFields) {
        if (selectedNames.has(field.name)) continue;
        selectedNames.add(field.name);
        selectedParts.push(field.name);
        if (selectedParts.length >= 2) break;
      }
    }

    const nestedCandidates = [
      ...preferredNestedNames
        .map((name) => nestedFields.find((field) => field.name === name))
        .filter((field): field is GqlField => Boolean(field)),
      ...nestedFields,
    ];

    if (selectedParts.length < 3) {
      for (const field of nestedCandidates) {
        if (selectedNames.has(field.name)) continue;
        const nestedSelection = buildFieldSelectionSet(field.type, typeMap, depth + 1, nextSeen);
        if (!nestedSelection) continue;
        selectedNames.add(field.name);
        selectedParts.push(`${field.name} ${nestedSelection}`);
        break;
      }
    }

    if (selectedParts.length === 0) {
      return "{ __typename }";
    }

    if (!selectedParts.includes("__typename")) {
      selectedParts.push("__typename");
    }

    return `{ ${selectedParts.join(" ")} }`;
  }

  return "{ __typename }";
}

/** Build a minimal GraphQL document for a single root field with its arguments */
function buildFieldQuery(
  operationType: "query" | "mutation",
  fieldName: string,
  args: GqlField["args"],
  fieldType?: GqlTypeRef,
  typeMap?: Map<string, GqlType>,
): string {
  const selectionSet = fieldType && typeMap
    ? buildFieldSelectionSet(fieldType, typeMap)
    : "";
  const selectionSuffix = selectionSet ? ` ${selectionSet}` : "";

  if (args.length === 0) {
    return `${operationType} { ${fieldName}${selectionSuffix} }`;
  }
  const varDefs = args.map((a) => `$${a.name}: ${printGqlType(a.type)}`).join(", ");
  const fieldArgs = args.map((a) => `${a.name}: $${a.name}`).join(", ");
  return `${operationType}(${varDefs}) { ${fieldName}(${fieldArgs})${selectionSuffix} }`;
}

function printGqlType(ref: GqlTypeRef): string {
  if (ref.kind === "NON_NULL" && ref.ofType) return `${printGqlType(ref.ofType)}!`;
  if (ref.kind === "LIST" && ref.ofType) return `[${printGqlType(ref.ofType)}]`;
  return ref.name ?? "String";
}

/**
 * Parse a GraphQL query string to extract the operation type and root field names.
 * Uses GraphQL AST parsing so aliases/fragments are handled correctly for policy routing.
 */
export function parseGraphqlOperationPaths(
  sourceName: string,
  queryString: string,
): { operationType: "query" | "mutation" | "subscription"; fieldPaths: string[] } {
  const trimmed = queryString.trim();
  if (!trimmed) {
    return { operationType: "query", fieldPaths: [] };
  }

  let operationType: "query" | "mutation" | "subscription" = "query";

  try {
    const document = parse(trimmed, { noLocation: true });
    const firstOperation = document.definitions.find((definition) => definition.kind === Kind.OPERATION_DEFINITION);
    if (!firstOperation || firstOperation.kind !== Kind.OPERATION_DEFINITION) {
      return { operationType, fieldPaths: [] };
    }

    operationType = firstOperation.operation;

    const fragmentByName = new Map<string, FragmentDefinitionNode>(
      document.definitions
        .filter((definition) => definition.kind === Kind.FRAGMENT_DEFINITION)
        .map((definition) => [definition.name.value, definition]),
    );

    const fieldNames = new Set<string>();

    const collectSelectionSet = (
      selectionSet: SelectionSetNode,
      visitedFragments: Set<string>,
    ) => {
      for (const selection of selectionSet.selections) {
        if (selection.kind === Kind.FIELD) {
          const fieldName = selection.name.value;
          if (!fieldName.startsWith("__")) {
            fieldNames.add(fieldName);
          }
          continue;
        }

        if (selection.kind === Kind.INLINE_FRAGMENT) {
          collectSelectionSet(selection.selectionSet, visitedFragments);
          continue;
        }

        if (selection.kind === Kind.FRAGMENT_SPREAD) {
          const fragmentName = selection.name.value;
          if (visitedFragments.has(fragmentName)) continue;
          const fragment = fragmentByName.get(fragmentName);
          if (!fragment) continue;

          const nextVisited = new Set(visitedFragments);
          nextVisited.add(fragmentName);
          collectSelectionSet(fragment.selectionSet, nextVisited);
        }
      }
    };

    collectSelectionSet(firstOperation.selectionSet, new Set());

    return {
      operationType,
      fieldPaths: [...fieldNames]
        .map((fieldName) => `${sanitizeSegment(sourceName)}.${operationType}.${sanitizeSegment(fieldName)}`),
    };
  } catch {
    return { operationType, fieldPaths: [] };
  }
}

async function loadGraphqlTools(config: GraphqlToolSourceConfig): Promise<ToolDefinition[]> {
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
    metadata: {
      argsType: "{ query: string; variables?: Record<string, unknown> }",
      returnsType: "{ data: unknown; errors: unknown[] }",
      displayArgsType: "{ query: string; variables?: ... }",
      displayReturnsType: "{ data: ...; errors: unknown[] }",
      argPreviewKeys: ["query", "variables"],
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
      if (result.errors && !hasGraphqlData(result.data)) {
        throw new Error(`GraphQL errors: ${JSON.stringify(result.errors).slice(0, 1000)}`);
      }
      return normalizeGraphqlEnvelope(result);
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
      const argsType = gqlFieldArgsTypeHint(field.args, typeMap);
      const returnsType = `{ data: ${gqlTypeToHint(field.type, typeMap)}; errors: unknown[] }`;
      const argPreviewKeys = field.args.map((arg) => arg.name).filter((name) => name.length > 0);

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
        metadata: {
          argsType,
          returnsType,
          displayArgsType: compactArgTypeHint(argsType),
          displayReturnsType: "{ data: ...; errors: unknown[] }",
          ...(argPreviewKeys.length > 0 ? { argPreviewKeys } : {}),
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
          if (!mainTool) throw new Error(`Main GraphQL tool not found`);
          const envelope = await mainTool.run(payload, context) as GraphqlExecutionEnvelope;
          return selectGraphqlFieldEnvelope(envelope, field.name);
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

export interface CompiledToolSourceArtifact {
  version: "v1";
  sourceType: ExternalToolSourceConfig["type"];
  sourceName: string;
  tools: SerializedTool[];
}

async function loadSourceToolDefinitions(source: ExternalToolSourceConfig): Promise<ToolDefinition[]> {
  if (source.type === "mcp") {
    return await loadMcpTools(source);
  }
  if (source.type === "openapi") {
    return await loadOpenApiTools(source);
  }
  if (source.type === "graphql") {
    return await loadGraphqlTools(source);
  }
  return [];
}

export async function compileExternalToolSource(source: ExternalToolSourceConfig): Promise<CompiledToolSourceArtifact> {
  const tools = await loadSourceToolDefinitions(source);
  return {
    version: "v1",
    sourceType: source.type,
    sourceName: source.name,
    tools: serializeTools(tools),
  };
}

export function compileOpenApiToolSourceFromPrepared(
  source: OpenApiToolSourceConfig,
  prepared: PreparedOpenApiSpec,
): CompiledToolSourceArtifact {
  const tools = buildOpenApiToolsFromPrepared(source, prepared);
  return {
    version: "v1",
    sourceType: source.type,
    sourceName: source.name,
    tools: serializeTools(tools),
  };
}

export function materializeCompiledToolSource(artifact: CompiledToolSourceArtifact): ToolDefinition[] {
  return rehydrateTools(artifact.tools, new Map());
}

export async function loadExternalTools(sources: ExternalToolSourceConfig[]): Promise<{ tools: ToolDefinition[]; warnings: string[] }> {
  const results = await Promise.allSettled(sources.map((source) => compileExternalToolSource(source)));

  const artifacts: CompiledToolSourceArtifact[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === "fulfilled") {
      artifacts.push(result.value);
    } else {
      const source = sources[i]!;
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      warnings.push(`Failed to load ${source.type} source '${source.name}': ${message}`);
      console.warn(`[executor] failed to load tool source ${source.type}:${source.name}: ${message}`);
    }
  }

  const tools = artifacts.flatMap((artifact) => materializeCompiledToolSource(artifact));
  return { tools, warnings };
}

// ── Workspace tool cache serialization ──────────────────────────────────────
//
// Serializes ToolDefinition[] (minus `run` closures) into a JSON-safe format.
// On deserialization, `run` functions are reconstructed from stored metadata.

/** JSON-safe representation of a ToolDefinition stored in the workspace cache. */
export interface SerializedTool {
  path: string;
  description: string;
  approval: ToolApprovalMode;
  source?: string;
  metadata?: ToolTypeMetadata;
  credential?: ToolCredentialSpec;
  _graphqlSource?: string;
  _pseudoTool?: boolean;
  /**
   * Data needed to reconstruct `run()`. Shape depends on source type.
   * OpenAPI: { kind: "openapi", baseUrl, method, pathTemplate, parameters, authHeaders }
   * MCP: { kind: "mcp", url, transport?, queryParams?, toolName }
   * Postman: { kind: "postman", method, url, headers, queryParams, body?, variables, authHeaders }
   * GraphQL raw: { kind: "graphql_raw", endpoint, authHeaders }
   * GraphQL field: { kind: "graphql_field", endpoint, operationName, operationType, queryTemplate, argNames?, authHeaders }
   * Builtin: { kind: "builtin" } — run comes from DEFAULT_TOOLS
   */
  runSpec:
    | {
        kind: "openapi";
        baseUrl: string;
        method: string;
        pathTemplate: string;
        parameters: Array<{ name: string; in: string; required: boolean; schema: Record<string, unknown> }>;
        authHeaders: Record<string, string>;
      }
    | {
        kind: "mcp";
        url: string;
        transport?: "sse" | "streamable-http";
        queryParams?: Record<string, string>;
        toolName: string;
      }
    | PostmanSerializedRunSpec
    | {
        kind: "graphql_raw";
        endpoint: string;
        authHeaders: Record<string, string>;
      }
    | {
        kind: "graphql_field";
        endpoint: string;
        operationName: string;
        operationType: "query" | "mutation";
        queryTemplate: string;
        argNames?: string[];
        authHeaders: Record<string, string>;
      }
    | { kind: "builtin" };
}

export interface WorkspaceToolSnapshot {
  version: "v2";
  externalArtifacts: CompiledToolSourceArtifact[];
  warnings: string[];
}

export function materializeWorkspaceSnapshot(
  snapshot: WorkspaceToolSnapshot,
): ToolDefinition[] {
  return snapshot.externalArtifacts.flatMap((artifact) => materializeCompiledToolSource(artifact));
}

/** Serialize tools for cache storage. Strips `run` closures, stores reconstruction data. */
export function serializeTools(tools: ToolDefinition[]): SerializedTool[] {
  return tools.map((tool) => ({
    path: tool.path,
    description: tool.description,
    approval: tool.approval,
    source: tool.source,
    metadata: tool.metadata,
    credential: tool.credential,
    _graphqlSource: tool._graphqlSource,
    _pseudoTool: tool._pseudoTool,
    // runSpec is attached during tool building — see below.
    // Tools without a runSpec (builtins, discover) get { kind: "builtin" }.
    runSpec: (tool as any)._runSpec ?? { kind: "builtin" as const },
  }));
}

/**
 * Reconstruct live ToolDefinition[] from a cached snapshot.
 *
 * OpenAPI `run` functions are rebuilt from stored parameters (pure data → fetch).
 * MCP `run` functions establish a lazy connection on first call.
 * GraphQL `run` functions rebuild the query executor.
 * Builtins are looked up from the provided base tools map.
 */
export function rehydrateTools(
  serialized: SerializedTool[],
  baseTools: Map<string, ToolDefinition>,
): ToolDefinition[] {
  // Shared MCP connections — lazily created per URL on first tool call
  const mcpConnections = new Map<
    string,
    { promise: Promise<{ client: any; close: () => Promise<void> }> }
  >();

  const readMethods = new Set(["get", "head", "options"]);

  async function executeGraphql(
    endpoint: string,
    authHeaders: Record<string, string>,
    query: string,
    variables: unknown,
    context: { credential?: { headers: Record<string, string> } },
  ): Promise<GraphqlExecutionEnvelope> {
    const response = await fetch(endpoint, {
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
      throw new Error(`GraphQL HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    const result = await response.json() as { data?: unknown; errors?: unknown[] };
    if (result.errors && !hasGraphqlData(result.data)) {
      throw new Error(`GraphQL errors: ${JSON.stringify(result.errors).slice(0, 1000)}`);
    }
    return normalizeGraphqlEnvelope(result);
  }

  return serialized.map((st) => {
    const base: Omit<ToolDefinition, "run"> = {
      path: st.path,
      description: st.description,
      approval: st.approval,
      source: st.source,
      metadata: st.metadata,
      credential: st.credential,
      _graphqlSource: st._graphqlSource,
      _pseudoTool: st._pseudoTool,
    };

    if (st.runSpec.kind === "builtin") {
      const builtin = baseTools.get(st.path);
      if (builtin) return builtin;
      // Fallback — shouldn't happen but be safe
      return { ...base, run: async () => { throw new Error(`Builtin tool '${st.path}' not found`); } };
    }

    if (st.runSpec.kind === "openapi") {
      const { baseUrl, method, pathTemplate, parameters, authHeaders } = st.runSpec;
      return {
        ...base,
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
      };
    }

    if (st.runSpec.kind === "postman") {
      const runSpec = st.runSpec;
      return {
        ...base,
        run: async (input: unknown, context) => {
          const payload = asRecord(input);
          return await executePostmanRequest(runSpec, payload, context.credential?.headers);
        },
      };
    }

    if (st.runSpec.kind === "mcp") {
      const { url, transport, queryParams, toolName } = st.runSpec;
      return {
        ...base,
        run: async (input: unknown) => {
          // Lazy connection — shared across all MCP tools from same URL
          const connKey = `${url}|${transport ?? ""}`;
          if (!mcpConnections.has(connKey)) {
            mcpConnections.set(connKey, {
              promise: connectMcp(url, queryParams, transport),
            });
          }
          let conn = await mcpConnections.get(connKey)!.promise;

          const payload = asRecord(input);
          try {
            const result = await conn.client.callTool({ name: toolName, arguments: payload });
            return extractMcpResult(result);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/(socket|closed|ECONNRESET|fetch failed)/i.test(message)) {
              throw error;
            }
            // Reconnect
            try { await conn.close(); } catch { /* ignore */ }
            const newConn = connectMcp(url, queryParams, transport);
            mcpConnections.set(connKey, { promise: newConn });
            conn = await newConn;
            const result = await conn.client.callTool({ name: toolName, arguments: payload });
            return extractMcpResult(result);
          }
        },
      };
    }

    if (st.runSpec.kind === "graphql_raw") {
      const { endpoint, authHeaders } = st.runSpec;
      return {
        ...base,
        run: async (input: unknown, context) => {
          const payload = asRecord(input);
          const query = typeof payload.query === "string" ? payload.query : "";
          if (!query.trim()) {
            throw new Error("GraphQL query string is required");
          }
          const variables = payload.variables;
          return await executeGraphql(endpoint, authHeaders, query, variables, context);
        },
      };
    }

    if (st.runSpec.kind === "graphql_field") {
      const { endpoint, operationName, queryTemplate, authHeaders, argNames } = st.runSpec;
      return {
        ...base,
        run: async (input: unknown, context) => {
          const payload = asRecord(input);
          const hasExplicitQuery = typeof payload.query === "string" && payload.query.trim().length > 0;
          const query = hasExplicitQuery ? String(payload.query) : queryTemplate;

          let variables = payload.variables;
          if (variables === undefined && !hasExplicitQuery) {
            variables = normalizeGraphqlFieldVariables(argNames ?? [], payload);
          }

          const envelope = await executeGraphql(endpoint, authHeaders, query, variables, context);
          return selectGraphqlFieldEnvelope(envelope, operationName);
        },
      };
    }

    return { ...base, run: async () => { throw new Error(`Unknown run spec kind for '${st.path}'`); } };
  });
}

/** Extract text content from MCP tool call result */
function extractMcpResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;
  const texts = content
    .map((item) => (item && typeof item === "object" ? (item as { text?: unknown }).text : undefined))
    .filter((item): item is string => typeof item === "string");
  if (texts.length === 0) return content;
  if (texts.length === 1) return texts[0];
  return texts;
}
