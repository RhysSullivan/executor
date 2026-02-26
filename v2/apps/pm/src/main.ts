import { resolve } from "node:path";

import * as BunContext from "@effect/platform-bun/BunContext";
import {
  ToolProviderError,
  makeCloudflareWorkerLoaderRuntimeAdapter,
  makeDenoSubprocessRuntimeAdapter,
  makeLocalInProcessRuntimeAdapter,
  makeOpenApiToolProvider,
  makeRuntimeAdapterRegistry,
  makeToolProviderRegistry,
  openApiToolDescriptorsFromManifest,
  ToolProviderRegistryService,
  type RuntimeRunnableTool,
  type ToolProvider,
} from "@executor-v2/engine";
import {
  handleMcpHttpRequest,
  type ExecuteToolInput,
  type ExecuteToolResult,
} from "@executor-v2/mcp-gateway";
import {
  makeLocalSourceStore,
  makeLocalToolArtifactStore,
} from "@executor-v2/persistence-local";
import type {
  SourceStore,
  ToolArtifactStore,
} from "@executor-v2/persistence-ports";
import {
  CanonicalToolDescriptorSchema,
  OpenApiSourceConfigSchema,
  SourceSchema,
  SourceIdSchema,
  WorkspaceIdSchema,
  type CanonicalToolDescriptor,
  type OpenApiSourceConfig,
  type Source,
} from "@executor-v2/schema";
import {
  makeSourceManagerService,
  type SourceManagerService,
} from "@executor-v2/source-manager";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const port = Number(Bun.env.PORT ?? 8787);
const defaultStateRootDir = resolve(import.meta.dir, "../../../.executor-v2/local");
const stateRootDir = Bun.env.EXECUTOR_V2_STATE_DIR?.trim()
  ? resolve(Bun.env.EXECUTOR_V2_STATE_DIR)
  : defaultStateRootDir;

const decodeSource = Schema.decodeUnknownSync(SourceSchema);
const decodeSourceId = Schema.decodeUnknownSync(SourceIdSchema);
const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceIdSchema);
const decodeOpenApiSourceConfig = Schema.decodeUnknownSync(OpenApiSourceConfigSchema);
const decodeCanonicalToolDescriptor = Schema.decodeUnknownSync(
  CanonicalToolDescriptorSchema,
);

const workspaceId = decodeWorkspaceId(
  Bun.env.EXECUTOR_V2_WORKSPACE_ID?.trim() || "ws_local",
);

const BUILTIN_PROVIDER_KIND = "in_memory" as const;
const SOURCE_ADD_TOOL_ID = "executor.sources.add";
const SOURCE_LIST_TOOL_ID = "executor.sources.list";
const SOURCE_REMOVE_TOOL_ID = "executor.sources.remove";

const sourceAddDescriptor: CanonicalToolDescriptor = decodeCanonicalToolDescriptor({
  providerKind: BUILTIN_PROVIDER_KIND,
  sourceId: null,
  workspaceId: null,
  toolId: SOURCE_ADD_TOOL_ID,
  name: "executor.sources.add",
  description: "Add a source and probe OpenAPI connectivity",
  invocationMode: "in_memory",
  availability: "local_only",
  providerPayload: {
    operation: "add",
  },
});

const sourceListDescriptor: CanonicalToolDescriptor = decodeCanonicalToolDescriptor({
  providerKind: BUILTIN_PROVIDER_KIND,
  sourceId: null,
  workspaceId: null,
  toolId: SOURCE_LIST_TOOL_ID,
  name: "executor.sources.list",
  description: "List configured sources",
  invocationMode: "in_memory",
  availability: "local_only",
  providerPayload: {
    operation: "list",
  },
});

const sourceRemoveDescriptor: CanonicalToolDescriptor =
  decodeCanonicalToolDescriptor({
    providerKind: BUILTIN_PROVIDER_KIND,
    sourceId: null,
    workspaceId: null,
    toolId: SOURCE_REMOVE_TOOL_ID,
    name: "executor.sources.remove",
    description: "Remove a source by id or name",
    invocationMode: "in_memory",
    availability: "local_only",
    providerPayload: {
      operation: "remove",
    },
  });

const builtInDescriptors = [
  sourceAddDescriptor,
  sourceListDescriptor,
  sourceRemoveDescriptor,
] as const;

type LocalPersistenceContext = {
  sourceStore: SourceStore;
  artifactStore: ToolArtifactStore;
  sourceManager: SourceManagerService;
};

