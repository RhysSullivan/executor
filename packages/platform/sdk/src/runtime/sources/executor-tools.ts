import { toTool, type ToolMap } from "@executor/codemode-core";
import {
  type ScopeId,
  SourceIdSchema,
  SourceSchema,
  type Source,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  ExecutorSdkPluginRegistry,
} from "../../plugins";
import {
  getSource,
  listSources,
  refreshManagedSourceCatalog,
  removeSource,
  saveManagedSourceRecord,
  createManagedSourceRecord,
} from "../../sources/operations";
import {
  deriveSchemaJson,
  deriveSchemaTypeSignature,
} from "../catalog/schema-type-signature";
import {
  RuntimeSourceCatalogSyncService,
} from "../catalog/source/sync";
import {
  ExecutorStateStore,
  type ExecutorStateStoreShape,
} from "../executor-state-store";
import {
  provideOptionalRuntimeLocalScope,
  type RuntimeLocalScopeState,
} from "../scope/runtime-context";
import {
  SecretMaterialDeleterService,
  SecretMaterialResolverService,
  SecretMaterialStorerService,
  SecretMaterialUpdaterService,
  type DeleteSecretMaterial,
  type ResolveSecretMaterial,
  type StoreSecretMaterial,
  type UpdateSecretMaterial,
} from "../scope/secret-material-providers";
import {
  type InstallationStoreShape,
  makeLocalStorageLayer,
  type ScopeConfigStoreShape,
  type ScopeStateStoreShape,
  type SourceArtifactStoreShape,
} from "../scope/storage";
import {
  registeredManagementToolContributions,
  registeredSourceContributions,
} from "./source-plugins";
import {
  type RuntimeSourceStore,
  RuntimeSourceStoreService,
} from "./source-store";

const SourceArraySchema = Schema.Array(SourceSchema);
const SourceIdInputSchema = Schema.Struct({
  sourceId: SourceIdSchema,
});
const SourceRemoveResultSchema = Schema.Struct({
  removed: Schema.Boolean,
});

type RegisteredSourceContribution =
  ExecutorSdkPluginRegistry["sources"][number];
type RegisteredManagementToolContribution =
  ExecutorSdkPluginRegistry["managementTools"][number];

const createExecutorSourcesAddSchema = (
  sources: ReadonlyArray<RegisteredSourceContribution>,
): Schema.Schema<any, any, never> => {
  if (sources.length === 0) {
    return Schema.Unknown;
  }

  if (sources.length === 1) {
    return sources[0]!.inputSchema;
  }

  return Schema.Union(
    ...(sources.map((source) => source.inputSchema) as [
      Schema.Schema<any, any, never>,
      Schema.Schema<any, any, never>,
      ...Array<Schema.Schema<any, any, never>>,
    ]),
  );
};

export const getExecutorSourcesAddInputHint = (
  pluginRegistry: ExecutorSdkPluginRegistry,
): string =>
  deriveSchemaTypeSignature(
    createExecutorSourcesAddSchema(
      registeredSourceContributions(pluginRegistry),
    ),
    340,
  );

export const EXECUTOR_SOURCES_ADD_OUTPUT_SIGNATURE = deriveSchemaTypeSignature(
  SourceSchema,
  260,
);

export const getExecutorSourcesAddInputSchemaJson = (
  pluginRegistry: ExecutorSdkPluginRegistry,
): Record<string, unknown> =>
  deriveSchemaJson(
    createExecutorSourcesAddSchema(
      registeredSourceContributions(pluginRegistry),
    ),
  ) ?? {};

export const EXECUTOR_SOURCES_ADD_OUTPUT_SCHEMA = deriveSchemaJson(
  SourceSchema,
) ?? {};

const coreSourceManagementHelpLines = (): readonly string[] => [
  "- executor.sources.list",
  `- executor.sources.get: ${deriveSchemaTypeSignature(SourceIdInputSchema, 180)}`,
  `- executor.sources.refresh: ${deriveSchemaTypeSignature(SourceIdInputSchema, 180)}`,
  `- executor.sources.remove: ${deriveSchemaTypeSignature(SourceIdInputSchema, 180)}`,
];

