import {
  applyCookiePlacementsToHeaders,
  applyHttpQueryPlacementsToUrl,
  applyJsonBodyPlacements,
} from "@executor/codemode-core";
import {
  httpBodyModeFromContentType,
  serializeOpenApiParameterValue,
  serializeOpenApiRequestBody,
  withSerializedQueryEntries,
} from "@executor/codemode-openapi";
import {
  createMcpToolsFromManifest,
  createSdkMcpConnector,
} from "@executor/codemode-mcp";
import type { AccountId, Source } from "#schema";
import * as Effect from "effect/Effect";

import type {
  OnElicitation,
  ToolExecutionContext,
  ToolInput,
  ToolPath,
} from "@executor/codemode-core";
import { buildInvocationPlan, type InvocationPlan } from "@executor/ir/catalog";
import type {
  CatalogV1,
  Capability,
  Executable,
  GraphQLExecutable,
  HttpExecutable,
  McpExecutable,
  ParameterSymbol,
  Scope,
} from "@executor/ir/model";
import type { LoadedSourceCatalogToolIndexEntry } from "../catalog/source-catalog-runtime";
import type { ResolvedSourceAuthMaterial } from "../auth/source-auth-material";

const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const asStringRecord = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(asObject(value)).flatMap(([key, entry]) =>
      typeof entry === "string" ? [[key, entry]] : []),
  );

const readSourceHeaders = (source: Source): Record<string, string> => {
  const binding = asObject(source.binding);
  const defaultHeaders = binding.defaultHeaders ?? binding.headers;
  return asStringRecord(defaultHeaders);
};

const readSourceQueryParams = (source: Source): Record<string, string> =>
  asStringRecord(asObject(source.binding).queryParams);

const readSourceTransport = (source: Source): "auto" | "streamable-http" | "sse" | undefined => {
  const transport = asString(asObject(source.binding).transport);
  if (transport === "streamable-http" || transport === "sse" || transport === "auto") {
    return transport;
  }
  return undefined;
};

type ExecutionEnvelope = {
  data: unknown;
  error: unknown;
  headers: Record<string, string>;
  status: number | null;
};

type HttpInvocationRequestPlan = {
  protocol: "http";
  method: HttpExecutable["method"];
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
};

type GraphqlInvocationRequestPlan = {
  protocol: "graphql";
  endpoint: string;
  headers: Record<string, string>;
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  responseRootField?: string;
};

type McpInvocationRequestPlan = {
  protocol: "mcp";
  endpoint: string;
  transport?: "auto" | "streamable-http" | "sse";
  queryParams: Record<string, string>;
  headers: Record<string, string>;
  authProvider?: ResolvedSourceAuthMaterial["authProvider"];
  toolName: string;
  payload: unknown;
  inputSchema: unknown;
  outputSchema: unknown;
  toolTitle?: string;
  toolSummary?: string;
};

type IrInvocationRequestPlan =
  | HttpInvocationRequestPlan
  | GraphqlInvocationRequestPlan
  | McpInvocationRequestPlan;

const decodeFetchBody = async (response: Response): Promise<unknown> => {
  if (response.status === 204) {
    return null;
  }

  const bodyMode = httpBodyModeFromContentType(response.headers.get("content-type"));
  if (bodyMode === "json") {
    return response.json();
  }
  if (bodyMode === "bytes") {
    return new Uint8Array(await response.arrayBuffer());
  }
  return response.text();
};

const responseHeadersRecord = (response: Response): Record<string, string> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
};

const executionEnvelope = (input: ExecutionEnvelope): ExecutionEnvelope => input;

const resolvedAuthSummary = (auth: ResolvedSourceAuthMaterial) => ({
  placementCount: auth.placements.length,
  headerKeys: Object.keys(auth.headers).sort(),
  queryParamKeys: Object.keys(auth.queryParams).sort(),
  cookieKeys: Object.keys(auth.cookies).sort(),
  bodyValueKeys: Object.keys(auth.bodyValues).sort(),
  expiresAt: auth.expiresAt,
  refreshAfter: auth.refreshAfter,
});

const parameterById = (catalog: CatalogV1, parameterId: string): ParameterSymbol | undefined => {
  const symbol = catalog.symbols[parameterId];
  return symbol?.kind === "parameter" ? symbol : undefined;
};

