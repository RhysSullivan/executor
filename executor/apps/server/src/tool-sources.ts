import SwaggerParser from "@apidevtools/swagger-parser";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolApprovalMode, ToolCredentialSpec, ToolDefinition } from "./types";

type JsonSchema = Record<string, unknown>;

export interface McpToolSourceConfig {
  type: "mcp";
  name: string;
  url: string;
  transport?: "sse" | "streamable-http";
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

export type ExternalToolSourceConfig = McpToolSourceConfig | OpenApiToolSourceConfig;

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sanitizeSegment(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return cleaned.length > 0 ? cleaned : "default";
}

function jsonSchemaTypeHint(schema: unknown, depth = 0): string {
  if (!schema || typeof schema !== "object") return "unknown";
  if (depth > 4) return "unknown";

  const shape = schema as JsonSchema;
  const enumValues = Array.isArray(shape.enum) ? shape.enum : undefined;
  if (enumValues && enumValues.length > 0) {
    return enumValues.map((value) => JSON.stringify(value)).join(" | ");
  }

  const oneOf = Array.isArray(shape.oneOf) ? shape.oneOf : undefined;
  if (oneOf && oneOf.length > 0) {
    return oneOf.map((entry) => jsonSchemaTypeHint(entry, depth + 1)).join(" | ");
  }

  const anyOf = Array.isArray(shape.anyOf) ? shape.anyOf : undefined;
  if (anyOf && anyOf.length > 0) {
    return anyOf.map((entry) => jsonSchemaTypeHint(entry, depth + 1)).join(" | ");
  }

  const type = typeof shape.type === "string" ? shape.type : undefined;
  if (type === "string" || type === "number" || type === "boolean" || type === "null") {
    return type;
  }

  if (type === "array") {
    return `${jsonSchemaTypeHint(shape.items, depth + 1)}[]`;
  }

  const props = toObject(shape.properties);
  const requiredRaw = Array.isArray(shape.required) ? shape.required : [];
  const required = new Set(requiredRaw.filter((item): item is string => typeof item === "string"));
  const propEntries = Object.entries(props);
  if (type === "object" || propEntries.length > 0) {
    if (propEntries.length === 0) {
      return "Record<string, unknown>";
    }
    const inner = propEntries
      .slice(0, 12)
      .map(([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${jsonSchemaTypeHint(value, depth + 1)}`)
      .join("; ");
    return `{ ${inner} }`;
  }

  return "unknown";
}

async function connectMcp(
  url: string,
  preferredTransport?: "sse" | "streamable-http",
): Promise<{ client: Client; close: () => Promise<void> }> {
  const endpoint = new URL(url);
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
  let connection = await connectMcp(config.url, config.transport);

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

      connection = await connectMcp(config.url, config.transport);
      return await connection.client.callTool({ name, arguments: input });
    }
  }

  const listed = await connection.client.listTools();
  const tools = Array.isArray((listed as { tools?: unknown }).tools)
    ? ((listed as { tools: Array<Record<string, unknown>> }).tools)
    : [];

  return tools.map((tool) => {
    const toolName = String(tool.name ?? "tool");
    const inputSchema = toObject(tool.inputSchema);
    return {
      path: `${sanitizeSegment(config.name)}.${sanitizeSegment(toolName)}`,
      source: `mcp:${config.name}`,
      approval: config.overrides?.[toolName]?.approval ?? config.defaultApproval ?? "auto",
      description: String(tool.description ?? `MCP tool ${toolName}`),
      metadata: {
        argsType: jsonSchemaTypeHint(inputSchema),
        returnsType: "unknown",
      },
      run: async (input: unknown) => {
        const payload = toObject(input);
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
  const paths = toObject(api.paths);
  const tools: ToolDefinition[] = [];

  const methods = ["get", "post", "put", "delete", "patch", "head", "options"] as const;
  const readMethods = new Set(["get", "head", "options"]);

  for (const [pathTemplate, pathValue] of Object.entries(paths)) {
    const pathObject = toObject(pathValue);
    const sharedParameters = Array.isArray(pathObject.parameters)
      ? (pathObject.parameters as Array<Record<string, unknown>>)
      : [];

    for (const method of methods) {
      const operation = toObject(pathObject[method]);
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
        schema: toObject(entry.schema),
      }));

      const requestBody = toObject(operation.requestBody);
      const requestBodyContent = toObject(requestBody.content);
      const requestBodySchema = toObject(
        toObject(requestBodyContent["application/json"])["schema"] ??
        toObject(requestBodyContent["*/*"])["schema"],
      );

      const responses = toObject(operation.responses);
      let responseSchema: Record<string, unknown> = {};
      for (const [status, responseValue] of Object.entries(responses)) {
        if (!status.startsWith("2")) continue;
        const responseContent = toObject(toObject(responseValue).content);
        responseSchema = toObject(
          toObject(responseContent["application/json"])["schema"] ??
          toObject(responseContent["*/*"])["schema"],
        );
        if (Object.keys(responseSchema).length > 0) break;
      }

      const combinedSchema: JsonSchema = {
        type: "object",
        properties: {
          ...Object.fromEntries(parameters.map((param) => [param.name, param.schema])),
          ...toObject(requestBodySchema.properties),
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
          argsType: jsonSchemaTypeHint(combinedSchema),
          returnsType: jsonSchemaTypeHint(responseSchema),
        },
        credential: credentialSpec,
        run: async (input: unknown, context) => {
          const payload = toObject(input);
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

export async function loadExternalTools(sources: ExternalToolSourceConfig[]): Promise<ToolDefinition[]> {
  const loaded: ToolDefinition[] = [];
  const warnings: string[] = [];

  for (const source of sources) {
    try {
      if (source.type === "mcp") {
        loaded.push(...(await loadMcpTools(source)));
      } else if (source.type === "openapi") {
        loaded.push(...(await loadOpenApiTools(source)));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to load ${source.type} source '${source.name}': ${message}`);
      console.warn(`[executor] failed to load tool source ${source.type}:${source.name}: ${message}`);
    }
  }

  return { tools: loaded, warnings };
}
