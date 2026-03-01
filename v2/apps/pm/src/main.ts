import * as BunContext from "@effect/platform-bun/BunContext";
import {
  ControlPlaneService,
  makeControlPlaneService,
  makeControlPlaneSourcesService,
  fetchOpenApiDocument,
  makeControlPlaneWebHandler,
  makeSourceCatalogService,
  makeSourceManagerService,
} from "@executor-v2/management-api";
import {
  RuntimeAdapterError,
  makeGraphqlToolProvider,
  makeMcpToolProvider,
  createRunExecutor,
  createSourceToolRegistry,
  defaultExecuteToolExposureMode,
  invokeRuntimeToolCallResult,
  makeOpenApiToolProvider,
  makeRuntimeAdapterRegistry,
  makeToolProviderRegistry,
  parseExecuteToolExposureMode,
} from "@executor-v2/engine";
import {
  makeLocalSourceStore,
  makeLocalStateStore,
  makeLocalToolArtifactStore,
} from "@executor-v2/persistence-local";
import { type RuntimeToolCallResult } from "@executor-v2/sdk";
import { makeCloudflareWorkerLoaderRuntimeAdapter } from "@executor-v2/runtime-cloudflare-worker-loader";
import { makeDenoSubprocessRuntimeAdapter } from "@executor-v2/runtime-deno-subprocess";
import { makeLocalInProcessRuntimeAdapter } from "@executor-v2/runtime-local-inproc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PmActorLive } from "./actor";
import {
  createPmApprovalsService,
  createPmPersistentToolApprovalPolicy,
} from "./approvals-service";
import { startPmHttpServer } from "./http-server";
import { createPmPoliciesService } from "./policies-service";
import { createPmCredentialsService } from "./credentials-service";
import { createPmOrganizationsService } from "./organizations-service";
import { createPmStorageService } from "./storage-service";
import { createPmToolsService } from "./tools-service";
import { createPmWorkspacesService } from "./workspaces-service";
import { createPmMcpHandler } from "./mcp-handler";
import { createPmExecuteRuntimeRun } from "./runtime-execution-port";
import { createPmToolCallHttpHandler } from "./tool-call-handler";

const pmStateRootDir = process.env.PM_STATE_ROOT_DIR ?? ".executor-v2/pm-state";

const parsePort = (value: string | undefined): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8787;
};

const readConfiguredRuntimeKind = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const readConfiguredWorkspaceId = (value: string | undefined): string => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "ws_local";
};

const readBooleanFlag = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

const readConfiguredToolExposureMode = (
  value: string | undefined,
): "all_tools" | "sources_only" =>
  parseExecuteToolExposureMode(value ?? undefined) ??
  defaultExecuteToolExposureMode;

const formatRuntimeAdapterError = (error: RuntimeAdapterError): string =>
  error.details ? `${error.message}: ${error.details}` : error.message;

const port = parsePort(process.env.PORT);
const workspaceId = readConfiguredWorkspaceId(process.env.PM_WORKSPACE_ID);
const requireToolApprovals = readBooleanFlag(process.env.PM_REQUIRE_TOOL_APPROVALS);
const defaultToolExposureMode = readConfiguredToolExposureMode(
  process.env.PM_TOOL_EXPOSURE_MODE,
);

const pmRuntimeAdapters = [
  makeLocalInProcessRuntimeAdapter(),
  makeDenoSubprocessRuntimeAdapter(),
  makeCloudflareWorkerLoaderRuntimeAdapter(),
];

const runtimeAdapters = makeRuntimeAdapterRegistry(pmRuntimeAdapters);
const defaultRuntimeKind =
  readConfiguredRuntimeKind(process.env.PM_RUNTIME_KIND) ?? pmRuntimeAdapters[0].kind;

const sourceStore = await Effect.runPromise(
  makeLocalSourceStore({
    rootDir: pmStateRootDir,
  }).pipe(Effect.provide(BunContext.layer)),
);

const localStateStore = await Effect.runPromise(
  makeLocalStateStore({
    rootDir: pmStateRootDir,
  }).pipe(Effect.provide(BunContext.layer)),
);

const toolArtifactStore = await Effect.runPromise(
  makeLocalToolArtifactStore({
    rootDir: pmStateRootDir,
  }).pipe(Effect.provide(BunContext.layer)),
);

const sourceCatalog = makeSourceCatalogService(sourceStore);
const sourceManager = makeSourceManagerService(toolArtifactStore);
const baseSourcesService = makeControlPlaneSourcesService(sourceCatalog);
const sourcesService = {
  ...baseSourcesService,
  upsertSource: (input: Parameters<typeof baseSourcesService.upsertSource>[0]) =>
    Effect.gen(function* () {
      const source = yield* baseSourcesService.upsertSource(input);

      if (source.kind !== "openapi") {
        return source;
      }

      const openApiSpecResult = yield* Effect.tryPromise({
        try: () => fetchOpenApiDocument(source.endpoint),
        catch: (cause) => String(cause),
      }).pipe(Effect.either);

      if (openApiSpecResult._tag === "Left") {
        return source;
      }

      yield* sourceManager
        .refreshOpenApiArtifact({
          source,
          openApiSpec: openApiSpecResult.right,
        })
        .pipe(Effect.ignore);

      return source;
    }),
};

const credentialsService = createPmCredentialsService(localStateStore);
const policiesService = createPmPoliciesService(localStateStore);
const organizationsService = createPmOrganizationsService(localStateStore);
const workspacesService = createPmWorkspacesService(localStateStore);
const toolsService = createPmToolsService(sourceStore, toolArtifactStore);
const storageService = createPmStorageService(localStateStore, {
  stateRootDir: pmStateRootDir,
});
const approvalsService = createPmApprovalsService(localStateStore);
const controlPlaneService = makeControlPlaneService({
  sources: sourcesService,
  credentials: credentialsService,
  policies: policiesService,
  organizations: organizationsService,
  workspaces: workspacesService,
  tools: toolsService,
  storage: storageService,
  approvals: approvalsService,
});

const controlPlaneWebHandler = makeControlPlaneWebHandler(
  Layer.succeed(ControlPlaneService, controlPlaneService),
  PmActorLive(localStateStore),
);

const toolProviderRegistry = makeToolProviderRegistry([
  makeOpenApiToolProvider(),
  makeMcpToolProvider(),
  makeGraphqlToolProvider(),
]);
const persistentApprovalPolicy = createPmPersistentToolApprovalPolicy(localStateStore, {
  requireApprovals: requireToolApprovals,
});
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
const handleMcp = createPmMcpHandler(runExecutor.executeRun, {
  toolRegistry,
  defaultToolExposureMode,
});

const handleToolCallHttp = createPmToolCallHttpHandler((input) =>
  Effect.runPromise(
    invokeRuntimeToolCallResult(toolRegistry, input).pipe(
      Effect.catchTag("RuntimeAdapterError", (error) =>
        Effect.succeed<RuntimeToolCallResult>({
          ok: false,
          kind: "failed",
          error: formatRuntimeAdapterError(error),
        }),
      ),
    ),
  ),
);

const server = startPmHttpServer({
  port,
  handleMcp,
  handleToolCall: handleToolCallHttp,
  handleControlPlane: controlPlaneWebHandler.handler,
});

const shutdown = async () => {
  server.stop();
  await controlPlaneWebHandler.dispose();
};

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
