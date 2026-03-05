import {
  ExecutorControlPlaneBaseUrlHeader,
} from "@executor-v2/api-http";
import {
  ControlPlaneAuthHeaders,
  ControlPlaneService,
  controlPlaneOpenApiSpec,
  fetchOpenApiDocument,
  makeControlPlaneService,
  makeControlPlaneSourcesService,
  makeControlPlaneWebHandler,
  makeSourceCatalogService,
  makeSourceManagerService,
} from "@executor-v2/management-api";
import {
  RuntimeToolInvokerError,
  createRuntimeToolCallHandler,
  createRunExecutor,
  createSourceToolRegistry,
  defaultExecuteToolExposureMode,
  invokeRuntimeToolCallResult,
  makeGraphqlToolProvider,
  makeMcpToolProvider,
  makeOpenApiToolProvider,
  makeRuntimeAdapterRegistry,
  makeToolProviderRegistry,
  parseExecuteToolExposureMode,
  sourceIdFromToolPath,
} from "@executor-v2/engine";
import {
  RuntimeHostActorLive,
  createRuntimeHostAdminMcpHandler,
  createKeychainSecretMaterialStore,
  createRuntimeHostInteractionsService,
  createRuntimeHostCredentialsService,
  createRuntimeHostExecuteRuntimeRun,
  createRuntimeHostMcpHandler,
  createRuntimeHostOrganizationsService,
  createRuntimeHostPersistentToolInteractionPolicy,
  createRuntimeHostPoliciesService,
  createRuntimeHostResolveToolCredentials,
  createRuntimeHostStorageService,
  createRuntimeHostToolsService,
  createRuntimeHostWorkspacesService,
  createSqlSecretMaterialStore,
  parseSecretMaterialBackendKind,
} from "@executor-v2/control-plane-runtime";
import {
  makeSqlControlPlanePersistence,
  type SqlControlPlanePersistence,
} from "@executor-v2/persistence-sql";
import {
  type SourceStore,
  type ToolArtifactStore,
} from "@executor-v2/persistence-ports";
import {
  type Profile,
  type Organization,
  type OrganizationMembership,
  type Source,
  type SourceId,
  type ToolArtifact,
  type WorkspaceId,
  type Workspace,
} from "@executor-v2/schema";
import {
  type ExecuteRunInput,
  type ExecuteRunResult,
} from "@executor-v2/sdk";
import { makeCloudflareWorkerLoaderRuntimeAdapter } from "@executor-v2/runtime-cloudflare-worker-loader";
import { makeDenoSubprocessRuntimeAdapter } from "@executor-v2/runtime-deno-subprocess";
import { makeLocalInProcessRuntimeAdapter } from "@executor-v2/runtime-local-inproc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { webServerEnvironment } from "../env/server";

const isPlanetScalePostgresUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:")
      && parsed.hostname.endsWith(".pg.psdb.cloud")
    );
  } catch {
    return false;
  }
};

const deriveRuntimeDatabaseUrl = (value: string): string => {
  const configuredTarget = webServerEnvironment.controlPlanePostgresConnectionTarget;

  if (configuredTarget === "direct") {
    return value;
  }

  const shouldPreferPgbouncer =
    configuredTarget === "pgbouncer"
    || (configuredTarget === undefined && webServerEnvironment.nodeEnv === "production");

  if (!shouldPreferPgbouncer || !isPlanetScalePostgresUrl(value)) {
    return value;
  }

  try {
    const parsed = new URL(value);
    const port = parsed.port.length > 0 ? parsed.port : "5432";

    if (port !== "5432") {
      return value;
    }

    parsed.port = "6432";
    return parsed.toString();
  } catch {
    return value;
  }
};

const defaultControlPlaneStateRootDir = ".executor-v2/web-state";
const defaultControlPlaneDataDir = `${defaultControlPlaneStateRootDir}/control-plane-pgdata`;

type ControlPlaneRuntime = {
  persistence: SqlControlPlanePersistence;
  sourceStore: SourceStore;
  toolArtifactStore: ToolArtifactStore;
  fetchOpenApiDocument: typeof fetchOpenApiDocument;
  handleControlPlane: (request: Request) => Promise<Response>;
  handleMcp: (request: Request, workspaceId: string) => Promise<Response>;
  handleAdminMcp: (request: Request, workspaceId: string) => Promise<Response>;
  handleRuntimeToolCall: (request: Request) => Promise<Response>;
  executeRun: (input: ExecuteRunInput, workspaceId: string) => Promise<ExecuteRunResult>;
  dispose: () => Promise<void>;
};

