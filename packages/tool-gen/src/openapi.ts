/**
 * OpenAPI tool generator — parses an OpenAPI spec and produces a ToolTree.
 *
 * Takes an OpenAPI 3.x spec (URL, file path, or inline object),
 * groups operations by tag, and converts each into a defineTool()
 * with Zod schemas derived from the JSON Schema in the spec.
 */

import SwaggerParser from "@apidevtools/swagger-parser";
import { defineTool, type ApprovalMode, type ToolTree } from "@openassistant/core";
import { jsonSchemaToZod, jsonSchemaToTypeString, type JsonSchema } from "./json-schema-to-ts.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenApiToolSource {
  /** Namespace in the tool tree: `tools.<name>.<tag>.<operation>` */
  readonly name: string;
  /** URL or file path to the OpenAPI spec, or an inline spec object. */
  readonly spec: string | Record<string, unknown>;
  /** Authentication configuration. */
  readonly auth?: OpenApiAuth | undefined;
  /** Per-operation overrides. Key is the operationId. */
  readonly overrides?: Readonly<Record<string, {
    readonly approval?: ApprovalMode | undefined;
  }>> | undefined;
  /** Default approval mode for read operations (GET/HEAD/OPTIONS). Defaults to "auto". */
  readonly defaultReadApproval?: ApprovalMode | undefined;
  /** Default approval mode for write operations (POST/PUT/DELETE/PATCH). Defaults to "required". */
  readonly defaultWriteApproval?: ApprovalMode | undefined;
  /** Override the base URL from the spec. Useful when the spec has no `servers` or you're targeting a different environment. */
  readonly baseUrl?: string | undefined;
}