export const getExecutorInternalToolHelpLines = (
  pluginRegistry: ExecutorSdkPluginRegistry,
): readonly string[] => {
  const sources = registeredSourceContributions(pluginRegistry);
  const managementTools = registeredManagementToolContributions(pluginRegistry);

  return [
    "Core source management tools:",
    ...coreSourceManagementHelpLines(),
    ...(managementTools.length === 0
      ? ["No plugin management tools are registered in this build."]
      : [
          "Plugin management tools:",
          ...managementTools.map((tool) =>
            `- ${tool.path}: ${deriveSchemaTypeSignature(tool.inputSchema, 260)}`
          ),
        ]),
    ...(sources.length === 0
      ? []
      : [
          "Legacy compatibility tool:",
          `- executor.sources.add: ${deriveSchemaTypeSignature(
            createExecutorSourcesAddSchema(sources),
            340,
          )}`,
        ]),
  ];
};

export const getExecutorSourcesAddHelpLines = (
  pluginRegistry: ExecutorSdkPluginRegistry,
): readonly string[] => {
  const sources = registeredSourceContributions(pluginRegistry);
  if (sources.length === 0) {
    return ["No source plugins are registered in this build."] as const;
  }

  return [
    "Source add input shapes:",
    ...sources.flatMap((source) => [
      `- ${source.displayName}: ${deriveSchemaTypeSignature(
        source.inputSchema,
        source.inputSignatureWidth ?? 260,
      )}`,
      ...(source.helpText ?? []).map((line) => `  ${line}`),
    ]),
  ];
};

export const buildExecutorSourcesAddDescription = (
  pluginRegistry: ExecutorSdkPluginRegistry,
): string => {
  const sources = registeredSourceContributions(pluginRegistry);
  if (sources.length === 0) {
    return "No source plugins are registered in this build.";
  }

  return [
    "Legacy compatibility alias for creating a source.",
    "Prefer plugin-specific tools such as executor.openapi.createSource or executor.mcp.createSource.",
    ...getExecutorSourcesAddHelpLines(pluginRegistry),
  ].join("\n");
};

const createSourceConnectorHost = (input: {
  scopeId: ScopeId;
  actorScopeId: ScopeId;
}) => ({
  sources: {
    create: ({
      source,
    }: {
      source: Omit<
        Source,
        "id" | "scopeId" | "createdAt" | "updatedAt"
      >;
    }) =>
      createManagedSourceRecord({
        scopeId: input.scopeId,
        actorScopeId: input.actorScopeId,
        source,
      }),
    get: (sourceId: Source["id"]) =>
      getSource({
        scopeId: input.scopeId,
        sourceId,
        actorScopeId: input.actorScopeId,
      }),
    save: (source: Source) =>
      saveManagedSourceRecord({
        actorScopeId: input.actorScopeId,
        source,
      }),
    refreshCatalog: (sourceId: Source["id"]) =>
      refreshManagedSourceCatalog({
        scopeId: input.scopeId,
        sourceId,
        actorScopeId: input.actorScopeId,
      }),
    remove: (sourceId: Source["id"]) =>
      removeSource({
        scopeId: input.scopeId,
        sourceId,
      }).pipe(Effect.map((result) => result.removed)),
  },
});

const runExecutorToolEffect = async <A>(
  effect: Effect.Effect<A, unknown, any>,
  input: {
    executorStateStore: ExecutorStateStoreShape;
    sourceStore: RuntimeSourceStore;
    sourceCatalogSyncService: Effect.Effect.Success<
      typeof RuntimeSourceCatalogSyncService
    >;
    installationStore: InstallationStoreShape;
    scopeConfigStore: ScopeConfigStoreShape;
    scopeStateStore: ScopeStateStoreShape;
    sourceArtifactStore: SourceArtifactStoreShape;
    runtimeLocalScope: RuntimeLocalScopeState | null;
    secretMaterialServices: {
      resolve: ResolveSecretMaterial;
      store: StoreSecretMaterial;
      delete: DeleteSecretMaterial;
      update: UpdateSecretMaterial;
    };
  },
): Promise<A> => {
  const servicesLayer = Layer.mergeAll(
    makeLocalStorageLayer({
      installationStore: input.installationStore,
      scopeConfigStore: input.scopeConfigStore,
      scopeStateStore: input.scopeStateStore,
      sourceArtifactStore: input.sourceArtifactStore,
    }),
    Layer.succeed(ExecutorStateStore, input.executorStateStore),
    Layer.succeed(RuntimeSourceStoreService, input.sourceStore),
    Layer.succeed(
      RuntimeSourceCatalogSyncService,
      input.sourceCatalogSyncService,
    ),
    Layer.succeed(
      SecretMaterialResolverService,
      input.secretMaterialServices.resolve,
    ),
    Layer.succeed(
      SecretMaterialStorerService,
      input.secretMaterialServices.store,
    ),
    Layer.succeed(
      SecretMaterialDeleterService,
      input.secretMaterialServices.delete,
    ),
    Layer.succeed(
      SecretMaterialUpdaterService,
      input.secretMaterialServices.update,
    ),
  );

  return Effect.runPromise(
    provideOptionalRuntimeLocalScope(
      effect.pipe(Effect.provide(servicesLayer)),
      input.runtimeLocalScope,
    ) as Effect.Effect<A, unknown, never>,
  );
};

