import { toTool, type ToolMap } from "@executor/codemode-core";
import type { Executor } from "@executor/platform-sdk";
import {
  type AccountId,
  LocalInstallationSchema,
  LocalWorkspacePolicySchema,
  SourceDiscoveryResultSchema,
  SourceIdSchema,
  SourceInspectionDiscoverPayloadSchema,
  SourceInspectionDiscoverResultSchema,
  SourceInspectionSchema,
  SourceInspectionToolDetailSchema,
  SourceSchema,
  type WorkspaceId,
  WorkspaceOauthClientSchema,
} from "@executor/platform-sdk/schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  ExecutorStateStore,
  LocalInstanceConfigService,
  SecretMaterialDeleterService,
  SecretMaterialStorerService,
  SecretMaterialUpdaterService,
  type ExecutorStateStoreShape,
  type WorkspaceInternalToolContext,
  RuntimeSourceAuthService,
  RuntimeSourceCatalogSyncService,
  RuntimeSourceStore,
  RuntimeSourceStoreService,
} from "@executor/platform-sdk/runtime";
import {
  type RuntimeLocalWorkspaceState,
  provideOptionalRuntimeLocalWorkspace,
} from "../../../sdk/src/runtime/workspace/runtime-context";
import {
  SourceArtifactStore,
  type SourceArtifactStoreShape,
  WorkspaceConfigStore,
  type WorkspaceConfigStoreShape,
  WorkspaceStateStore,
  type WorkspaceStateStoreShape,
  makeWorkspaceStorageLayer,
} from "../../../sdk/src/runtime/workspace/storage";
import {
  CreateSecretPayloadSchema,
  CreateSecretResultSchema,
  type CreateSecretPayload,
  DeleteSecretResultSchema,
  InstanceConfigSchema,
  SecretListItemSchema,
  UpdateSecretPayloadSchema,
  UpdateSecretResultSchema,
  type UpdateSecretPayload,
} from "@executor/platform-sdk/contracts";
import {
  createLocalSecret,
  createPolicy,
  deleteLocalSecret,
  discoverSource,
  discoverSourceInspectionTools,
  getPolicy,
  getSource,
  getSourceInspection,
  getSourceInspectionToolDetail,
  listLocalSecrets,
  listPolicies,
  listSources,
  removePolicy,
  removeSource,
  updateLocalSecret,
  updatePolicy,
  updateSource,
} from "@executor/platform-sdk/operations";
import {
  CreatePolicyPayloadSchema,
  type CreatePolicyPayload,
  type UpdatePolicyPayload,
  UpdatePolicyPayloadSchema,
} from "@executor/platform-sdk/contracts";
import {
  CreateWorkspaceOauthClientPayloadSchema,
  DiscoverSourcePayloadSchema,
  type CreateWorkspaceOauthClientPayload,
  UpdateSourcePayloadSchema,
} from "@executor/platform-sdk/contracts";

const emptyInputSchema = Schema.standardSchemaV1(Schema.Struct({}));
const localInstallationOutputSchema = Schema.standardSchemaV1(
  LocalInstallationSchema,
);
const instanceConfigOutputSchema =
  Schema.standardSchemaV1(InstanceConfigSchema);