type SourceCredentialMode = "none" | "api_key" | "bearer";

type AddSourceArgs = {
  kind: "openapi" | "mcp" | "graphql" | "internal";
  name?: string;
  endpoint: string;
  credential?: {
    mode: SourceCredentialMode;
    value?: string;
    headerName?: string;
  };
  staticHeaders?: Record<string, string>;
};

type RemoveSourceArgs = {
  sourceId?: string;
  name?: string;
};

const runtimeRegistry = makeRuntimeAdapterRegistry([
  makeLocalInProcessRuntimeAdapter(),
  makeDenoSubprocessRuntimeAdapter(),
  makeCloudflareWorkerLoaderRuntimeAdapter(),
]);

const localPersistencePromise = Effect.runPromise(
  Effect.gen(function* () {
    const sourceStore = yield* makeLocalSourceStore({ rootDir: stateRootDir });
    const artifactStore = yield* makeLocalToolArtifactStore({ rootDir: stateRootDir });

    return {
      sourceStore,
      artifactStore,
      sourceManager: makeSourceManagerService(artifactStore),
    } satisfies LocalPersistenceContext;
  }).pipe(Effect.provide(BunContext.layer)),
);

const errorToText = (error: unknown): string => {
  const extractDetails = (value: unknown): string | null => {
    if (typeof value === "object" && value !== null && "details" in value) {
      const details = (value as { details?: unknown }).details;
      if (typeof details === "string" && details.length > 0) {
        return details;
      }
    }

    return null;
  };

  if (error instanceof Error) {
    const details = extractDetails(error);
    return details ? `${error.message}\n${details}` : error.message;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    const details = extractDetails(error);
    return details ? `${error.message}\n${details}` : error.message;
  }

  return String(error);
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

const toSlug = (value: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return slug.length > 0 ? slug : "source";
};

const defaultSourceName = (endpoint: string): string => {
  try {
    const parsed = new URL(endpoint);
    return parsed.hostname;
  } catch {
    return endpoint;
  }
};

const parseOpenApiSourceConfig = (source: Source): OpenApiSourceConfig | null => {
  const trimmed = source.configJson.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return decodeOpenApiSourceConfig(parsed);
  } catch {
    return null;
  }
};

const buildOpenApiSourceConfig = (input: AddSourceArgs): OpenApiSourceConfig => ({
  type: "openapi",
  auth: input.credential
    ? {
        mode: input.credential.mode,
        headerName: input.credential.headerName,
        value: input.credential.value,
      }
    : {
        mode: "none",
      },
  staticHeaders: input.staticHeaders,
});

const configuredHeadersForOpenApi = (
  config: OpenApiSourceConfig,
): { headers: Headers; error: string | null } => {
  const headers = new Headers();

  if (config.staticHeaders) {
    for (const [key, value] of Object.entries(config.staticHeaders)) {
      headers.set(key, value);
    }
  }

  const auth = config.auth;
  if (!auth || auth.mode === "none") {
    return { headers, error: null };
  }

  const credentialValue = auth.value?.trim();
  if (!credentialValue) {
    return {
      headers,
      error: "Configured credential mode requires a value",
    };
  }

  if (auth.mode === "api_key") {
    headers.set(auth.headerName?.trim() || "x-api-key", credentialValue);
    return { headers, error: null };
  }

  headers.set("authorization", `Bearer ${credentialValue}`);
  return { headers, error: null };
};

const sourceSummary = (source: Source, toolCount: number) => {
  const config = parseOpenApiSourceConfig(source);

  return {
    id: source.id,
    workspaceId: source.workspaceId,
    name: source.name,
    kind: source.kind,
    endpoint: source.endpoint,
    status: source.status,
    enabled: source.enabled,
    sourceHash: source.sourceHash,
    lastError: source.lastError,
    toolCount,
    credential: config?.auth
      ? {
          mode: config.auth.mode,
          headerName: config.auth.headerName ?? null,
          configured: Boolean(config.auth.value && config.auth.value.trim().length > 0),
        }
      : null,
  };
};

const parseSourceCredentialMode = (value: unknown): SourceCredentialMode => {
  if (value === "none" || value === "api_key" || value === "bearer") {
    return value;
  }

  throw new Error("credential.mode must be one of: none, api_key, bearer");
};

