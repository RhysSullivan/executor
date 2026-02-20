import { z } from "zod";
import { buildOpenApiToolsFromPrepared } from "../openapi/tool-builder";
import { buildCredentialSpec, getCredentialSourceKey } from "../tool/source-auth";
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
import { toPlainObject } from "../utils";
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

const postmanFolderSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  folder: z.string().optional(),
});

const postmanRequestSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  method: z.string().optional(),
  url: z.string(),
  folder: z.string().optional(),
  pathVariableData: z.unknown().optional(),
  pathVariables: z.unknown().optional(),
  headerData: z.unknown().optional(),
  headers: z.unknown().optional(),
  queryParams: z.unknown().optional(),
  queryParam: z.unknown().optional(),
  bodyData: z.unknown().optional(),
  body: z.unknown().optional(),
  description: z.string().optional(),
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

  let responseJson: unknown;
  try {
    responseJson = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse API collection ${collectionUid}: ${message}`);
  }

  const parsedCollection = postmanCollectionResponseSchema.safeParse(responseJson);
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
    const parsedFolder = postmanFolderSchema.safeParse(folder);
    if (!parsedFolder.success) continue;

    const id = parsedFolder.data.id;
    const name = parsedFolder.data.name && parsedFolder.data.name.trim().length > 0
      ? parsedFolder.data.name
      : "folder";
    folderById.set(id, { name, parentId: parsedFolder.data.folder });
  }

  const sourceLabel = `catalog:${config.name}`;
  const authHeaders = {};
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
    const parsedRequest = postmanRequestSchema.safeParse(request);
    if (!parsedRequest.success) continue;

    const methodRaw = (parsedRequest.data.method ?? "get").toLowerCase();
    const method = methodRaw.length > 0 ? methodRaw : "get";
    const url = parsedRequest.data.url;
    if (!url) continue;

    const requestId = parsedRequest.data.id ?? "";
    const requestName = parsedRequest.data.name && parsedRequest.data.name.trim().length > 0
      ? parsedRequest.data.name.trim()
      : requestId || `${method.toUpperCase()} request`;
    const folderId = parsedRequest.data.folder;
    const folderPath = resolvePostmanFolderPath(folderId, folderById);
    const requestVariables = {
      ...collectionVariables,
      ...extractPostmanVariableMap(parsedRequest.data.pathVariableData ?? parsedRequest.data.pathVariables),
    };

    const runSpec: PostmanSerializedRunSpec = {
      kind: "postman",
      method,
      url,
      headers: extractPostmanHeaderMap(parsedRequest.data.headerData ?? parsedRequest.data.headers),
      queryParams: extractPostmanQueryEntries(parsedRequest.data.queryParams ?? parsedRequest.data.queryParam),
      body: extractPostmanBody(parsedRequest.data.bodyData ?? parsedRequest.data.body),
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
      description: parsedRequest.data.description && parsedRequest.data.description.trim().length > 0
        ? parsedRequest.data.description
        : `${method.toUpperCase()} ${url}`,
      typing: {
        inputSchema,
        outputSchema: {},
        previewInputKeys,
      },
      credential: credentialSpec,
      _runSpec: runSpec,
      run: async (input: unknown, context) => {
        const payloadRecord = toPlainObject(input) ?? {};
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
