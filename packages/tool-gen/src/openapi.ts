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

  // Get base URL
  const servers = (api["servers"] as Array<{ url: string }> | undefined) ?? [];
  const baseUrl = servers[0]?.url ?? "";

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

      const argsZod = jsonSchemaToZod(combinedInputSchema);
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

          const response = await fetch(url, fetchInit);

          if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
          }

          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("json")) {
            return response.json();
          }
          return response.text();
        },
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