type ControlPlanePrincipal = {
  accountId: string;
  provider: "local" | "workos" | "service";
  subject: string;
  email: string | null;
  displayName: string | null;
  organizationId: string;
  workspaceId: string;
};

type RuntimeToolCallRequest = {
  runId: string;
  callId: string;
  toolPath: string;
  input?: Record<string, unknown>;
};

type RuntimeToolCallResult =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      kind: "pending";
      interactionId: string;
      retryAfterMs: number;
      error?: string;
    }
  | {
      ok: false;
      kind: "denied";
      error: string;
    }
  | {
      ok: false;
      kind: "failed";
      error: string;
    };

const normalizeIdPart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");

const toAccountScopedIds = (subject: string) => {
  const normalized = normalizeIdPart(subject);

  return {
    accountId: `acct_${normalized}`,
    organizationId: `org_${normalized}`,
    workspaceId: `ws_${normalized}`,
  };
};

const resolveDatabaseUrl = (): string | undefined => {
  const value = webServerEnvironment.databaseUrl;
  return value ? deriveRuntimeDatabaseUrl(value) : undefined;
};

const resolveControlPlaneDataDir = (): string =>
  defaultControlPlaneDataDir;

const resolveStateRootDir = (): string =>
  defaultControlPlaneStateRootDir;

const openApiSyncRetryDelayMs = 300;
const runtimeToolCallRetentionMs = 15 * 60 * 1000;
const runtimeExecutorSourceId = "src_executor_control_plane" as SourceId;

const trimTrailingSlash = (value: string): string =>
  value.replace(/\/+$/, "");

const normalizeHttpBaseUrl = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return trimTrailingSlash(parsed.toString());
  } catch {
    return null;
  }
};

const buildRuntimeExecutorSource = (
  workspaceId: string,
  controlPlaneBaseUrl: string,
): Source => {
  const now = Date.now();
  const baseUrl = trimTrailingSlash(controlPlaneBaseUrl);

  return {
    id: runtimeExecutorSourceId,
    workspaceId: workspaceId as WorkspaceId,
    name: "executor",
    kind: "openapi",
    endpoint: `${baseUrl}/v1/openapi.json`,
    status: "connected",
    enabled: true,
    configJson: JSON.stringify({ baseUrl }),
    sourceHash: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
};

const resolveControlPlaneBaseUrlForRequest = (request: Request): string | null => {
  const fromHeader = normalizeHttpBaseUrl(
    request.headers.get(ExecutorControlPlaneBaseUrlHeader) ?? undefined,
  );
  if (fromHeader) {
    return fromHeader;
  }

  return normalizeHttpBaseUrl(new URL(request.url).origin);
};

const formatCause = (cause: unknown): string => {
  if (cause && typeof cause === "object") {
    const maybeError = cause as {
      message?: unknown;
      details?: unknown;
    };

    const details = typeof maybeError.details === "string" ? maybeError.details.trim() : "";
    const message = typeof maybeError.message === "string" ? maybeError.message.trim() : "";

    if (details.length > 0) {
      return message.length > 0 && message !== details
        ? `${message}: ${details}`
        : details;
    }

    if (message.length > 0) {
      return message;
    }
  }

  if (cause instanceof Error) {
    return cause.message;
  }

  if (typeof cause === "string") {
    return cause;
  }

  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
};

const toFailedRuntimeToolCallResult = (error: string): RuntimeToolCallResult => ({
  ok: false,
  kind: "failed",
  error,
});

const runtimeToolCallErrorResponse = (status: number, error: string): Response =>
  Response.json(toFailedRuntimeToolCallResult(error), { status });

const normalizeRuntimeToolCallInput = (
  value: unknown,
): Record<string, unknown> | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
};

const parseRuntimeToolCallRequest = async (
  request: Request,
): Promise<RuntimeToolCallRequest | null> => {
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  if (
    typeof record.runId !== "string"
    || typeof record.callId !== "string"
    || typeof record.toolPath !== "string"
  ) {
    return null;
  }

  return {
    runId: record.runId,
    callId: record.callId,
    toolPath: record.toolPath,
    input: normalizeRuntimeToolCallInput(record.input),
  };
};