const parseAddSourceArgs = (args: unknown): AddSourceArgs => {
  const record = asRecord(args);
  if (!record) {
    throw new Error("executor.sources.add expects an object argument");
  }

  const endpoint = record.endpoint;
  if (typeof endpoint !== "string" || endpoint.trim().length === 0) {
    throw new Error("executor.sources.add requires endpoint");
  }

  const kind = record.kind;
  const normalizedKind =
    kind === "openapi" || kind === "mcp" || kind === "graphql" || kind === "internal"
      ? kind
      : "openapi";

  const name = typeof record.name === "string" ? record.name : undefined;

  let credential: AddSourceArgs["credential"];
  const credentialRecord = asRecord(record.credential);
  if (credentialRecord) {
    credential = {
      mode: parseSourceCredentialMode(credentialRecord.mode),
      value:
        typeof credentialRecord.value === "string" ? credentialRecord.value : undefined,
      headerName:
        typeof credentialRecord.headerName === "string"
          ? credentialRecord.headerName
          : undefined,
    };
  }

  let staticHeaders: Record<string, string> | undefined;
  const staticHeadersRecord = asRecord(record.staticHeaders);
  if (staticHeadersRecord) {
    staticHeaders = {};

    for (const [key, value] of Object.entries(staticHeadersRecord)) {
      if (typeof value !== "string") {
        throw new Error("staticHeaders values must be strings");
      }

      staticHeaders[key] = value;
    }
  }

  return {
    kind: normalizedKind,
    name,
    endpoint,
    credential,
    staticHeaders,
  };
};

const parseRemoveSourceArgs = (args: unknown): RemoveSourceArgs => {
  const record = asRecord(args);
  if (!record) {
    throw new Error("executor.sources.remove expects an object argument");
  }

  const sourceId = typeof record.sourceId === "string" ? record.sourceId : undefined;
  const name = typeof record.name === "string" ? record.name : undefined;

  return {
    sourceId,
    name,
  };
};

const addSource = async (
  context: LocalPersistenceContext,
  args: AddSourceArgs,
): Promise<{ source: ReturnType<typeof sourceSummary>; toolCount: number }> => {
  if (args.kind !== "openapi") {
    throw new Error(`Source kind '${args.kind}' is not supported yet (MVP supports openapi)`);
  }

  const endpoint = args.endpoint.trim();
  if (endpoint.length === 0) {
    throw new Error("endpoint is required");
  }

  const name = args.name?.trim() || defaultSourceName(endpoint);
  const config = buildOpenApiSourceConfig(args);
  const configJson = JSON.stringify(config);

  const existingSources = await Effect.runPromise(
    context.sourceStore.listByWorkspace(workspaceId),
  );
  const existingSource = existingSources.find(
    (source) => source.kind === "openapi" && source.endpoint === endpoint,
  );

  const now = Date.now();
  const sourceId =
    existingSource?.id ??
    decodeSourceId(
      `src_${toSlug(name)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`,
    );

  const probingSource = decodeSource({
    id: sourceId,
    workspaceId,
    name,
    kind: "openapi",
    endpoint,
    status: "probing",
    enabled: true,
    configJson,
    sourceHash: existingSource?.sourceHash ?? null,
    lastError: null,
    createdAt: existingSource?.createdAt ?? now,
    updatedAt: now,
  });

  await Effect.runPromise(context.sourceStore.upsert(probingSource));

  const configuredHeaders = configuredHeadersForOpenApi(config);
  if (configuredHeaders.error) {
    const authRequiredSource = decodeSource({
      ...probingSource,
      status: "auth_required",
      sourceHash: null,
      lastError: configuredHeaders.error,
      updatedAt: Date.now(),
    });

    await Effect.runPromise(context.sourceStore.upsert(authRequiredSource));

    return {
      source: sourceSummary(authRequiredSource, 0),
      toolCount: 0,
    };
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: configuredHeaders.headers,
    });
  } catch (cause) {
    const failedSource = decodeSource({
      ...probingSource,
      status: "error",
      sourceHash: null,
      lastError: `Failed to fetch OpenAPI spec: ${errorToText(cause)}`,
      updatedAt: Date.now(),
    });

    await Effect.runPromise(context.sourceStore.upsert(failedSource));

    return {
      source: sourceSummary(failedSource, 0),
      toolCount: 0,
    };
  }

  if (response.status === 401 || response.status === 403) {
    const authRequiredSource = decodeSource({
      ...probingSource,
      status: "auth_required",
      sourceHash: null,
      lastError: `OpenAPI endpoint responded with HTTP ${response.status}`,
      updatedAt: Date.now(),
    });

    await Effect.runPromise(context.sourceStore.upsert(authRequiredSource));

    return {
      source: sourceSummary(authRequiredSource, 0),
      toolCount: 0,
    };
  }

  if (!response.ok) {
    const failedSource = decodeSource({
      ...probingSource,
      status: "error",
      sourceHash: null,
      lastError: `OpenAPI endpoint responded with HTTP ${response.status}`,
      updatedAt: Date.now(),
    });

    await Effect.runPromise(context.sourceStore.upsert(failedSource));

    return {
      source: sourceSummary(failedSource, 0),
      toolCount: 0,
    };
  }

  let openApiSpec: unknown;
  try {
    openApiSpec = await response.json();
  } catch (cause) {
    const failedSource = decodeSource({
      ...probingSource,
      status: "error",
      sourceHash: null,
      lastError: `Failed to parse OpenAPI response JSON: ${errorToText(cause)}`,
      updatedAt: Date.now(),
    });

    await Effect.runPromise(context.sourceStore.upsert(failedSource));

    return {
      source: sourceSummary(failedSource, 0),
      toolCount: 0,
    };
  }

  const refreshResult = await Effect.runPromise(
    Effect.either(
      context.sourceManager.refreshOpenApiArtifact({
        source: probingSource,
        openApiSpec,
      }),
    ),
  );

  if (Either.isLeft(refreshResult)) {
    const failedSource = decodeSource({
      ...probingSource,
      status: "error",
      sourceHash: null,
      lastError: `OpenAPI extraction failed: ${errorToText(refreshResult.left)}`,
      updatedAt: Date.now(),
    });

    await Effect.runPromise(context.sourceStore.upsert(failedSource));

    return {
      source: sourceSummary(failedSource, 0),
      toolCount: 0,
    };
  }

  const connectedSource = decodeSource({
    ...probingSource,
    status: "connected",
    sourceHash: refreshResult.right.artifact.sourceHash,
    lastError: null,
    updatedAt: Date.now(),
  });

  await Effect.runPromise(context.sourceStore.upsert(connectedSource));

  return {
    source: sourceSummary(connectedSource, refreshResult.right.artifact.toolCount),
    toolCount: refreshResult.right.artifact.toolCount,
  };
};