const secretListOutputSchema = Schema.standardSchemaV1(
  Schema.Array(SecretListItemSchema),
);
const createSecretInputSchema = Schema.standardSchemaV1(
  CreateSecretPayloadSchema,
);
const updateSecretInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    secretId: Schema.String,
    payload: UpdateSecretPayloadSchema,
  }),
);
const removeSecretInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    secretId: Schema.String,
  }),
);
const removeResultSchema = Schema.standardSchemaV1(
  Schema.Struct({
    removed: Schema.Boolean,
  }),
);
const listSourcesOutputSchema = Schema.standardSchemaV1(
  Schema.Array(SourceSchema),
);
const getSourceInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    sourceId: SourceIdSchema,
  }),
);
const updateSourceInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    sourceId: SourceIdSchema,
    payload: UpdateSourcePayloadSchema,
  }),
);
const discoverSourceInputSchema = Schema.standardSchemaV1(
  DiscoverSourcePayloadSchema,
);
const inspectToolInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    sourceId: SourceIdSchema,
    toolPath: Schema.String,
  }),
);
const inspectDiscoverInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    sourceId: SourceIdSchema,
    payload: SourceInspectionDiscoverPayloadSchema,
  }),
);
const listPoliciesOutputSchema = Schema.standardSchemaV1(
  Schema.Array(LocalWorkspacePolicySchema),
);
const policyIdInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    policyId: Schema.String,
  }),
);
const createPolicyInputSchema = Schema.standardSchemaV1(
  CreatePolicyPayloadSchema,
);
const updatePolicyInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    policyId: Schema.String,
    payload: UpdatePolicyPayloadSchema,
  }),
);
const workspaceOauthClientListInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    providerKey: Schema.String,
  }),
);
const workspaceOauthClientListOutputSchema = Schema.standardSchemaV1(
  Schema.Array(WorkspaceOauthClientSchema),
);
const createWorkspaceOauthClientInputSchema = Schema.standardSchemaV1(
  CreateWorkspaceOauthClientPayloadSchema,
);
const removeWorkspaceOauthClientInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    oauthClientId: Schema.String,
  }),
);
const removeProviderGrantInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    grantId: Schema.String,
  }),
);
const sourceOutputSchema = Schema.standardSchemaV1(SourceSchema);
const sourceInspectionOutputSchema = Schema.standardSchemaV1(
  SourceInspectionSchema,
);
const sourceInspectionToolOutputSchema = Schema.standardSchemaV1(
  SourceInspectionToolDetailSchema,
);
const sourceInspectionDiscoverOutputSchema = Schema.standardSchemaV1(
  SourceInspectionDiscoverResultSchema,
);
const sourceDiscoveryOutputSchema = Schema.standardSchemaV1(
  SourceDiscoveryResultSchema,
);
const localWorkspacePolicyOutputSchema = Schema.standardSchemaV1(
  LocalWorkspacePolicySchema,
);

const makeRuntimeLayer = (input: {
  executorStateStore: ExecutorStateStoreShape;
  sourceStore: RuntimeSourceStore;
  sourceCatalogSyncService: Effect.Effect.Success<
    typeof RuntimeSourceCatalogSyncService
  >;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  instanceConfigResolver: WorkspaceInternalToolContext["instanceConfigResolver"];
  storeSecretMaterial: WorkspaceInternalToolContext["storeSecretMaterial"];
  deleteSecretMaterial: WorkspaceInternalToolContext["deleteSecretMaterial"];
  updateSecretMaterial: WorkspaceInternalToolContext["updateSecretMaterial"];
}) =>
  Layer.mergeAll(
    Layer.succeed(ExecutorStateStore, input.executorStateStore),
    Layer.succeed(RuntimeSourceStoreService, input.sourceStore),
    Layer.succeed(
      RuntimeSourceCatalogSyncService,
      input.sourceCatalogSyncService,
    ),
    Layer.succeed(LocalInstanceConfigService, input.instanceConfigResolver),
    Layer.succeed(SecretMaterialStorerService, input.storeSecretMaterial),
    Layer.succeed(SecretMaterialDeleterService, input.deleteSecretMaterial),
    Layer.succeed(SecretMaterialUpdaterService, input.updateSecretMaterial),
    makeWorkspaceStorageLayer({
      workspaceConfigStore: input.workspaceConfigStore,
      workspaceStateStore: input.workspaceStateStore,
      sourceArtifactStore: input.sourceArtifactStore,
    }),
  );

const runRuntimeEffect = <A, E, R>(input: {
  effect: Effect.Effect<A, E, R>;
  runtimeLayer: Layer.Layer<
    | ExecutorStateStore
    | LocalInstanceConfigService
    | RuntimeSourceStoreService
    | RuntimeSourceCatalogSyncService
    | SecretMaterialStorerService
    | SecretMaterialDeleterService
    | SecretMaterialUpdaterService
    | WorkspaceConfigStore
    | WorkspaceStateStore
    | SourceArtifactStore,
    never,
    never
  >;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null;
}) =>
  Effect.runPromise(
    provideOptionalRuntimeLocalWorkspace(
      input.effect.pipe(Effect.provide(input.runtimeLayer)),
      input.runtimeLocalWorkspace,
    ) as Effect.Effect<A, E, never>,
  );