const resolveSourceContribution = (
  sources: ReadonlyArray<RegisteredSourceContribution>,
  args: unknown,
):
  | {
      source: RegisteredSourceContribution;
      parsedArgs: unknown;
    }
  | null => {
  for (const source of sources) {
    const parsed = Schema.decodeUnknownOption(source.inputSchema)(args);
    if (Option.isSome(parsed)) {
      return {
        source,
        parsedArgs: parsed.value,
      };
    }
  }

  return null;
};

const toSerializableValue = <A>(value: A): A =>
  JSON.parse(JSON.stringify(value)) as A;

const pluginRemoveToolPath = (
  source: RegisteredSourceContribution,
): `executor.${string}` =>
  `executor.${source.pluginKey}.removeSource`;

const pluginRefreshToolPath = (
  source: RegisteredSourceContribution,
): `executor.${string}` =>
  `executor.${source.pluginKey}.refreshSource`;

const findManagementTool = (
  managementTools: ReadonlyArray<RegisteredManagementToolContribution>,
  path: string,
): RegisteredManagementToolContribution | null =>
  managementTools.find((tool) => tool.path === path) ?? null;

const createPluginManagementToolMap = (input: {
  managementTools: ReadonlyArray<RegisteredManagementToolContribution>;
  host: ReturnType<typeof createSourceConnectorHost>;
  runtime: Parameters<typeof runExecutorToolEffect>[1];
}): ToolMap =>
  Object.fromEntries(
    input.managementTools.map((tool) => [
      tool.path,
      toTool({
        tool: {
          description: tool.description,
          inputSchema: Schema.standardSchemaV1(tool.inputSchema),
          outputSchema: Schema.standardSchemaV1(tool.outputSchema),
          execute: async (args: unknown) =>
            toSerializableValue(
              await runExecutorToolEffect(
                tool.execute({
                  args: args as never,
                  host: input.host,
                }),
                input.runtime,
              ),
            ),
        },
      }),
    ]),
  );