const httpParameterLookupMode = (catalog: CatalogV1, executable: HttpExecutable): "flat" | "grouped" => {
  const reserved = new Set(["body", "args", "select", "path", "query", "headers", "cookies"]);
  const allParameters = [
    ...(executable.pathParameterIds ?? []),
    ...(executable.queryParameterIds ?? []),
    ...(executable.headerParameterIds ?? []),
    ...(executable.cookieParameterIds ?? []),
  ]
    .map((parameterId) => parameterById(catalog, parameterId))
    .filter((parameter): parameter is ParameterSymbol => parameter !== undefined);

  const names = allParameters.map((parameter) => parameter.name);
  const hasCollision = names.some((name, index) =>
    reserved.has(name) || names.findIndex((candidate) => candidate === name) !== index
  );

  return hasCollision ? "grouped" : "flat";
};

const readHttpParameterValue = (input: {
  catalog: CatalogV1;
  executable: HttpExecutable;
  parameter: ParameterSymbol;
  args: Record<string, unknown>;
}): unknown => {
  const mode = httpParameterLookupMode(input.catalog, input.executable);
  if (mode === "flat") {
    return input.args[input.parameter.name];
  }

  const groupKey =
    input.parameter.location === "header"
      ? "headers"
      : input.parameter.location === "cookie"
        ? "cookies"
        : input.parameter.location;
  return asObject(input.args[groupKey])[input.parameter.name];
};

const scopeDefaultServers = (
  catalog: CatalogV1,
  scopeId: HttpExecutable["scopeId"],
): Array<{ url: string; variables?: Record<string, string> }> => {
  let currentId: HttpExecutable["scopeId"] | undefined = scopeId;

  while (currentId) {
    const scope: Scope | undefined = catalog.scopes[currentId];
    if (!scope) {
      break;
    }

    if (scope.defaults?.servers && scope.defaults.servers.length > 0) {
      return [...scope.defaults.servers];
    }

    currentId = scope.parentId;
  }

  return [];
};

const resolveScopedServerUrl = (
  source: Source,
  server: {
    url: string;
    variables?: Record<string, string>;
  },
): URL => {
  const expanded = Object.entries(server.variables ?? {}).reduce(
    (url, [name, value]) => url.replaceAll(`{${name}}`, value),
    server.url,
  );

  return new URL(expanded, source.endpoint);
};

const resolveHttpBaseUrl = (source: Source, catalog: CatalogV1, executable: HttpExecutable): URL => {
  const scopedServers = scopeDefaultServers(catalog, executable.scopeId);
  if (scopedServers.length > 0) {
    return resolveScopedServerUrl(source, scopedServers[0]!);
  }
  return new URL(source.endpoint);
};