const runWorkspaceStorageEffect = <A, E, R>(input: {
  effect: Effect.Effect<A, E, R>;
  workspaceStorageLayer: Layer.Layer<
    WorkspaceConfigStore | WorkspaceStateStore | SourceArtifactStore,
    never,
    never
  >;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null;
}) =>
  Effect.runPromise(
    provideOptionalRuntimeLocalWorkspace(
      input.effect.pipe(Effect.provide(input.workspaceStorageLayer)),
      input.runtimeLocalWorkspace,
    ) as Effect.Effect<A, E, never>,
  );

export const createWorkspaceExecutorAdminToolMap = (
  input: WorkspaceInternalToolContext,
): ToolMap => {
  const runtimeLayer = makeRuntimeLayer({
    executorStateStore: input.executorStateStore,
    sourceStore: input.sourceStore,
    sourceCatalogSyncService: input.sourceCatalogSyncService,
    workspaceConfigStore: input.workspaceConfigStore,
    workspaceStateStore: input.workspaceStateStore,
    sourceArtifactStore: input.sourceArtifactStore,
    instanceConfigResolver: input.instanceConfigResolver,
    storeSecretMaterial: input.storeSecretMaterial,
    deleteSecretMaterial: input.deleteSecretMaterial,
    updateSecretMaterial: input.updateSecretMaterial,
  });
  const workspaceStorageLayer = makeWorkspaceStorageLayer({
    workspaceConfigStore: input.workspaceConfigStore,
    workspaceStateStore: input.workspaceStateStore,
    sourceArtifactStore: input.sourceArtifactStore,
  });

  const metadata = {
    sourceKey: "executor",
    interaction: "auto" as const,
  };

  return {
    "executor.local.installation.get": toTool({
      tool: {
        description:
          "Get the active local executor installation account and workspace ids.",
        inputSchema: emptyInputSchema,
        outputSchema: localInstallationOutputSchema,
        execute: async () => ({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
        }),
      },
      metadata,
    }),
    "executor.local.config.get": toTool({
      tool: {
        description:
          "Get local instance config such as supported secret providers.",
        inputSchema: emptyInputSchema,
        outputSchema: instanceConfigOutputSchema,
        execute: () => Effect.runPromise(input.instanceConfigResolver()),
      },
      metadata,
    }),
    "executor.secrets.list": toTool({
      tool: {
        description:
          "List locally stored secrets and the sources linked to them.",
        inputSchema: emptyInputSchema,
        outputSchema: secretListOutputSchema,
        execute: () =>
          runRuntimeEffect({
            effect: listLocalSecrets(),
            runtimeLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.secrets.create": toTool({
      tool: {
        description:
          "Create a local secret without putting the raw value into source config.",
        inputSchema: createSecretInputSchema,
        outputSchema: Schema.standardSchemaV1(CreateSecretResultSchema),
        execute: (payload: CreateSecretPayload) =>
          runRuntimeEffect({
            effect: createLocalSecret(payload),
            runtimeLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.secrets.update": toTool({
      tool: {
        description:
          "Update a stored secret name and optionally rotate its value.",
        inputSchema: updateSecretInputSchema,
        outputSchema: Schema.standardSchemaV1(UpdateSecretResultSchema),
        execute: (payload: {
          secretId: string;
          payload: UpdateSecretPayload;
        }) =>
          runRuntimeEffect({
            effect: updateLocalSecret(payload),
            runtimeLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.secrets.remove": toTool({
      tool: {
        description: "Remove a stored local secret.",
        inputSchema: removeSecretInputSchema,
        outputSchema: Schema.standardSchemaV1(DeleteSecretResultSchema),
        execute: ({ secretId }: { secretId: string }) =>
          runRuntimeEffect({
            effect: deleteLocalSecret(secretId),
            runtimeLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.sources.discover": toTool({
      tool: {
        description:
          "Probe a URL and infer whether it looks like MCP, OpenAPI, GraphQL, or another supported source.",
        inputSchema: discoverSourceInputSchema,
        outputSchema: sourceDiscoveryOutputSchema,
        execute: (payload: { url: string; probeAuth?: unknown }) =>
          Effect.runPromise(
            discoverSource({
              url: payload.url,
              probeAuth: payload.probeAuth as never,
            }),
          ),
      },
      metadata,
    }),
    "executor.sources.list": toTool({
      tool: {
        description: "List sources connected in the current workspace.",
        inputSchema: emptyInputSchema,
        outputSchema: listSourcesOutputSchema,
        execute: () =>
          runRuntimeEffect({
            effect: listSources({
              workspaceId: input.workspaceId,
              accountId: input.accountId as never,
            }),
            runtimeLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.sources.get": toTool({
      tool: {
        description: "Get one source by id.",
        inputSchema: getSourceInputSchema,
        outputSchema: sourceOutputSchema,
        execute: ({ sourceId }: { sourceId: string }) =>
          runRuntimeEffect({
            effect: getSource({
              workspaceId: input.workspaceId,
              sourceId: sourceId as never,
              accountId: input.accountId as never,
            }),
            runtimeLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.sources.update": toTool({
      tool: {
        description: "Update a source definition in the current workspace.",
        inputSchema: updateSourceInputSchema,
        outputSchema: sourceOutputSchema,
        execute: (payload: {
          sourceId: string;
          payload: Record<string, unknown>;
        }) =>
          runRuntimeEffect({
            effect: updateSource({
              workspaceId: input.workspaceId,
              sourceId: payload.sourceId as never,
              accountId: input.accountId as never,
              payload: payload.payload as never,
            }),
            runtimeLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.sources.remove": toTool({
      tool: {
        description: "Remove a source from the current workspace.",
        inputSchema: getSourceInputSchema,
        outputSchema: removeResultSchema,
        execute: ({ sourceId }: { sourceId: string }) =>
          runRuntimeEffect({
            effect: removeSource({
              workspaceId: input.workspaceId,
              sourceId: sourceId as never,
            }),
            runtimeLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.sources.inspect.get": toTool({
      tool: {
        description: "Inspect the tool model for one connected source.",
        inputSchema: getSourceInputSchema,
        outputSchema: sourceInspectionOutputSchema,
        execute: ({ sourceId }: { sourceId: string }) =>
          runRuntimeEffect({
            effect: getSourceInspection({
              workspaceId: input.workspaceId,
              sourceId: sourceId as never,
            }),
            runtimeLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.sources.inspect.tool": toTool({
      tool: {
        description: "Inspect one tool inside a connected source.",
        inputSchema: inspectToolInputSchema,
        outputSchema: sourceInspectionToolOutputSchema,
        execute: ({
          sourceId,
          toolPath,
        }: {
          sourceId: string;
          toolPath: string;
        }) =>
          runRuntimeEffect({
            effect: getSourceInspectionToolDetail({
              workspaceId: input.workspaceId,
              sourceId: sourceId as never,
              toolPath,
            }),
            runtimeLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.sources.inspect.discover": toTool({
      tool: {
        description: "Search within a single source's inspected tools.",
        inputSchema: inspectDiscoverInputSchema,
        outputSchema: sourceInspectionDiscoverOutputSchema,
        execute: ({
          sourceId,
          payload,
        }: {
          sourceId: string;
          payload: { query: string; limit?: number };
        }) =>
          runRuntimeEffect({
            effect: discoverSourceInspectionTools({
              workspaceId: input.workspaceId,
              sourceId: sourceId as never,
              payload: payload as never,
            }),
            runtimeLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.sources.oauthClients.list": toTool({
      tool: {
        description: "List workspace OAuth clients for a provider key.",
        inputSchema: workspaceOauthClientListInputSchema,
        outputSchema: workspaceOauthClientListOutputSchema,
        execute: ({ providerKey }: { providerKey: string }) =>
          runWorkspaceStorageEffect({
            effect: input.sourceAuthService.listWorkspaceOauthClients({
              workspaceId: input.workspaceId,
              providerKey,
            }),
            workspaceStorageLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.sources.oauthClients.create": toTool({
      tool: {
        description:
          "Create a workspace OAuth client used for shared provider auth flows.",
        inputSchema: createWorkspaceOauthClientInputSchema,
        outputSchema: Schema.standardSchemaV1(WorkspaceOauthClientSchema),
        execute: (payload: CreateWorkspaceOauthClientPayload) =>
          runWorkspaceStorageEffect({
            effect: input.sourceAuthService.createWorkspaceOauthClient({
              workspaceId: input.workspaceId,
              providerKey: payload.providerKey,
              label: payload.label,
              oauthClient: payload.oauthClient,
            }),
            workspaceStorageLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.sources.oauthClients.remove": toTool({
      tool: {
        description: "Remove a workspace OAuth client.",
        inputSchema: removeWorkspaceOauthClientInputSchema,
        outputSchema: removeResultSchema,
        execute: ({ oauthClientId }: { oauthClientId: string }) =>
          runWorkspaceStorageEffect({
            effect: input.sourceAuthService
              .removeWorkspaceOauthClient({
                workspaceId: input.workspaceId,
                oauthClientId: oauthClientId as never,
              })
              .pipe(Effect.map((removed) => ({ removed }))),
            workspaceStorageLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.sources.providerGrants.remove": toTool({
      tool: {
        description:
          "Revoke a shared provider grant reference from the local workspace.",
        inputSchema: removeProviderGrantInputSchema,
        outputSchema: removeResultSchema,
        execute: ({ grantId }: { grantId: string }) =>
          runWorkspaceStorageEffect({
            effect: input.sourceAuthService
              .removeProviderAuthGrant({
                workspaceId: input.workspaceId,
                grantId: grantId as never,
              })
              .pipe(Effect.map((removed) => ({ removed }))),
            workspaceStorageLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.policies.list": toTool({
      tool: {
        description: "List local workspace policies.",
        inputSchema: emptyInputSchema,
        outputSchema: listPoliciesOutputSchema,
        execute: () =>
          runRuntimeEffect({
            effect: listPolicies(input.workspaceId),
            runtimeLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.policies.create": toTool({
      tool: {
        description: "Create a local workspace policy.",
        inputSchema: createPolicyInputSchema,
        outputSchema: localWorkspacePolicyOutputSchema,
        execute: (payload: CreatePolicyPayload) =>
          runRuntimeEffect({
            effect: createPolicy({
              workspaceId: input.workspaceId,
              payload,
            }),
            runtimeLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.policies.get": toTool({
      tool: {
        description: "Get one local workspace policy by id.",
        inputSchema: policyIdInputSchema,
        outputSchema: localWorkspacePolicyOutputSchema,
        execute: ({ policyId }: { policyId: string }) =>
          runRuntimeEffect({
            effect: getPolicy({
              workspaceId: input.workspaceId,
              policyId: policyId as never,
            }),
            runtimeLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.policies.update": toTool({
      tool: {
        description: "Update a local workspace policy.",
        inputSchema: updatePolicyInputSchema,
        outputSchema: localWorkspacePolicyOutputSchema,
        execute: ({
          policyId,
          payload,
        }: {
          policyId: string;
          payload: UpdatePolicyPayload;
        }) =>
          runRuntimeEffect({
            effect: updatePolicy({
              workspaceId: input.workspaceId,
              policyId: policyId as never,
              payload,
            }),
            runtimeLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
    "executor.policies.remove": toTool({
      tool: {
        description: "Remove a local workspace policy.",
        inputSchema: policyIdInputSchema,
        outputSchema: removeResultSchema,
        execute: ({ policyId }: { policyId: string }) =>
          runRuntimeEffect({
            effect: removePolicy({
              workspaceId: input.workspaceId,
              policyId: policyId as never,
            }),
            runtimeLayer,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          }),
      },
      metadata,
    }),
  };
};

export const createExecutorAdminToolMap = (input: {
  executor: Executor;
}): ToolMap => {
  const metadata = {
    sourceKey: "executor",
    interaction: "auto" as const,
  };

  return {
    "executor.local.installation.get": toTool({
      tool: {
        description:
          "Get the active local executor installation account and workspace ids.",
        inputSchema: emptyInputSchema,
        outputSchema: localInstallationOutputSchema,
        execute: () => Promise.resolve(input.executor.installation),
      },
      metadata,
    }),
    "executor.local.config.get": toTool({
      tool: {
        description:
          "Get local instance config such as supported secret providers.",
        inputSchema: emptyInputSchema,
        outputSchema: instanceConfigOutputSchema,
        execute: () => input.executor.local.config(),
      },
      metadata,
    }),
    "executor.secrets.list": toTool({
      tool: {
        description:
          "List locally stored secrets and the sources linked to them.",
        inputSchema: emptyInputSchema,
        outputSchema: secretListOutputSchema,
        execute: () => input.executor.secrets.list(),
      },
      metadata,
    }),
    "executor.secrets.create": toTool({
      tool: {
        description:
          "Create a local secret without putting the raw value into source config.",
        inputSchema: createSecretInputSchema,
        outputSchema: Schema.standardSchemaV1(CreateSecretResultSchema),
        execute: (payload: CreateSecretPayload) =>
          input.executor.secrets.create(payload),
      },
      metadata,
    }),
    "executor.secrets.update": toTool({
      tool: {
        description:
          "Update a stored secret name and optionally rotate its value.",
        inputSchema: updateSecretInputSchema,
        outputSchema: Schema.standardSchemaV1(UpdateSecretResultSchema),
        execute: (payload: {
          secretId: string;
          payload: UpdateSecretPayload;
        }) => input.executor.secrets.update(payload),
      },
      metadata,
    }),
    "executor.secrets.remove": toTool({
      tool: {
        description: "Remove a stored local secret.",
        inputSchema: removeSecretInputSchema,
        outputSchema: Schema.standardSchemaV1(DeleteSecretResultSchema),
        execute: ({ secretId }: { secretId: string }) =>
          input.executor.secrets.remove(secretId),
      },
      metadata,
    }),
    "executor.sources.discover": toTool({
      tool: {
        description:
          "Probe a URL and infer whether it looks like MCP, OpenAPI, GraphQL, or another supported source.",
        inputSchema: discoverSourceInputSchema,
        outputSchema: sourceDiscoveryOutputSchema,
        execute: (payload: { url: string; probeAuth?: unknown }) =>
          input.executor.sources.discover({
            url: payload.url,
            probeAuth: payload.probeAuth as never,
          }),
      },
      metadata,
    }),
    "executor.sources.list": toTool({
      tool: {
        description: "List sources connected in the current workspace.",
        inputSchema: emptyInputSchema,
        outputSchema: listSourcesOutputSchema,
        execute: () => input.executor.sources.list(),
      },
      metadata,
    }),
    "executor.sources.get": toTool({
      tool: {
        description: "Get one source by id.",
        inputSchema: getSourceInputSchema,
        outputSchema: sourceOutputSchema,
        execute: ({ sourceId }: { sourceId: string }) =>
          input.executor.sources.get(sourceId as never),
      },
      metadata,
    }),
    "executor.sources.update": toTool({
      tool: {
        description: "Update a source definition in the current workspace.",
        inputSchema: updateSourceInputSchema,
        outputSchema: sourceOutputSchema,
        execute: (payload: {
          sourceId: string;
          payload: Record<string, unknown>;
        }) =>
          input.executor.sources.update(
            payload.sourceId as never,
            payload.payload as never,
          ),
      },
      metadata,
    }),
    "executor.sources.remove": toTool({
      tool: {
        description: "Remove a source from the current workspace.",
        inputSchema: getSourceInputSchema,
        outputSchema: removeResultSchema,
        execute: async ({ sourceId }: { sourceId: string }) => ({
          removed: await input.executor.sources.remove(sourceId as never),
        }),
      },
      metadata,
    }),
    "executor.sources.inspect.get": toTool({
      tool: {
        description: "Inspect the tool model for one connected source.",
        inputSchema: getSourceInputSchema,
        outputSchema: sourceInspectionOutputSchema,
        execute: ({ sourceId }: { sourceId: string }) =>
          input.executor.sources.inspection.get(sourceId as never),
      },
      metadata,
    }),
    "executor.sources.inspect.tool": toTool({
      tool: {
        description: "Inspect one tool inside a connected source.",
        inputSchema: inspectToolInputSchema,
        outputSchema: sourceInspectionToolOutputSchema,
        execute: ({
          sourceId,
          toolPath,
        }: {
          sourceId: string;
          toolPath: string;
        }) =>
          input.executor.sources.inspection.tool({
            sourceId: sourceId as never,
            toolPath,
          }),
      },
      metadata,
    }),
    "executor.sources.inspect.discover": toTool({
      tool: {
        description: "Search within a single source's inspected tools.",
        inputSchema: inspectDiscoverInputSchema,
        outputSchema: sourceInspectionDiscoverOutputSchema,
        execute: ({
          sourceId,
          payload,
        }: {
          sourceId: string;
          payload: { query: string; limit?: number };
        }) =>
          input.executor.sources.inspection.discover({
            sourceId: sourceId as never,
            payload: payload as never,
          }),
      },
      metadata,
    }),
    "executor.sources.oauthClients.list": toTool({
      tool: {
        description: "List stored workspace OAuth clients for one provider.",
        inputSchema: workspaceOauthClientListInputSchema,
        outputSchema: workspaceOauthClientListOutputSchema,
        execute: ({ providerKey }: { providerKey: string }) =>
          input.executor.sources.oauthClients.list(providerKey),
      },
      metadata,
    }),
    "executor.sources.oauthClients.create": toTool({
      tool: {
        description:
          "Create a workspace OAuth client for a provider-backed source flow.",
        inputSchema: createWorkspaceOauthClientInputSchema,
        outputSchema: Schema.standardSchemaV1(WorkspaceOauthClientSchema),
        execute: (payload: CreateWorkspaceOauthClientPayload) =>
          input.executor.sources.oauthClients.create(payload),
      },
      metadata,
    }),
    "executor.sources.oauthClients.remove": toTool({
      tool: {
        description: "Remove a stored workspace OAuth client.",
        inputSchema: removeWorkspaceOauthClientInputSchema,
        outputSchema: removeResultSchema,
        execute: async ({
          oauthClientId,
        }: {
          oauthClientId: string;
        }) => ({
          removed: await input.executor.sources.oauthClients.remove(
            oauthClientId as never,
          ),
        }),
      },
      metadata,
    }),
    "executor.sources.providerGrants.remove": toTool({
      tool: {
        description: "Remove one stored provider auth grant.",
        inputSchema: removeProviderGrantInputSchema,
        outputSchema: removeResultSchema,
        execute: async ({ grantId }: { grantId: string }) => ({
          removed: await input.executor.sources.providerGrants.remove(
            grantId as never,
          ),
        }),
      },
      metadata,
    }),
    "executor.policies.list": toTool({
      tool: {
        description: "List local workspace policies.",
        inputSchema: emptyInputSchema,
        outputSchema: listPoliciesOutputSchema,
        execute: () => input.executor.policies.list(),
      },
      metadata,
    }),
    "executor.policies.create": toTool({
      tool: {
        description: "Create a local workspace policy.",
        inputSchema: createPolicyInputSchema,
        outputSchema: localWorkspacePolicyOutputSchema,
        execute: (payload: CreatePolicyPayload) =>
          input.executor.policies.create(payload),
      },
      metadata,
    }),
    "executor.policies.get": toTool({
      tool: {
        description: "Get one local workspace policy by id.",
        inputSchema: policyIdInputSchema,
        outputSchema: localWorkspacePolicyOutputSchema,
        execute: ({ policyId }: { policyId: string }) =>
          input.executor.policies.get(policyId),
      },
      metadata,
    }),
    "executor.policies.update": toTool({
      tool: {
        description: "Update a local workspace policy.",
        inputSchema: updatePolicyInputSchema,
        outputSchema: localWorkspacePolicyOutputSchema,
        execute: ({
          policyId,
          payload,
        }: {
          policyId: string;
          payload: UpdatePolicyPayload;
        }) => input.executor.policies.update(policyId, payload),
      },
      metadata,
    }),
    "executor.policies.remove": toTool({
      tool: {
        description: "Remove a local workspace policy.",
        inputSchema: policyIdInputSchema,
        outputSchema: removeResultSchema,
        execute: async ({ policyId }: { policyId: string }) => ({
          removed: await input.executor.policies.remove(policyId),
        }),
      },
      metadata,
    }),
  };
};