const listSources = async (
  context: LocalPersistenceContext,
): Promise<{ sources: ReadonlyArray<ReturnType<typeof sourceSummary>> }> => {
  const result = await Effect.runPromise(
    Effect.either(
      Effect.gen(function* () {
        const sources = yield* context.sourceStore.listByWorkspace(workspaceId);

        return yield* Effect.forEach(sources, (source) =>
          Effect.gen(function* () {
            const artifactOption = yield* context.artifactStore.getBySource(
              source.workspaceId,
              source.id,
            );
            const artifact = Option.getOrUndefined(artifactOption);
            return sourceSummary(source, artifact?.toolCount ?? 0);
          }),
        );
      }),
    ),
  );

  if (Either.isLeft(result)) {
    throw new Error(errorToText(result.left));
  }

  return {
    sources: result.right,
  };
};

const removeSource = async (
  context: LocalPersistenceContext,
  args: RemoveSourceArgs,
): Promise<{ removed: boolean }> => {
  const targetSourceId = args.sourceId?.trim();
  const targetName = args.name?.trim();

  if (!targetSourceId && !targetName) {
    throw new Error("Provide either sourceId or name");
  }

  const sources = await Effect.runPromise(context.sourceStore.listByWorkspace(workspaceId));

  const sourceToRemove = targetSourceId
    ? sources.find((source) => source.id === targetSourceId)
    : sources.find((source) => source.name === targetName);

  if (!sourceToRemove) {
    return {
      removed: false,
    };
  }

  const removed = await Effect.runPromise(
    context.sourceStore.removeById(workspaceId, sourceToRemove.id),
  );

  return {
    removed,
  };
};

const builtInToolError = (
  operation: string,
  message: string,
  details: string | null,
): ToolProviderError =>
  new ToolProviderError({
    operation,
    providerKind: BUILTIN_PROVIDER_KIND,
    message,
    details,
  });