export type OpenApiAuth =
  | { readonly type: "basic"; readonly username: string; readonly password: string }
  | { readonly type: "bearer"; readonly token: string }
  | { readonly type: "apiKey"; readonly header: string; readonly value: string };

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface OpenApiGenerateResult {
  /** The generated tool tree, namespaced under the source name. */
  readonly tools: ToolTree;
  /** TypeScript declarations for the typechecker. */
  readonly typeDeclaration: string;
  /** Human-readable descriptions for the LLM prompt. */
  readonly promptGuidance: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ParsedOperation {
  tag: string;
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  parameters: ParsedParameter[];
  requestBodySchema: JsonSchema | undefined;
  responseSchema: JsonSchema | undefined;
}

interface ParsedParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  schema: JsonSchema;
  description?: string | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const READ_METHODS = new Set(["get", "head", "options"]);
const MAX_APPROVAL_PREVIEW = 240;


function buildAuthHeaders(auth: OpenApiAuth | undefined): Record<string, string> {
  if (!auth) return {};
  switch (auth.type) {
    case "basic":
      return { Authorization: `Basic ${btoa(`${auth.username}:${auth.password}`)}` };
    case "bearer":
      return { Authorization: `Bearer ${auth.token}` };
    case "apiKey":
      return { [auth.header]: auth.value };
  }
}

function buildUrl(
  baseUrl: string,
  path: string,
  params: ParsedParameter[],
  input: Record<string, unknown>,
): { url: string; remainingInput: Record<string, unknown> } {
  let resolvedPath = path;
  const queryParams: string[] = [];
  const remainingInput = { ...input };

  for (const param of params) {
    const value = input[param.name];
    if (value === undefined) continue;

    if (param.in === "path") {
      resolvedPath = resolvedPath.replace(`{${param.name}}`, encodeURIComponent(String(value)));
      delete remainingInput[param.name];
    } else if (param.in === "query") {
      queryParams.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(String(value))}`);
      delete remainingInput[param.name];
    }
  }

  const queryString = queryParams.length > 0 ? `?${queryParams.join("&")}` : "";
  return {
    url: `${baseUrl}${resolvedPath}${queryString}`,
    remainingInput,
  };
}

function sanitizeOperationId(operationId: string): string {
  // Convert to camelCase-safe identifier
  return operationId
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function sanitizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "") || "default";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPreview(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > MAX_APPROVAL_PREVIEW
      ? `${text.slice(0, MAX_APPROVAL_PREVIEW)}...`
      : text;
  } catch {
    return String(value);
  }
}

function actionFromMethod(method: string): "create" | "update" | "delete" | "read" | "execute" {
  switch (method.toLowerCase()) {
    case "get":
    case "head":
    case "options":
      return "read";
    case "post":
      return "create";
    case "put":
    case "patch":
      return "update";
    case "delete":
      return "delete";
    default:
      return "execute";
  }
}

function resourceTypeFromPath(path: string): string | undefined {
  const segments = path.split("/").filter(Boolean).filter((segment) => !segment.startsWith("{"));
  const raw = segments.at(-1);
  if (!raw) return undefined;
  const normalized = raw.endsWith("s") ? raw.slice(0, -1) : raw;
  return normalized.replace(/[_-]/g, " ");
}

function extractIds(input: unknown): string[] {
  if (!isRecord(input)) return [];
  const ids: string[] = [];
  for (const key of ["id", "ids", "idOrName", "name", "slug", "projectId"]) {
    const value = input[key];
    if (typeof value === "string" || typeof value === "number") {
      ids.push(String(value));
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" || typeof item === "number") {
          ids.push(String(item));
        }
      }
    }
  }
  return ids.slice(0, 5);
}

function buildSelector(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const selectors: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (key === "id" || key === "ids" || key === "idOrName") continue;
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      selectors.push(`${key}=${String(value)}`);
      if (selectors.length >= 3) break;
    }
  }
  return selectors.length > 0 ? selectors.join(", ") : undefined;
}

function buildOpenApiApprovalPreview(
  op: Pick<ParsedOperation, "method" | "path" | "operationId">,
  input: unknown,
) {
  const action = actionFromMethod(op.method);
  const ids = extractIds(input);
  const selector = buildSelector(input);
  const resourceType = resourceTypeFromPath(op.path);
  const title = `${op.method.toUpperCase()} ${op.path}`;
  const detailsParts = [
    `Operation: ${op.operationId}`,
    ids.length > 0 ? `Target: ${ids.join(", ")}` : undefined,
    selector ? `Selector: ${selector}` : undefined,
    `Arguments: ${toPreview(input)}`,
  ].filter(Boolean);
  return {
    title,
    details: detailsParts.join("\n"),
    action,
    resourceType,
    resourceIds: ids.length > 0 ? ids : undefined,
    isDestructive: action === "delete",
    selector,
  } as const;
}

// ---------------------------------------------------------------------------
// Spec parsing
// ---------------------------------------------------------------------------

function parseOperations(api: Record<string, unknown>): ParsedOperation[] {
  const paths = (api as { paths?: Record<string, Record<string, unknown>> }).paths ?? {};
  const operations: ParsedOperation[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    for (const method of ["get", "post", "put", "delete", "patch", "head", "options"]) {
      const operation = (pathItem as Record<string, unknown>)[method] as Record<string, unknown> | undefined;
      if (!operation) continue;

      const tags = (operation["tags"] as string[] | undefined) ?? ["default"];
      const tag = sanitizeTag(tags[0] ?? "default");
      const operationId = sanitizeOperationId(
        (operation["operationId"] as string | undefined) ?? `${method}_${path.replace(/\//g, "_")}`,
      );
      const summary = (operation["summary"] as string | undefined) ?? "";
      const description = (operation["description"] as string | undefined) ?? summary;

      // Parse parameters
      const rawParams = [
        ...((pathItem["parameters"] as unknown[] | undefined) ?? []),
        ...((operation["parameters"] as unknown[] | undefined) ?? []),
      ];
      const parameters: ParsedParameter[] = rawParams
        .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
        .map((p) => ({
          name: String(p["name"] ?? ""),
          in: String(p["in"] ?? "query") as ParsedParameter["in"],
          required: Boolean(p["required"]),
          schema: (p["schema"] as JsonSchema | undefined) ?? { type: "string" },
          description: p["description"] as string | undefined,
        }));

      // Parse request body
      let requestBodySchema: JsonSchema | undefined;
      const requestBody = operation["requestBody"] as Record<string, unknown> | undefined;
      if (requestBody) {
        const content = requestBody["content"] as Record<string, unknown> | undefined;
        if (content) {
          const jsonContent = (content["application/json"] ?? content["*/*"]) as Record<string, unknown> | undefined;
          if (jsonContent) {
            requestBodySchema = jsonContent["schema"] as JsonSchema | undefined;
          }
        }
      }

      // Parse response schema (from first 2xx response)
      let responseSchema: JsonSchema | undefined;
      const responses = operation["responses"] as Record<string, unknown> | undefined;
      if (responses) {
        for (const statusCode of Object.keys(responses)) {
          if (statusCode.startsWith("2")) {
            const response = responses[statusCode] as Record<string, unknown> | undefined;
            if (response) {
              const content = response["content"] as Record<string, unknown> | undefined;
              if (content) {
                const jsonContent = (content["application/json"] ?? content["*/*"]) as Record<string, unknown> | undefined;
                if (jsonContent) {
                  responseSchema = jsonContent["schema"] as JsonSchema | undefined;
                  break;
                }
              }
            }
          }
        }
      }

      operations.push({
        tag,
        operationId,
        method,
        path,
        summary,
        description: description.slice(0, 200), // Truncate long descriptions
        parameters,
        requestBodySchema,
        responseSchema,
      });
    }
  }

  return operations;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export async function generateOpenApiTools(
  source: OpenApiToolSource,
): Promise<OpenApiGenerateResult> {
  // Parse and dereference the spec
  const api = await SwaggerParser.dereference(source.spec as string) as Record<string, unknown>;

  // Get base URL (config override > spec servers > empty)
  const servers = (api["servers"] as Array<{ url: string }> | undefined) ?? [];
  const baseUrl = source.baseUrl ?? servers[0]?.url ?? "";

  const operations = parseOperations(api);
  const authHeaders = buildAuthHeaders(source.auth);

  // Group operations by tag
  const byTag = new Map<string, ParsedOperation[]>();
  for (const op of operations) {
    const existing = byTag.get(op.tag) ?? [];
    existing.push(op);
    byTag.set(op.tag, existing);
  }

  // Build tool tree
  const namespacedTree: Record<string, Record<string, ReturnType<typeof defineTool>>> = {};
  const typeLines: string[] = [];
  const guidanceLines: string[] = [];

  for (const [tag, ops] of byTag) {
    namespacedTree[tag] ??= {};
    const tagTypeLines: string[] = [];

    for (const op of ops) {
      const isRead = READ_METHODS.has(op.method);
      const approval =
        source.overrides?.[op.operationId]?.approval ??
        (isRead
          ? (source.defaultReadApproval ?? "auto")
          : (source.defaultWriteApproval ?? "required"));

      // Build combined input schema from parameters + request body
      const inputProperties: Record<string, JsonSchema> = {};
      const inputRequired: string[] = [];

      for (const param of op.parameters) {
        inputProperties[param.name] = {
          ...param.schema,
          description: param.description ?? param.schema.description,
        };
        if (param.required) inputRequired.push(param.name);
      }

      if (op.requestBodySchema) {
        // Merge request body properties into input
        const bodyProps = (op.requestBodySchema as { properties?: Record<string, JsonSchema> }).properties;
        const bodyRequired = (op.requestBodySchema as { required?: string[] }).required ?? [];
        if (bodyProps) {
          for (const [key, value] of Object.entries(bodyProps)) {
            inputProperties[key] = value;
          }
          inputRequired.push(...bodyRequired);
        } else {
          // If the body is a single schema without properties, use "body" as the key
          inputProperties["body"] = op.requestBodySchema;
        }
      }

      const combinedInputSchema: JsonSchema = {
        type: "object",
        properties: inputProperties,
        required: inputRequired.length > 0 ? inputRequired : undefined,
      };

      let argsZod: z.ZodType;

      try {
        argsZod = jsonSchemaToZod(combinedInputSchema);
      } catch {
        // Recursive/circular schemas — fall back to z.any()
        argsZod = z.any();
      }

      // Use openapi-typescript for type strings (handles allOf, oneOf, enums, etc.)
      const argsTypeString = jsonSchemaToTypeString(combinedInputSchema);
      const returnsTypeString = op.responseSchema
        ? jsonSchemaToTypeString(op.responseSchema)
        : "any";

      const description = op.summary || op.description || `${op.method.toUpperCase()} ${op.path}`;

      namespacedTree[tag]![op.operationId] = defineTool({
        description,
        approval,
        args: argsZod,
        returns: z.any(), // OpenAPI responses are complex; use any for runtime
        metadata: {
          argsType: argsTypeString,
          returnsType: returnsTypeString,
        },
        run: async (input: unknown) => {
          const { url, remainingInput } = buildUrl(
            baseUrl,
            op.path,
            op.parameters,
            input as Record<string, unknown>,
          );

          const hasBody = !isRead && Object.keys(remainingInput).length > 0;

          const fetchInit: RequestInit = {
            method: op.method.toUpperCase(),
            headers: {
              ...authHeaders,
              ...(hasBody ? { "Content-Type": "application/json" } : {}),
              "User-Agent": "openassistant/0.1.0",
            },
          };
          if (hasBody) {
            fetchInit.body = JSON.stringify(remainingInput);
          }

          // Retry once on any fetch error (stale keep-alive sockets, DNS, etc.).
          // On retry, force Connection: close to bypass dead pooled sockets.
          let response: Response;
          try {
            response = await fetch(url, fetchInit);
          } catch (firstError) {
            try {
              const retryInit = {
                ...fetchInit,
                headers: { ...(fetchInit.headers as Record<string, string>), Connection: "close" },
              };
              response = await fetch(url, retryInit);
            } catch {
              throw firstError; // retry failed too, throw the original
            }
          }

          if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`HTTP ${response.status} ${response.statusText} (${op.method.toUpperCase()} ${url}): ${text.slice(0, 500)}`);
          }

          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("json")) {
            return response.json();
          }
          return response.text();
        },
        formatApproval: (input) => buildOpenApiApprovalPreview(op, input),
      });

      // Build TypeScript declaration
      const approvalNote = approval === "required" ? " (approval required)" : " (auto-approved)";
      tagTypeLines.push(`    /** ${description} */`);
      tagTypeLines.push(`    ${op.operationId}(input: ${argsTypeString}): Promise<${returnsTypeString}>;`);

      guidanceLines.push(
        `- tools.${source.name}.${tag}.${op.operationId}(${argsTypeString}): Promise<${returnsTypeString}>${approvalNote} — ${description}`,
      );
    }

    typeLines.push(`  ${tag}: {`);
    typeLines.push(tagTypeLines.join("\n"));
    typeLines.push(`  };`);
  }

  const typeDeclaration = `${source.name}: {\n${typeLines.join("\n")}\n}`;
  const promptGuidance = guidanceLines.join("\n");

  return {
    tools: { [source.name]: namespacedTree },
    typeDeclaration,
    promptGuidance,
  };
}