export const createExecutorToolMap = (input: {
  pluginRegistry: ExecutorSdkPluginRegistry;
  scopeId: ScopeId;
  actorScopeId: ScopeId;
  executorStateStore: ExecutorStateStoreShape;
  sourceStore: RuntimeSourceStore;
  sourceCatalogSyncService: Effect.Effect.Success<
    typeof RuntimeSourceCatalogSyncService
  >;
  installationStore: InstallationStoreShape;
  scopeConfigStore: ScopeConfigStoreShape;
  scopeStateStore: ScopeStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  runtimeLocalScope: RuntimeLocalScopeState | null;
  secretMaterialServices: {
    resolve: ResolveSecretMaterial;
    store: StoreSecretMaterial;
    delete: DeleteSecretMaterial;
    update: UpdateSecretMaterial;
  };
}): ToolMap => {
  const sources = registeredSourceContributions(input.pluginRegistry);
  const managementTools = registeredManagementToolContributions(
    input.pluginRegistry,
  );
  const host = createSourceConnectorHost({
    scopeId: input.scopeId,
    actorScopeId: input.actorScopeId,
  });

  const runtime = {
    executorStateStore: input.executorStateStore,
    sourceStore: input.sourceStore,
    sourceCatalogSyncService: input.sourceCatalogSyncService,
    installationStore: input.installationStore,
    scopeConfigStore: input.scopeConfigStore,
    scopeStateStore: input.scopeStateStore,
    sourceArtifactStore: input.sourceArtifactStore,
    runtimeLocalScope: input.runtimeLocalScope,
    secretMaterialServices: input.secretMaterialServices,
  };

  const pluginToolMap = createPluginManagementToolMap({
    managementTools,
    host,
    runtime,
  });

  const coreTools: ToolMap = {
    "executor.sources.list": toTool({
      tool: {
        description: "List sources in the current executor scope.",
        inputSchema: Schema.standardSchemaV1(Schema.Struct({})),
        outputSchema: Schema.standardSchemaV1(SourceArraySchema),
        execute: async () =>
          toSerializableValue(
            await runExecutorToolEffect(
              listSources({
                scopeId: input.scopeId,
                actorScopeId: input.actorScopeId,
              }),
              runtime,
            ),
          ),
      },
    }),
    "executor.sources.get": toTool({
      tool: {
        description: "Get a source by id.",
        inputSchema: Schema.standardSchemaV1(SourceIdInputSchema),
        outputSchema: Schema.standardSchemaV1(SourceSchema),
        execute: async (args: typeof SourceIdInputSchema.Type) =>
          toSerializableValue(
            await runExecutorToolEffect(
              getSource({
                scopeId: input.scopeId,
                sourceId: args.sourceId,
                actorScopeId: input.actorScopeId,
              }),
              runtime,
            ),
          ),
      },
    }),
    "executor.sources.refresh": toTool({
      tool: {
        description: "Refresh catalog artifacts for a source by id.",
        inputSchema: Schema.standardSchemaV1(SourceIdInputSchema),
        outputSchema: Schema.standardSchemaV1(SourceSchema),
        execute: async (args: typeof SourceIdInputSchema.Type) => {
          const source = await runExecutorToolEffect(
            getSource({
              scopeId: input.scopeId,
              sourceId: args.sourceId,
              actorScopeId: input.actorScopeId,
            }),
            runtime,
          );
          const contribution = sources.find(
            (candidate) => candidate.kind === source.kind,
          );
          const pluginRefreshTool = contribution
            ? findManagementTool(
                managementTools,
                pluginRefreshToolPath(contribution),
              )
            : undefined;
          if (pluginRefreshTool) {
            return toSerializableValue(
              await runExecutorToolEffect(
                pluginRefreshTool.execute({
                  args,
                  host,
                }),
                runtime,
              ),
            );
          }

          return toSerializableValue(
            await runExecutorToolEffect(
              refreshManagedSourceCatalog({
                scopeId: input.scopeId,
                sourceId: args.sourceId,
                actorScopeId: input.actorScopeId,
              }),
              runtime,
            ),
          );
        },
      },
    }),
    "executor.sources.remove": toTool({
      tool: {
        description:
          "Remove a source by id. Delegates to plugin-owned cleanup when available.",
        inputSchema: Schema.standardSchemaV1(SourceIdInputSchema),
        outputSchema: Schema.standardSchemaV1(SourceRemoveResultSchema),
        execute: async (args: typeof SourceIdInputSchema.Type) => {
          const source = await runExecutorToolEffect(
            getSource({
              scopeId: input.scopeId,
              sourceId: args.sourceId,
              actorScopeId: input.actorScopeId,
            }),
            runtime,
          );
          const contribution = sources.find(
            (candidate) => candidate.kind === source.kind,
          );
          const pluginRemoveTool = contribution
            ? findManagementTool(
                managementTools,
                pluginRemoveToolPath(contribution),
              )
            : undefined;
          if (pluginRemoveTool) {
            const removed = await runExecutorToolEffect(
              pluginRemoveTool.execute({
                args,
                host,
              }),
              runtime,
            );
            return toSerializableValue({
              removed: Boolean(removed),
            });
          }

          return toSerializableValue(
            await runExecutorToolEffect(
              removeSource({
                scopeId: input.scopeId,
                sourceId: args.sourceId,
              }),
              runtime,
            ),
          );
        },
      },
    }),
  };

  if (sources.length > 0) {
    coreTools["executor.sources.add"] = toTool({
      tool: {
        description: buildExecutorSourcesAddDescription(input.pluginRegistry),
        inputSchema: Schema.standardSchemaV1(
          createExecutorSourcesAddSchema(sources),
        ),
        outputSchema: Schema.standardSchemaV1(SourceSchema),
        execute: async (args: unknown): Promise<Source> => {
          const matched = resolveSourceContribution(sources, args);
          if (matched === null) {
            throw new Error(
              "executor.sources.add input did not match a registered source plugin.",
            );
          }

          const createdSource = await runExecutorToolEffect(
            matched.source.createSource({
              args: matched.parsedArgs,
              host,
            }),
            runtime,
          );

          return toSerializableValue(createdSource);
        },
      },
    });
  }

  return {
    ...coreTools,
    ...pluginToolMap,
  };
};