const ensurePrincipalProvisioned = (
  persistence: SqlControlPlanePersistence,
  principal: ControlPlanePrincipal,
) =>
  Effect.gen(function* () {
    const now = Date.now();
    const [organizationOption, membershipOption, workspaceOption, profileOption] = yield* Effect.all([
      persistence.rows.organizations.getById(principal.organizationId as Organization["id"]),
      persistence.rows.organizationMemberships.getByOrganizationAndAccount(
        principal.organizationId as OrganizationMembership["organizationId"],
        principal.accountId as OrganizationMembership["accountId"],
      ),
      persistence.rows.workspaces.getById(principal.workspaceId as Workspace["id"]),
      persistence.rows.profile.get(),
    ]);

    if (organizationOption._tag === "None") {
      yield* persistence.rows.organizations.upsert({
        id: principal.organizationId as Organization["id"],
        slug: principal.organizationId,
        name: principal.displayName
          ? `${principal.displayName}'s Organization`
          : principal.organizationId,
        status: "active",
        createdByAccountId: principal.accountId as Organization["createdByAccountId"],
        createdAt: now,
        updatedAt: now,
      });
    }

    if (membershipOption._tag === "None") {
      yield* persistence.rows.organizationMemberships.upsert({
        id: `org_member_${crypto.randomUUID()}` as OrganizationMembership["id"],
        organizationId: principal.organizationId as OrganizationMembership["organizationId"],
        accountId: principal.accountId as OrganizationMembership["accountId"],
        role: "owner",
        status: "active",
        billable: false,
        invitedByAccountId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (workspaceOption._tag === "None") {
      yield* persistence.rows.workspaces.upsert({
        id: principal.workspaceId as Workspace["id"],
        organizationId: principal.organizationId as Workspace["organizationId"],
        name: principal.displayName
          ? `${principal.displayName}'s Workspace`
          : principal.workspaceId,
        createdByAccountId: principal.accountId as Workspace["createdByAccountId"],
        createdAt: now,
        updatedAt: now,
      });
    }

    const existingProfile = profileOption._tag === "Some" ? profileOption.value : null;

    if (
      existingProfile === null
      || existingProfile.defaultWorkspaceId !== principal.workspaceId
      || existingProfile.displayName !== (principal.displayName ?? existingProfile.displayName)
    ) {
      yield* persistence.rows.profile.upsert({
        id: existingProfile?.id ?? ("profile_local" as Profile["id"]),
        defaultWorkspaceId: principal.workspaceId as Profile["defaultWorkspaceId"],
        displayName: principal.displayName ?? existingProfile?.displayName ?? "Local",
        runtimeMode: existingProfile?.runtimeMode ?? "local",
        createdAt: existingProfile?.createdAt ?? now,
        updatedAt: now,
      });
    }
  });

let runtimePromise: Promise<ControlPlaneRuntime> | undefined;

const createControlPlaneRuntime = async (): Promise<ControlPlaneRuntime> => {
  const stateRootDir = resolveStateRootDir();
  const runtimeDatabaseUrl = resolveDatabaseUrl();

  const persistence = await Effect.runPromise(
    makeSqlControlPlanePersistence({
      databaseUrl: runtimeDatabaseUrl,
      localDataDir: resolveControlPlaneDataDir(),
      postgresApplicationName: "executor-v2-web",
    }),
  );

  const sourceStore = persistence.sourceStore;
  const toolArtifactStore = persistence.toolArtifactStore;
  const configuredSecretBackend = parseSecretMaterialBackendKind(
    webServerEnvironment.controlPlaneSecretMaterialBackend,
  );
  const secretMaterialBackend = configuredSecretBackend ?? (runtimeDatabaseUrl ? "sql" : "keychain");
  const secretMaterialStore = secretMaterialBackend === "sql"
    ? createSqlSecretMaterialStore(persistence.rows.secretMaterials)
    : createKeychainSecretMaterialStore();
  const runtimeAdapterList = [
    makeCloudflareWorkerLoaderRuntimeAdapter(),
    makeDenoSubprocessRuntimeAdapter(),
    makeLocalInProcessRuntimeAdapter(),
  ];
  const runtimeAdapters = makeRuntimeAdapterRegistry(runtimeAdapterList);
  const defaultRuntimeKind =
    webServerEnvironment.executorRuntimeKind
    ?? runtimeAdapterList[0]?.kind
    ?? "local-inproc";
  const requireToolInteractions = webServerEnvironment.executorRuntimeRequireToolInteractions;
  const defaultToolExposureMode =
    parseExecuteToolExposureMode(webServerEnvironment.executorRuntimeToolExposureMode)
    ?? defaultExecuteToolExposureMode;
  const toolProviderRegistry = makeToolProviderRegistry([
    makeOpenApiToolProvider(),
    makeMcpToolProvider(),
    makeGraphqlToolProvider(),
  ]);
  const persistentInteractionPolicy = createRuntimeHostPersistentToolInteractionPolicy(
    persistence.rows,
    {
      requireInteractions: requireToolInteractions,
    },
  );
  const resolveCredentials = createRuntimeHostResolveToolCredentials(
    persistence.rows,
    secretMaterialStore,
  );
  const mcpSessions = new Map<string, {
    handler: (request: Request) => Promise<Response>;
    executeRun: (input: ExecuteRunInput) => Effect.Effect<ExecuteRunResult>;
    toolRegistry: ReturnType<typeof createSourceToolRegistry>;
    runtimeToolCallHandler: ReturnType<typeof createRuntimeToolCallHandler>;
  }>();
  const workspaceByRunId = new Map<string, string>();
  const runCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const sourceCatalog = makeSourceCatalogService(sourceStore);
  const sourceManager = makeSourceManagerService(toolArtifactStore);
  const baseSourcesService = makeControlPlaneSourcesService(sourceCatalog);
  const credentialsService = createRuntimeHostCredentialsService(
    persistence.rows,
    secretMaterialStore,
  );

  const fetchOpenApiSpec = (endpoint: string) =>
    Effect.tryPromise({
      try: () => fetchOpenApiDocument(endpoint),
      catch: (cause) => String(cause),
    }).pipe(Effect.either);

  const refreshOpenApiTools = (input: {
    source: Parameters<typeof sourceManager.refreshOpenApiArtifact>[0]["source"];
    openApiSpec: unknown;
  }) =>
    sourceManager.refreshOpenApiArtifact(input).pipe(Effect.either);

  const runWithSingleRetry = <T extends { _tag: string }>(
    run: () => Effect.Effect<T>,
  ): Effect.Effect<T> =>
    Effect.gen(function* () {
      let result = yield* run();
      if (result._tag === "Left") {
        yield* Effect.sleep(openApiSyncRetryDelayMs);
        result = yield* run();
      }

      return result;
    });

  const persistSourceErrorState = (source: Parameters<typeof sourceStore.upsert>[0], message: string) => {
    const failedSource = {
      ...source,
      status: "error" as const,
      lastError: message,
      updatedAt: Date.now(),
    };

    return sourceStore.upsert(failedSource).pipe(
      Effect.as(failedSource),
      Effect.catchAll(() => Effect.succeed(failedSource)),
    );
  };

  const sourcesService = {
    ...baseSourcesService,
    upsertSource: (input: Parameters<typeof baseSourcesService.upsertSource>[0]) =>
      Effect.gen(function* () {
        const source = yield* baseSourcesService.upsertSource(input);

        if (source.kind !== "openapi") {
          return source;
        }

        const openApiSpecResult = yield* runWithSingleRetry(() =>
          fetchOpenApiSpec(source.endpoint),
        );

        if (openApiSpecResult._tag === "Left") {
          const details = formatCause(openApiSpecResult.left);
          const message = `Failed fetching OpenAPI document: ${details}`;
          console.error("[control-plane] openapi fetch failed", {
            sourceId: source.id,
            workspaceId: source.workspaceId,
            endpoint: source.endpoint,
            details,
          });

          return yield* persistSourceErrorState(source, message);
        }

        const refreshedResult = yield* runWithSingleRetry(() =>
          refreshOpenApiTools({
            source,
            openApiSpec: openApiSpecResult.right,
          }),
        );

        if (refreshedResult._tag === "Left") {
          const details = formatCause(refreshedResult.left);
          const message = `Failed extracting OpenAPI tools: ${details}`;
          console.error("[control-plane] openapi extraction failed", {
            sourceId: source.id,
            workspaceId: source.workspaceId,
            endpoint: source.endpoint,
            details,
          });

          return yield* persistSourceErrorState(source, message);
        }

        const refreshedSource = {
          ...source,
          status: "connected" as const,
          sourceHash: refreshedResult.right.manifest.sourceHash,
          lastError: null,
          updatedAt: Date.now(),
        };

        yield* sourceStore.upsert(refreshedSource).pipe(Effect.ignore);

        return refreshedSource;
      }),
  };

  const interactionsService = createRuntimeHostInteractionsService(
    persistence.rows,
    sourceStore,
    credentialsService,
  );

  const controlPlaneService = makeControlPlaneService({
    sources: sourcesService,
    credentials: credentialsService,
    policies: createRuntimeHostPoliciesService(persistence.rows),
    organizations: createRuntimeHostOrganizationsService(persistence.rows),
    workspaces: createRuntimeHostWorkspacesService(persistence.rows),
    tools: createRuntimeHostToolsService(sourceStore, toolArtifactStore),
    storage: createRuntimeHostStorageService(persistence.rows, {
      stateRootDir,
    }),
    interactions: interactionsService,
  });

  const controlPlaneWebHandler = makeControlPlaneWebHandler(
    Layer.succeed(ControlPlaneService, controlPlaneService),
    RuntimeHostActorLive(persistence.rows),
  );
  const adminMcpHandler = createRuntimeHostAdminMcpHandler({
    interactions: interactionsService,
  });

  const rememberRunWorkspace = (runId: string, workspaceId: string): void => {
    workspaceByRunId.set(runId, workspaceId);

    const existingTimer = runCleanupTimers.get(runId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      workspaceByRunId.delete(runId);
      runCleanupTimers.delete(runId);
    }, runtimeToolCallRetentionMs);

    runCleanupTimers.set(runId, timer);
  };

  const createWorkspaceRunExecutor = (
    workspaceId: string,
    toolRegistry: ReturnType<typeof createSourceToolRegistry>,
  ) => {
    const executeRuntimeRun = createRuntimeHostExecuteRuntimeRun({
      defaultRuntimeKind,
      runtimeAdapters,
      toolRegistry,
    });

    return createRunExecutor(executeRuntimeRun, {
      makeRunId: () => {
        const runId = `run_${crypto.randomUUID()}`;
        rememberRunWorkspace(runId, workspaceId);
        return runId;
      },
    });
  };

  const resolveMcpSession = (workspaceId: string): {
    handler: (request: Request) => Promise<Response>;
    executeRun: (input: ExecuteRunInput) => Effect.Effect<ExecuteRunResult>;
    toolRegistry: ReturnType<typeof createSourceToolRegistry>;
    runtimeToolCallHandler: ReturnType<typeof createRuntimeToolCallHandler>;
  } => {
    const existing = mcpSessions.get(workspaceId);
    if (existing) {
      return existing;
    }

    const toolRegistry = createSourceToolRegistry({
      workspaceId,
      sourceStore,
      toolArtifactStore,
      toolProviderRegistry,
      interactionPolicy: persistentInteractionPolicy,
    });
    const runExecutor = createWorkspaceRunExecutor(workspaceId, toolRegistry);
    const next = createRuntimeHostMcpHandler(runExecutor.executeRun, {
      toolRegistry,
      defaultToolExposureMode,
    });

    const session = {
      handler: next,
      executeRun: runExecutor.executeRun,
      toolRegistry,
      runtimeToolCallHandler: createRuntimeToolCallHandler({
        resolveCredentials,
        invokeRuntimeTool: ({ request, credentials }) => {
          const sourceId = sourceIdFromToolPath(request.toolPath);
          const requestWithCredentialContext = request.credentialContext || !sourceId
            ? request
            : {
              ...request,
              credentialContext: {
                workspaceId,
                sourceKey: `source:${sourceId}`,
              },
            };

          return invokeRuntimeToolCallResult(toolRegistry, {
            ...requestWithCredentialContext,
            credentialHeaders: credentials.headers,
          }).pipe(
            Effect.mapError(
              (error) =>
                new RuntimeToolInvokerError({
                  operation: "invoke_runtime_tool",
                  message: error.message,
                  details: error.details,
                }),
            ),
          );
        },
      }),
    };

    mcpSessions.set(workspaceId, session);
    return session;
  };

  const resolveToolRegistryForContext = async (
    workspaceId: string,
    context: ExecuteRunInput["context"] | undefined,
    fallback: ReturnType<typeof createSourceToolRegistry>,
  ): Promise<ReturnType<typeof createSourceToolRegistry>> => {
    const controlPlaneBaseUrl = normalizeHttpBaseUrl(context?.controlPlaneBaseUrl);
    if (!controlPlaneBaseUrl) {
      return fallback;
    }

    const runtimeSource = buildRuntimeExecutorSource(workspaceId, controlPlaneBaseUrl);
    const artifactKey = `${runtimeSource.workspaceId}:${runtimeSource.id}`;
    const runtimeArtifacts = new Map<string, ToolArtifact>();

    const overlaySourceStore: SourceStore = {
      getById: (workspaceIdValue, sourceIdValue) => {
        if (workspaceIdValue === runtimeSource.workspaceId && sourceIdValue === runtimeSource.id) {
          return Effect.succeed(Option.some(runtimeSource));
        }

        return sourceStore.getById(workspaceIdValue, sourceIdValue);
      },
      listByWorkspace: (workspaceIdValue) =>
        sourceStore.listByWorkspace(workspaceIdValue).pipe(
          Effect.map((sources) => {
            if (workspaceIdValue !== runtimeSource.workspaceId) {
              return sources;
            }

            const withoutRuntimeSource = sources.filter((source) => source.id !== runtimeSource.id);
            return [...withoutRuntimeSource, runtimeSource];
          }),
        ),
      upsert: (source) => sourceStore.upsert(source),
      removeById: (workspaceIdValue, sourceIdValue) =>
        sourceStore.removeById(workspaceIdValue, sourceIdValue),
    };

    const overlayToolArtifactStore: ToolArtifactStore = {
      getBySource: (workspaceIdValue, sourceIdValue) => {
        if (workspaceIdValue === runtimeSource.workspaceId && sourceIdValue === runtimeSource.id) {
          const artifact = runtimeArtifacts.get(artifactKey);
          return Effect.succeed(artifact ? Option.some(artifact) : Option.none());
        }

        return toolArtifactStore.getBySource(workspaceIdValue, sourceIdValue);
      },
      upsert: (artifact) => {
        if (artifact.workspaceId === runtimeSource.workspaceId && artifact.sourceId === runtimeSource.id) {
          return Effect.sync(() => {
            runtimeArtifacts.set(artifactKey, artifact);
          });
        }

        return toolArtifactStore.upsert(artifact);
      },
    };

    const overlaySourceManager = makeSourceManagerService(overlayToolArtifactStore);
    const refreshResult = await Effect.runPromise(
      overlaySourceManager.refreshOpenApiArtifact({
        source: runtimeSource,
        openApiSpec: controlPlaneOpenApiSpec,
      }).pipe(Effect.either),
    );

    if (refreshResult._tag === "Left") {
      console.error("[control-plane] runtime executor source refresh failed", {
        workspaceId,
        controlPlaneBaseUrl,
        details: formatCause(refreshResult.left),
      });
      return fallback;
    }

    return createSourceToolRegistry({
      workspaceId,
      sourceStore: overlaySourceStore,
      toolArtifactStore: overlayToolArtifactStore,
      toolProviderRegistry,
      interactionPolicy: persistentInteractionPolicy,
    });
  };

  return {
    persistence,
    sourceStore,
    toolArtifactStore,
    fetchOpenApiDocument,
    handleControlPlane: controlPlaneWebHandler.handler,
    handleMcp: async (request, workspaceId) => {
      const session = resolveMcpSession(workspaceId);
      const toolRegistry = await resolveToolRegistryForContext(
        workspaceId,
        {
          controlPlaneBaseUrl: resolveControlPlaneBaseUrlForRequest(request) ?? undefined,
        },
        session.toolRegistry,
      );

      if (toolRegistry === session.toolRegistry) {
        return session.handler(request);
      }

      const runExecutor = createWorkspaceRunExecutor(workspaceId, toolRegistry);
      const dynamicHandler = createRuntimeHostMcpHandler(runExecutor.executeRun, {
        toolRegistry,
        defaultToolExposureMode,
      });

      return dynamicHandler(request);
    },
    handleAdminMcp: async (request, _workspaceId) => {
      return adminMcpHandler(request);
    },
    executeRun: async (input, workspaceId) => {
      const session = resolveMcpSession(workspaceId);
      const toolRegistry = await resolveToolRegistryForContext(
        workspaceId,
        input.context,
        session.toolRegistry,
      );

      if (toolRegistry === session.toolRegistry) {
        return Effect.runPromise(session.executeRun(input));
      }

      const runExecutor = createWorkspaceRunExecutor(workspaceId, toolRegistry);
      return Effect.runPromise(runExecutor.executeRun(input));
    },
    handleRuntimeToolCall: async (request) => {
      if (request.method.toUpperCase() !== "POST") {
        return runtimeToolCallErrorResponse(405, "Method not allowed. Expected POST");
      }

      const expectedSecret = webServerEnvironment.cloudflareSandboxCallbackSecret;
      if (!expectedSecret) {
        return runtimeToolCallErrorResponse(503, "Runtime callback secret is not configured");
      }

      const providedSecret = request.headers.get("x-internal-secret")?.trim();
      if (!providedSecret) {
        return runtimeToolCallErrorResponse(401, "Runtime callback authentication is required");
      }

      if (providedSecret !== expectedSecret) {
        return runtimeToolCallErrorResponse(403, "Runtime callback authentication failed");
      }

      const input = await parseRuntimeToolCallRequest(request);
      if (!input) {
        return runtimeToolCallErrorResponse(400, "Runtime callback request body is invalid");
      }

      const workspaceId = workspaceByRunId.get(input.runId);
      if (!workspaceId) {
        return runtimeToolCallErrorResponse(404, `Unknown runtime callback run id: ${input.runId}`);
      }

      const session = resolveMcpSession(workspaceId);

      const result = await Effect.runPromise(session.runtimeToolCallHandler(input));

      return Response.json(result, { status: 200 });
    },
    dispose: async () => {
      for (const timer of runCleanupTimers.values()) {
        clearTimeout(timer);
      }
      runCleanupTimers.clear();
      workspaceByRunId.clear();
      mcpSessions.clear();

      await controlPlaneWebHandler.dispose();
      await persistence.close();
    },
  };
};

export const getControlPlaneRuntime = async (): Promise<ControlPlaneRuntime> => {
  if (!runtimePromise) {
    runtimePromise = createControlPlaneRuntime();
  }

  return runtimePromise;
};

export const createWorkosPrincipal = (input: {
  subject: string;
  email: string | null;
  displayName: string | null;
}): ControlPlanePrincipal => {
  const ids = toAccountScopedIds(input.subject);

  return {
    accountId: ids.accountId,
    provider: "workos",
    subject: input.subject,
    email: input.email,
    displayName: input.displayName,
    organizationId: ids.organizationId,
    workspaceId: ids.workspaceId,
  };
};

export const createLocalPrincipal = (): ControlPlanePrincipal => ({
  accountId: "acct_demo",
  provider: "local",
  subject: "local:demo",
  email: null,
  displayName: "Local Demo",
  organizationId: "org_demo",
  workspaceId: "ws_demo",
});

export const applyPrincipalHeaders = (
  request: Request,
  principal: ControlPlanePrincipal,
): Request => {
  const headers = new Headers(request.headers);

  headers.set(ControlPlaneAuthHeaders.accountId, principal.accountId);
  headers.set(ControlPlaneAuthHeaders.principalProvider, principal.provider);
  headers.set(ControlPlaneAuthHeaders.principalSubject, principal.subject);

  if (principal.email) {
    headers.set(ControlPlaneAuthHeaders.principalEmail, principal.email);
  }

  if (principal.displayName) {
    headers.set(ControlPlaneAuthHeaders.principalDisplayName, principal.displayName);
  }

  return new Request(request, { headers });
};

export const provisionPrincipal = async (
  runtime: ControlPlaneRuntime,
  principal: ControlPlanePrincipal,
): Promise<void> => {
  await Effect.runPromise(ensurePrincipalProvisioned(runtime.persistence, principal));
};