const resolveHttpRequestUrl = (baseUrl: URL, resolvedPath: string): URL => {
  try {
    return new URL(resolvedPath);
  } catch {
    const resolved = new URL(baseUrl.toString());
    const basePath =
      resolved.pathname === "/"
        ? ""
        : resolved.pathname.endsWith("/")
          ? resolved.pathname.slice(0, -1)
          : resolved.pathname;
    const pathPart = resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`;

    resolved.pathname = `${basePath}${pathPart}`.replace(/\/{2,}/g, "/");
    resolved.search = "";
    resolved.hash = "";

    return resolved;
  }
};

const planHttpInvocation = (input: {
  source: Source;
  catalog: CatalogV1;
  executable: HttpExecutable;
  auth: ResolvedSourceAuthMaterial;
  args: unknown;
}): {
  resolvedEndpoint: string;
  requestPlan: HttpInvocationRequestPlan;
} => {
  const argsRecord = asObject(input.args);
  let resolvedPath = input.executable.pathTemplate;
  const url = applyHttpQueryPlacementsToUrl({
    url: resolveHttpBaseUrl(input.source, input.catalog, input.executable),
    queryParams: readSourceQueryParams(input.source),
  });
  const headers: Record<string, string> = {
    ...readSourceHeaders(input.source),
  };
  const queryEntries: Array<{ name: string; value: string; allowReserved?: boolean }> = [];
  const cookieParts: string[] = [];

  const allParameterIds = [
    ...(input.executable.pathParameterIds ?? []),
    ...(input.executable.queryParameterIds ?? []),
    ...(input.executable.headerParameterIds ?? []),
    ...(input.executable.cookieParameterIds ?? []),
  ];

  for (const parameterId of allParameterIds) {
    const parameter = parameterById(input.catalog, parameterId);
    if (!parameter) {
      continue;
    }

    const value = readHttpParameterValue({
      catalog: input.catalog,
      executable: input.executable,
      parameter,
      args: argsRecord,
    });
    if (value === undefined || value === null) {
      if (parameter.required) {
        throw new Error(`Missing required ${parameter.location} parameter ${parameter.name}`);
      }
      continue;
    }

    const serialized = serializeOpenApiParameterValue({
      name: parameter.name,
      location: parameter.location,
      style: parameter.style,
      explode: parameter.explode,
      allowReserved: parameter.allowReserved,
      content: parameter.content?.map((content) => ({ mediaType: content.mediaType })),
    }, value);

    if (serialized.kind === "path") {
      resolvedPath = resolvedPath.replace(
        new RegExp(`{${parameter.name}}`, "g"),
        serialized.value,
      );
      continue;
    }

    if (serialized.kind === "query") {
      queryEntries.push(...serialized.entries);
      continue;
    }

    if (serialized.kind === "header") {
      headers[parameter.name] = serialized.value;
      continue;
    }

    if (serialized.kind === "cookie") {
      cookieParts.push(
        ...serialized.pairs.map((pair) => `${pair.name}=${encodeURIComponent(pair.value)}`),
      );
    }
  }

  const bodySymbol = input.executable.requestBodyId
    ? input.catalog.symbols[input.executable.requestBodyId]
    : undefined;
  let body: string | Uint8Array | undefined;
  if (bodySymbol?.kind === "requestBody") {
    const bodyValue = argsRecord.body ?? argsRecord.input;
    if (bodyValue !== undefined) {
      const serializedBody = serializeOpenApiRequestBody({
        requestBody: {
          contentTypes: bodySymbol.contents.map((content) => content.mediaType),
          contents: bodySymbol.contents.map((content) => ({ mediaType: content.mediaType })),
        },
        body: applyJsonBodyPlacements({
          body: bodyValue,
          bodyValues: input.auth.bodyValues,
          label: `${input.executable.method} ${input.executable.pathTemplate}`,
        }),
      });
      headers["content-type"] = serializedBody.contentType;
      body = serializedBody.body;
    }
  }

  const requestUrl = resolveHttpRequestUrl(url, resolvedPath);
  const urlWithAuth = applyHttpQueryPlacementsToUrl({
    url: requestUrl,
    queryParams: input.auth.queryParams,
  });
  const urlWithOpenApiQuery = withSerializedQueryEntries(urlWithAuth, queryEntries);
  if (cookieParts.length > 0) {
    headers.cookie = cookieParts.join("; ");
  }
  const headersWithCookies = applyCookiePlacementsToHeaders({
    headers: {
      ...headers,
      ...input.auth.headers,
    },
    cookies: {
      ...input.auth.cookies,
    },
  });

  return {
    resolvedEndpoint: urlWithOpenApiQuery.toString(),
    requestPlan: {
      protocol: "http",
      method: input.executable.method,
      url: urlWithOpenApiQuery.toString(),
      headers: headersWithCookies,
      ...(body !== undefined ? { body } : {}),
    },
  };
};

const executeHttpPlan = (requestPlan: HttpInvocationRequestPlan) =>
  Effect.tryPromise({
    try: async () => {
      const body =
        requestPlan.body === undefined
          ? undefined
          : typeof requestPlan.body === "string"
            ? requestPlan.body
            : new Uint8Array(requestPlan.body).buffer;
      const response = await fetch(requestPlan.url, {
        method: requestPlan.method,
        headers: requestPlan.headers,
        ...(body !== undefined ? { body } : {}),
      });
      const responseBody = await decodeFetchBody(response);
      return executionEnvelope({
        data: response.ok ? responseBody : null,
        error: response.ok ? null : responseBody,
        headers: responseHeadersRecord(response),
        status: response.status,
      });
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });

const graphqlSelectionFromArgs = (value: unknown): string => {
  const record = asObject(value);
  const fields = Object.entries(record).flatMap(([key, entry]) => {
    if (entry === true) {
      return [key];
    }
    if (entry && typeof entry === "object") {
      const child = graphqlSelectionFromArgs(entry);
      return child.length > 0 ? [`${key} { ${child} }`] : [];
    }
    return [];
  });
  return fields.join(" ");
};

const graphqlArgsPayload = (input: {
  catalog: CatalogV1;
  executable: GraphQLExecutable;
  args: Record<string, unknown>;
}): Record<string, unknown> => {
  const argumentShape = input.catalog.symbols[input.executable.argumentShapeId];
  const reserved = new Set(["body", "args", "select", "path", "query", "headers", "cookies"]);
  if (
    argumentShape?.kind === "shape"
    && argumentShape.node.type === "object"
    && Object.keys(argumentShape.node.fields).every((name) => !reserved.has(name))
  ) {
    return Object.fromEntries(
      Object.entries(input.args).filter(([key]) => key !== "select" && key !== "headers"),
    );
  }

  return asObject(input.args.args);
};

const planGraphqlInvocation = (input: {
  source: Source;
  catalog: CatalogV1;
  executable: GraphQLExecutable;
  auth: ResolvedSourceAuthMaterial;
  args: unknown;
}): {
  resolvedEndpoint: string;
  requestPlan: GraphqlInvocationRequestPlan;
} => {
  const argsRecord = asObject(input.args);
  const requestHeaders = applyCookiePlacementsToHeaders({
    headers: {
      ...readSourceHeaders(input.source),
      ...input.auth.headers,
      ...asStringRecord(argsRecord.headers),
      "content-type": "application/json",
    },
    cookies: input.auth.cookies,
  });
  const queryParams = {
    ...readSourceQueryParams(input.source),
    ...input.auth.queryParams,
  };
  const endpoint = applyHttpQueryPlacementsToUrl({
    url: input.source.endpoint,
    queryParams,
  }).toString();

  if (
    input.executable.toolKind === "request"
    || typeof input.executable.operationDocument !== "string"
    || input.executable.operationDocument.trim().length === 0
  ) {
    const query = asString(argsRecord.query);
    if (query === null) {
      throw new Error("GraphQL request tools require args.query");
    }

    return {
      resolvedEndpoint: endpoint,
      requestPlan: {
        protocol: "graphql",
        endpoint,
        headers: requestHeaders,
        query,
        ...(argsRecord.variables ? { variables: asObject(argsRecord.variables) } : {}),
        ...(asString(argsRecord.operationName) ? { operationName: asString(argsRecord.operationName)! } : {}),
      },
    };
  }

  const operationDocument = input.executable.operationDocument;
  const operationName = input.executable.operationName;
  const variables = graphqlArgsPayload({
    catalog: input.catalog,
    executable: input.executable,
    args: argsRecord,
  });

  const query =
    input.executable.selectionMode === "caller"
      ? (() => {
          const selection = graphqlSelectionFromArgs(argsRecord.select);
          if (selection.length === 0) {
            throw new Error("GraphQL caller selection tools require args.select");
          }
          return `${input.executable.operationType} ${input.executable.rootField} { ${input.executable.rootField} ${selection ? `{ ${selection} }` : ""} }`;
        })()
      : operationDocument;

  return {
    resolvedEndpoint: endpoint,
    requestPlan: {
      protocol: "graphql",
      endpoint,
      headers: requestHeaders,
      query,
      variables,
      ...(operationName ? { operationName } : {}),
      responseRootField: input.executable.rootField,
    },
  };
};

const executeGraphqlPlan = (requestPlan: GraphqlInvocationRequestPlan) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(requestPlan.endpoint, {
        method: "POST",
        headers: requestPlan.headers,
        body: JSON.stringify({
          query: requestPlan.query,
          ...(requestPlan.variables ? { variables: requestPlan.variables } : {}),
          ...(requestPlan.operationName ? { operationName: requestPlan.operationName } : {}),
        }),
      });
      const decodedBody = await decodeFetchBody(response);

      if (requestPlan.responseRootField === undefined) {
        const bodyRecord = asObject(decodedBody);
        const errors = Array.isArray(bodyRecord.errors) ? bodyRecord.errors : [];
        return executionEnvelope({
          data: decodedBody,
          error: errors.length > 0 ? errors : (response.status >= 400 ? decodedBody : null),
          headers: responseHeadersRecord(response),
          status: response.status,
        });
      }

      const body = asObject(decodedBody);
      const errors = Array.isArray(body.errors) ? body.errors : [];
      const data = asObject(body.data);
      return executionEnvelope({
        data: data[requestPlan.responseRootField] ?? null,
        error: errors.length > 0 ? errors : (response.status >= 400 ? body : null),
        headers: responseHeadersRecord(response),
        status: response.status,
      });
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });

const planMcpInvocation = (input: {
  source: Source;
  catalog: CatalogV1;
  tool: LoadedSourceCatalogToolIndexEntry;
  executable: McpExecutable;
  auth: ResolvedSourceAuthMaterial;
  args: unknown;
}): {
  resolvedEndpoint: string;
  requestPlan: McpInvocationRequestPlan;
} => {
  const inputShape = input.executable.inputShapeId
    ? input.catalog.symbols[input.executable.inputShapeId]
    : undefined;
  const payload =
    inputShape?.kind === "shape" && inputShape.node.type !== "object"
      ? asObject(input.args).input
      : input.args;

  return {
    resolvedEndpoint: input.source.endpoint,
    requestPlan: {
      protocol: "mcp",
      endpoint: input.source.endpoint,
      transport: readSourceTransport(input.source),
      queryParams: {
        ...readSourceQueryParams(input.source),
        ...input.auth.queryParams,
      },
      headers: applyCookiePlacementsToHeaders({
        headers: {
          ...readSourceHeaders(input.source),
          ...input.auth.headers,
        },
        cookies: input.auth.cookies,
      }),
      authProvider: input.auth.authProvider,
      toolName: input.executable.toolName,
      payload,
      inputSchema: input.tool.descriptor.inputSchema,
      outputSchema: input.tool.descriptor.outputSchema,
      ...(input.tool.capability.surface.title ? { toolTitle: input.tool.capability.surface.title } : {}),
      ...(input.tool.capability.surface.summary ? { toolSummary: input.tool.capability.surface.summary } : {}),
    },
  };
};

const executeMcpPlan = (input: {
  source: Source;
  tool: LoadedSourceCatalogToolIndexEntry;
  requestPlan: McpInvocationRequestPlan;
  onElicitation?: OnElicitation;
  context?: Record<string, unknown>;
}) =>
  Effect.tryPromise({
    try: async () => {
      const connector = createSdkMcpConnector({
        endpoint: input.requestPlan.endpoint,
        transport: input.requestPlan.transport,
        queryParams: input.requestPlan.queryParams,
        headers: input.requestPlan.headers,
        authProvider: input.requestPlan.authProvider,
      });
      const tools = createMcpToolsFromManifest({
        manifest: {
          version: 2,
          tools: [{
            toolId: input.requestPlan.toolName,
            toolName: input.requestPlan.toolName,
            displayTitle:
              input.requestPlan.toolTitle
              ?? input.requestPlan.toolName,
            title: input.requestPlan.toolTitle ?? null,
            description:
              input.requestPlan.toolSummary
              ?? input.requestPlan.toolTitle
              ?? `MCP tool: ${input.requestPlan.toolName}`,
            annotations: null,
            execution: null,
            icons: null,
            meta: null,
            rawTool: null,
            inputSchema: input.requestPlan.inputSchema,
            outputSchema: input.requestPlan.outputSchema,
          }],
        },
        connect: connector,
        sourceKey: input.source.id,
      });
      const entry = tools[input.requestPlan.toolName] as ToolInput | undefined;
      const definition =
        entry && typeof entry === "object" && entry !== null && "tool" in entry
          ? entry.tool
          : entry;

      if (!definition) {
        throw new Error(`Missing MCP tool definition for ${input.requestPlan.toolName}`);
      }

      const executionContext: ToolExecutionContext | undefined =
        input.onElicitation
          ? {
              path: input.tool.path as ToolPath,
              sourceKey: input.source.id,
              metadata: {
                sourceKey: input.source.id,
                interaction: input.tool.descriptor.interaction,
                inputSchema: input.tool.descriptor.inputSchema,
                outputSchema: input.tool.descriptor.outputSchema,
                providerKind: input.tool.descriptor.providerKind,
                providerData: input.tool.descriptor.providerData,
              },
              invocation: input.context,
              onElicitation: input.onElicitation,
            }
          : undefined;

      const result = await definition.execute(asObject(input.requestPlan.payload), executionContext);
      const resultRecord = asObject(result);
      const isError = resultRecord.isError === true;
      return executionEnvelope({
        data: isError ? null : (result ?? null),
        error: isError ? result : null,
        headers: {},
        status: null,
      });
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });

const requestPlanFromInvocationPlan = (
  plan: InvocationPlan,
): IrInvocationRequestPlan => {
  const requestPlan = asObject(plan.requestPlan);
  const protocol = asString(requestPlan.protocol);
  if (protocol !== "http" && protocol !== "graphql" && protocol !== "mcp") {
    throw new Error(`Unsupported invocation request plan for executable ${plan.executableId}`);
  }
  return requestPlan as IrInvocationRequestPlan;
};

export const planIrToolInvocation = (input: {
  tool: LoadedSourceCatalogToolIndexEntry;
  auth: ResolvedSourceAuthMaterial;
  args: unknown;
}): InvocationPlan => {
  const planned =
    input.tool.executable.protocol === "http"
      ? planHttpInvocation({
          source: input.tool.source,
          catalog: input.tool.projectedCatalog,
          executable: input.tool.executable,
          auth: input.auth,
          args: input.args,
        })
      : input.tool.executable.protocol === "graphql"
        ? planGraphqlInvocation({
            source: input.tool.source,
            catalog: input.tool.projectedCatalog,
            executable: input.tool.executable,
            auth: input.auth,
            args: input.args,
          })
        : planMcpInvocation({
            source: input.tool.source,
            catalog: input.tool.projectedCatalog,
            tool: input.tool,
            executable: input.tool.executable,
            auth: input.auth,
            args: input.args,
          });

  return buildInvocationPlan({
    catalog: input.tool.projectedCatalog,
    capabilityId: input.tool.capabilityId,
    executableId: input.tool.executableId,
    connectionBindingId: input.tool.source.id,
    resolvedEndpoint: planned.resolvedEndpoint,
    resolvedAuth: resolvedAuthSummary(input.auth),
    requestPlan: planned.requestPlan,
  });
};

export const executeIrInvocationPlan = (input: {
  plan: InvocationPlan;
  source: Source;
  tool: LoadedSourceCatalogToolIndexEntry;
  onElicitation?: OnElicitation;
  context?: Record<string, unknown>;
}) => {
  const requestPlan = requestPlanFromInvocationPlan(input.plan);

  switch (requestPlan.protocol) {
    case "http":
      return executeHttpPlan(requestPlan);
    case "graphql":
      return executeGraphqlPlan(requestPlan);
    case "mcp":
      return executeMcpPlan({
        source: input.source,
        tool: input.tool,
        requestPlan,
        onElicitation: input.onElicitation,
        context: input.context,
      });
  }
};

export const invocationDescriptorFromTool = (input: {
  tool: LoadedSourceCatalogToolIndexEntry;
}): {
  toolPath: string;
  sourceId: Source["id"];
  sourceName: Source["name"];
  sourceKind: Source["kind"];
  sourceNamespace: string | null;
  operationKind: "read" | "write" | "delete" | "execute" | "unknown";
  interaction: "auto" | "required";
  approvalLabel: string | null;
} => ({
  toolPath: input.tool.path,
  sourceId: input.tool.source.id,
  sourceName: input.tool.source.name,
  sourceKind: input.tool.source.kind,
  sourceNamespace:
    input.tool.source.namespace ?? null,
  operationKind:
    input.tool.capability.semantics.effect === "read"
      ? "read"
      : input.tool.capability.semantics.effect === "write"
        ? "write"
        : input.tool.capability.semantics.effect === "delete"
          ? "delete"
          : input.tool.capability.semantics.effect === "action"
            ? "execute"
            : "unknown",
  interaction: input.tool.descriptor.interaction ?? "auto",
  approvalLabel: input.tool.capability.surface.title ?? null,
});

export const invokeIrTool = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  tool: LoadedSourceCatalogToolIndexEntry;
  auth: ResolvedSourceAuthMaterial;
  args: unknown;
  onElicitation?: OnElicitation;
  context?: Record<string, unknown>;
}) =>
  executeIrInvocationPlan({
    plan: planIrToolInvocation({
      tool: input.tool,
      auth: input.auth,
      args: input.args,
    }),
    source: input.tool.source,
    tool: input.tool,
    onElicitation: input.onElicitation,
    context: input.context,
  });
