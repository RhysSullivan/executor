"use node";

import SwaggerParser from "@apidevtools/swagger-parser";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import openapiTS, { astToString } from "openapi-typescript";
import type { ToolApprovalMode, ToolCredentialSpec, ToolDefinition, ToolTypeMetadata } from "./types";
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
  const cleanedBase = value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  const cleaned = cleanedBase.length > 0 ? cleanedBase : "default";
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
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

function responseTypeHintFromSchema(responseSchema: Record<string, unknown>, responseStatus: string): string {
  if (Object.keys(responseSchema).length > 0) {
    return jsonSchemaTypeHintFallback(responseSchema);
  }

  // No-content success responses should be represented as void.
  if (responseStatus === "204" || responseStatus === "205") {
    return "void";
  }

  return "unknown";
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
  if (type === "integer") return "number";
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
): Record<string, unknown> {
  const paths = asRecord(pathsValue);
  const methods = ["get", "post", "put", "delete", "patch", "head", "options"] as const;
  const compactPaths: Record<string, unknown> = {};
  const compParams = componentParameters ? asRecord(componentParameters) : {};
  const compSchemas = componentSchemas ? asRecord(componentSchemas) : {};

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

  const normalizeParameters = (entries: unknown): Array<Record<string, unknown>> => {
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
        const requestBody = asRecord(operation.requestBody);
        const requestBodyContent = asRecord(requestBody.content);
        const requestBodySchema = resolveSchemaRef(
          getPreferredContentSchema(requestBodyContent),
          compSchemas,
        );

        const responses = asRecord(operation.responses);
        let responseSchema: Record<string, unknown> = {};
        let responseStatus = "";
        for (const [status, responseValue] of Object.entries(responses)) {
          if (!status.startsWith("2")) continue;
          responseSchema = resolveSchemaRef(
            getPreferredResponseSchema(asRecord(responseValue)),
            compSchemas,
          );
          responseStatus = status;
          if (Object.keys(responseSchema).length > 0) break;
        }

        if (hasGeneratedTypes) {
          // Pre-compute lightweight type hint strings (the full schemas are in the .d.ts)
          const combinedSchema: JsonSchema = {
            type: "object",
            properties: {
              ...Object.fromEntries(
                normalizeParameters(operation.parameters)
                  .concat(sharedParameters)
                  .map((param) => [param.name, param.schema]),
              ),
              ...asRecord(requestBodySchema.properties),
            },
            required: [
              ...normalizeParameters(operation.parameters)
                .concat(sharedParameters)
                .filter((param) => param.required)
                .map((param) => param.name as string),
              ...((Array.isArray(requestBodySchema.required)
                ? requestBodySchema.required.filter((item): item is string => typeof item === "string")
                : []) as string[]),
            ],
          };
          compactOperation._argsTypeHint = jsonSchemaTypeHintFallback(combinedSchema);
          compactOperation._returnsTypeHint = responseTypeHintFromSchema(responseSchema, responseStatus);
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
  /** @deprecated Kept for cache compat — new entries use `dts` instead */
  operationTypes?: Record<string, { argsType: string; returnsType: string }>;
  /** @deprecated Kept for cache compat — new entries use `dts` instead */
  schemaTypes?: Record<string, string>;
  warnings: string[];
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
  const dtsPromise = generateOpenApiDts(parsed);

  let bundled: Record<string, unknown>;
  try {
    bundled = (await parser.bundle(parsed)) as Record<string, unknown>;
  } catch (bundleError) {
    const bundleMessage = bundleError instanceof Error ? bundleError.message : String(bundleError);
    warnings.push(`OpenAPI bundle failed for '${sourceName}', using parse-only mode: ${bundleMessage}`);
    bundled = parsed;
  }

  const dts = await dtsPromise;

  // ── Step 3: Extract operation IDs for compaction ───────────────────────
  // If we have a .d.ts, we know which operations have full generated types.
  // compactOpenApiPaths uses this to strip request/response schemas from
  // operations that don't need the fallback hint generator.
  const operationTypeIds = dts ? extractOperationIdsFromDts(dts) : new Set<string>();

  const servers = Array.isArray(bundled.servers) ? (bundled.servers as Array<{ url?: unknown }>) : [];

  return {
    servers: servers
      .map((server) => (typeof server.url === "string" ? server.url : ""))
      .filter((url) => url.length > 0),
    paths: compactOpenApiPaths(
      bundled.paths,
      operationTypeIds,
      asRecord(asRecord(bundled.components).parameters),
      asRecord(asRecord(bundled.components).schemas),
    ),
    dts: dts ?? undefined,
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

  // The raw .d.ts is attached to the first tool only (same pattern as old schemaTypes).
  // The typechecker/Monaco use this directly via indexed access types.
  const sourceDts = prepared.dts
    ? prepared.dts.replace(/^export /gm, "")  // strip 'export' so types are ambient
    : undefined;
  let sourceDtsEmitted = false;

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

      // Lightweight type hints for LLM prompt / discover tool.
      // Pre-computed during compaction when .d.ts types exist (schemas stripped to save space).
      let argsType: string;
      let returnsType: string;
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
        returnsType = responseTypeHintFromSchema(responseSchema, responseStatus);
      }

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
        path: `${sanitizeSegment(config.name)}.${tag}.${operationId}`,
        source: sourceKey,
        approval,
        description: String(operation.summary ?? operation.description ?? `${method.toUpperCase()} ${pathTemplate}`),
        metadata: {
          argsType,
          returnsType,
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
   * GraphQL: { kind: "graphql", endpoint, operationName, operationType, auth? }
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
    | {
        kind: "graphql";
        endpoint: string;
        operationName: string;
        operationType: "query" | "mutation";
        authHeaders: Record<string, string>;
      }
    | { kind: "builtin" };
}

export interface WorkspaceToolSnapshot {
  tools: SerializedTool[];
  warnings: string[];
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

    if (st.runSpec.kind === "graphql") {
      const { endpoint, operationName, operationType, authHeaders } = st.runSpec;
      return {
        ...base,
        run: async (input: unknown, context) => {
          const payload = asRecord(input);
          const query = `${operationType} ${operationName}($input: JSON) { ${operationName}(input: $input) }`;
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...authHeaders,
              ...(context.credential?.headers ?? {}),
            },
            body: JSON.stringify({ query, variables: { input: payload } }),
          });
          if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`GraphQL HTTP ${response.status}: ${text.slice(0, 500)}`);
          }
          const json = await response.json() as Record<string, unknown>;
          if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
          return (json.data as Record<string, unknown>)?.[operationName];
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
