import {
  ControlPlaneAuthHeaders,
  ControlPlaneService,
  fetchOpenApiDocument,
  makeControlPlaneService,
  makeControlPlaneSourcesService,
  makeControlPlaneWebHandler,
  makeSourceCatalogService,
  makeSourceManagerService,
} from "@executor-v2/management-api";
import {
  createRunExecutor,
  createSourceToolRegistry,
  defaultExecuteToolExposureMode,
  makeGraphqlToolProvider,
  makeMcpToolProvider,
  makeOpenApiToolProvider,
  makeRuntimeAdapterRegistry,
  makeToolProviderRegistry,
  parseExecuteToolExposureMode,
} from "@executor-v2/engine";
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
  type Workspace,
} from "@executor-v2/schema";
import { makeCloudflareWorkerLoaderRuntimeAdapter } from "@executor-v2/runtime-cloudflare-worker-loader";
import { makeDenoSubprocessRuntimeAdapter } from "@executor-v2/runtime-deno-subprocess";
import { makeLocalInProcessRuntimeAdapter } from "@executor-v2/runtime-local-inproc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { webServerEnvironment } from "../env/server";

import { PmActorLive } from "../../../pm/src/actor";
import {
  createPmApprovalsService,
  createPmPersistentToolApprovalPolicy,
} from "../../../pm/src/approvals-service";
import { createPmCredentialsService } from "../../../pm/src/credentials-service";
import { createPmMcpHandler } from "../../../pm/src/mcp-handler";
import { createPmOrganizationsService } from "../../../pm/src/organizations-service";
import { createPmPoliciesService } from "../../../pm/src/policies-service";
import { createPmExecuteRuntimeRun } from "../../../pm/src/runtime-execution-port";
import { createPmStorageService } from "../../../pm/src/storage-service";
import { createPmToolsService } from "../../../pm/src/tools-service";
import { createPmWorkspacesService } from "../../../pm/src/workspaces-service";

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

  const persistence = await Effect.runPromise(
    makeSqlControlPlanePersistence({
      databaseUrl: resolveDatabaseUrl(),
      localDataDir: resolveControlPlaneDataDir(),
      postgresApplicationName: "executor-v2-web",
    }),
  );

  const sourceStore = persistence.sourceStore;
  const toolArtifactStore = persistence.toolArtifactStore;
  const runtimeAdapterList = [
    // makeLocalInProcessRuntimeAdapter(),
    makeCloudflareWorkerLoaderRuntimeAdapter(),
    makeDenoSubprocessRuntimeAdapter(),
  ];
  const runtimeAdapters = makeRuntimeAdapterRegistry(runtimeAdapterList);
  const defaultRuntimeKind =
    webServerEnvironment.pmRuntimeKind
    ?? runtimeAdapterList[0]?.kind
    ?? "local-inproc";
  const requireToolApprovals = webServerEnvironment.pmRequireToolApprovals;
  const defaultToolExposureMode =
    parseExecuteToolExposureMode(webServerEnvironment.pmToolExposureMode)
    ?? defaultExecuteToolExposureMode;
  const toolProviderRegistry = makeToolProviderRegistry([
    makeOpenApiToolProvider(),
    makeMcpToolProvider(),
    makeGraphqlToolProvider(),
  ]);
  const persistentApprovalPolicy = createPmPersistentToolApprovalPolicy(
    persistence.rows,
    {
      requireApprovals: requireToolApprovals,
    },
  );
  const mcpHandlers = new Map<
    string,
    (request: Request) => Promise<Response>
  >();

  const sourceCatalog = makeSourceCatalogService(sourceStore);
  const sourceManager = makeSourceManagerService(toolArtifactStore);
  const baseSourcesService = makeControlPlaneSourcesService(sourceCatalog);

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

  const controlPlaneService = makeControlPlaneService({
    sources: sourcesService,
    credentials: createPmCredentialsService(persistence.rows),
    policies: createPmPoliciesService(persistence.rows),
    organizations: createPmOrganizationsService(persistence.rows),
    workspaces: createPmWorkspacesService(persistence.rows),
    tools: createPmToolsService(sourceStore, toolArtifactStore),
    storage: createPmStorageService(persistence.rows, {
      stateRootDir,
    }),
    approvals: createPmApprovalsService(persistence.rows),
  });

  const controlPlaneWebHandler = makeControlPlaneWebHandler(
    Layer.succeed(ControlPlaneService, controlPlaneService),
    PmActorLive(persistence.rows),
  );

  const resolveMcpHandler = (workspaceId: string): ((request: Request) => Promise<Response>) => {
    const existing = mcpHandlers.get(workspaceId);
    if (existing) {
      return existing;
    }

    const toolRegistry = createSourceToolRegistry({
      workspaceId,
      sourceStore,
      toolArtifactStore,
      toolProviderRegistry,
      approvalPolicy: persistentApprovalPolicy,
    });
    const executeRuntimeRun = createPmExecuteRuntimeRun({
      defaultRuntimeKind,
      runtimeAdapters,
      toolRegistry,
    });
    const runExecutor = createRunExecutor(executeRuntimeRun);
    const next = createPmMcpHandler(runExecutor.executeRun, {
      toolRegistry,
      defaultToolExposureMode,
    });

    mcpHandlers.set(workspaceId, next);
    return next;
  };

  return {
    persistence,
    sourceStore,
    toolArtifactStore,
    fetchOpenApiDocument,
    handleControlPlane: controlPlaneWebHandler.handler,
    handleMcp: async (request, workspaceId) => {
      const handler = resolveMcpHandler(workspaceId);
      return handler(request);
    },
    dispose: async () => {
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
