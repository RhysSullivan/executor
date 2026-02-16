"use node";

import { Result } from "better-result";
import { z } from "zod";
import { buildOpenApiToolsFromPrepared } from "../openapi/tool-builder";
import { buildCredentialSpec, buildStaticAuthHeaders, getCredentialSourceKey } from "../tool/source-auth";
import {
  buildPostmanToolPath,
  extractPostmanBody,
  extractPostmanHeaderMap,
  extractPostmanQueryEntries,
  extractPostmanVariableMap,
  resolvePostmanFolderPath,
} from "../postman/collection-utils";
import { executePostmanRequest, type PostmanSerializedRunSpec } from "../postman-runtime";
import { prepareOpenApiSpec } from "../openapi-prepare";
import type { OpenApiToolSourceConfig } from "../tool/source-types";
import type { ToolDefinition } from "../types";
import { asRecord } from "../utils";
import type { SerializedTool } from "../tool/source-serialization";

const POSTMAN_SPEC_PREFIX = "postman:";
const DEFAULT_POSTMAN_PROXY_URL = "https://www.postman.com/_api/ws/proxy";
const recordArraySchema = z.array(z.record(z.unknown()));
const postmanCollectionResponseSchema = z.object({
  data: z.object({
    requests: z.array(z.record(z.unknown())).optional(),
    folders: z.array(z.record(z.unknown())).optional(),
    variables: z.unknown().optional(),
  }).optional(),
});

function parsePostmanCollectionUid(spec: string): string | null {
  if (!spec.startsWith(POSTMAN_SPEC_PREFIX)) {
    return null;
  }

  const uid = spec.slice(POSTMAN_SPEC_PREFIX.length).trim();
  if (!uid) {
    return null;
  }

  return uid;
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

  const responseJsonResult = await Result.tryPromise(() => response.json());
  if (responseJsonResult.isErr()) {
    const cause = responseJsonResult.error.cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Failed to parse API collection ${collectionUid}: ${message}`);
  }

  const parsedCollection = postmanCollectionResponseSchema.safeParse(responseJsonResult.value);
  if (!parsedCollection.success) {
    throw new Error(`Invalid API collection response for ${collectionUid}: ${parsedCollection.error.message}`);
  }

  const collection = parsedCollection.data.data ?? {};
  const requestsResult = recordArraySchema.safeParse(collection.requests);
  const requests = requestsResult.success ? requestsResult.data : [];
  const foldersResult = recordArraySchema.safeParse(collection.folders);
  const folders = foldersResult.success ? foldersResult.data : [];

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
  const inputSchema: Record<string, unknown> = {
    type: "object",
    properties: {
      variables: {},
      query: {},
      headers: {},
      body: {},
    },
  };
  const previewInputKeys = ["variables", "query", "headers", "body"];

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
      typing: {
        inputSchema,
        outputSchema: {},
        previewInputKeys,
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

export async function loadOpenApiTools(config: OpenApiToolSourceConfig): Promise<ToolDefinition[]> {
  if (typeof config.spec === "string") {
    const collectionUid = parsePostmanCollectionUid(config.spec);
    if (collectionUid) {
      return await loadPostmanCollectionTools(config, collectionUid);
    }
  }

  const prepared = await prepareOpenApiSpec(config.spec, config.name);
  return buildOpenApiToolsFromPrepared(config, prepared);
}
