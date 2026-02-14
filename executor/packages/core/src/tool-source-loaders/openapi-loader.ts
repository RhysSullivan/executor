"use node";

import { buildOpenApiToolsFromPrepared } from "../openapi-tool-builder";
import { buildCredentialSpec, buildStaticAuthHeaders, getCredentialSourceKey } from "../tool-source-auth";
import {
  buildPostmanToolPath,
  extractPostmanBody,
  extractPostmanHeaderMap,
  extractPostmanQueryEntries,
  extractPostmanVariableMap,
  resolvePostmanFolderPath,
} from "../postman-collection-utils";
import { executePostmanRequest, type PostmanSerializedRunSpec } from "../postman-runtime";
import { prepareOpenApiSpec } from "../openapi-prepare";
import type { OpenApiToolSourceConfig } from "../tool-source-types";
import { compactArgTypeHint, compactReturnTypeHint } from "../type-hints";
import type { ToolDefinition } from "../types";
import { asRecord } from "../utils";
import type { SerializedTool } from "../tool-source-serialization";

const POSTMAN_SPEC_PREFIX = "postman:";
const DEFAULT_POSTMAN_PROXY_URL = "https://www.postman.com/_api/ws/proxy";

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