const makeBuiltInToolsProvider = (
  context: LocalPersistenceContext,
): ToolProvider => ({
  kind: BUILTIN_PROVIDER_KIND,
  invoke: (input) =>
    Effect.gen(function* () {
      if (input.tool.toolId === SOURCE_ADD_TOOL_ID) {
        const output = yield* Effect.tryPromise({
          try: () => addSource(context, parseAddSourceArgs(input.args)),
          catch: (cause) =>
            builtInToolError(
              "invoke.add_source",
              "Failed to add source",
              errorToText(cause),
            ),
        });

        return {
          output,
          isError: false,
        } as const;
      }

      if (input.tool.toolId === SOURCE_LIST_TOOL_ID) {
        const output = yield* Effect.tryPromise({
          try: () => listSources(context),
          catch: (cause) =>
            builtInToolError(
              "invoke.list_sources",
              "Failed to list sources",
              errorToText(cause),
            ),
        });

        return {
          output,
          isError: false,
        } as const;
      }

      if (input.tool.toolId === SOURCE_REMOVE_TOOL_ID) {
        const output = yield* Effect.tryPromise({
          try: () => removeSource(context, parseRemoveSourceArgs(input.args)),
          catch: (cause) =>
            builtInToolError(
              "invoke.remove_source",
              "Failed to remove source",
              errorToText(cause),
            ),
        });

        return {
          output,
          isError: false,
        } as const;
      }

      return yield* builtInToolError(
        "invoke",
        `Unknown in-memory tool id: ${input.tool.toolId}`,
        null,
      );
    }),
});

const collectRunnableTools = async (
  context: LocalPersistenceContext,
): Promise<ReadonlyArray<RuntimeRunnableTool>> => {
  const tools: Array<RuntimeRunnableTool> = builtInDescriptors.map((descriptor) => ({
    descriptor,
    source: null,
  }));

  const sources = await Effect.runPromise(
    context.sourceStore.listByWorkspace(workspaceId),
  );

  for (const source of sources) {
    if (source.kind !== "openapi" || !source.enabled || source.status !== "connected") {
      continue;
    }

    const artifactOption = await Effect.runPromise(
      context.artifactStore.getBySource(source.workspaceId, source.id),
    );

    if (Option.isNone(artifactOption)) {
      continue;
    }

    const descriptors = await Effect.runPromise(
      openApiToolDescriptorsFromManifest(source, artifactOption.value.manifestJson),
    );

    for (const descriptor of descriptors) {
      tools.push({
        descriptor,
        source,
      });
    }
  }

  return tools;
};

const executeTool = async (input: ExecuteToolInput): Promise<ExecuteToolResult> => {
  const context = await localPersistencePromise;

  let runnableTools: ReadonlyArray<RuntimeRunnableTool>;
  try {
    runnableTools = await collectRunnableTools(context);
  } catch (cause) {
    return {
      isError: true,
      error: errorToText(cause),
    };
  }

  const providerRegistry = makeToolProviderRegistry([
    makeOpenApiToolProvider(),
    makeBuiltInToolsProvider(context),
  ]);

  const result = await Effect.runPromise(
    Effect.either(
      runtimeRegistry
        .execute({
          runtimeKind: input.runtimeKind ?? "local-inproc",
          code: input.code,
          tools: runnableTools,
        })
        .pipe(Effect.provideService(ToolProviderRegistryService, providerRegistry)),
    ),
  );

  if (Either.isLeft(result)) {
    return {
      isError: true,
      error: errorToText(result.left),
    };
  }

  return {
    isError: false,
    output: result.right,
  };
};

const handleMcp = async (request: Request): Promise<Response> =>
  handleMcpHttpRequest(request, {
    target: "local",
    serverName: "executor-v2-pm",
    serverVersion: "0.0.0",
    execute: executeTool,
  });

const server = Bun.serve({
  port,
  routes: {
    "/healthz": {
      GET: () =>
        Response.json(
          {
            ok: true,
            service: "pm",
            workspaceId,
            stateRootDir,
          },
          { status: 200 },
        ),
    },
    "/mcp": {
      GET: handleMcp,
      POST: handleMcp,
      DELETE: handleMcp,
    },
    "/v1/mcp": {
      GET: handleMcp,
      POST: handleMcp,
      DELETE: handleMcp,
    },
  },
});

console.log(`executor-v2 PM listening on http://127.0.0.1:${server.port}`);
console.log(`executor-v2 PM state dir: ${stateRootDir}`);
