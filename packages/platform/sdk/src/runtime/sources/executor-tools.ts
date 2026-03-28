import { toTool, type ToolMap } from "@executor/codemode-core";
import {
  type ScopeId,
  SourceSchema,
  type Source,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  createManagedSourceRecord,
  getSource,
  refreshManagedSourceCatalog,
  removeSource,
  saveManagedSourceRecord,
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
  type InstallationStoreShape,
  makeLocalStorageLayer,
  type SourceArtifactStoreShape,
  type ScopeConfigStoreShape,
  type ScopeStateStoreShape,
} from "../scope/storage";
import {
  type RuntimeSourceStore,
  RuntimeSourceStoreService,
} from "./source-store";
import {
  registeredSourceContributions,
} from "./source-plugins";

const createExecutorSourcesAddSchema = (): Schema.Schema<any, any, never> => {
  const sources = registeredSourceContributions();
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
    ])
  );
};

export const getExecutorSourcesAddInputHint = (): string =>
  deriveSchemaTypeSignature(createExecutorSourcesAddSchema(), 340);

export const EXECUTOR_SOURCES_ADD_OUTPUT_SIGNATURE = deriveSchemaTypeSignature(
  SourceSchema,
  260,
);

export const getExecutorSourcesAddInputSchemaJson = (): Record<string, unknown> =>
  deriveSchemaJson(createExecutorSourcesAddSchema()) ?? {};

export const EXECUTOR_SOURCES_ADD_OUTPUT_SCHEMA = deriveSchemaJson(
  SourceSchema,
) ?? {};

export const getExecutorSourcesAddHelpLines = (): readonly string[] => {
  const sources = registeredSourceContributions();
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

export const buildExecutorSourcesAddDescription = (): string => {
  const sources = registeredSourceContributions();
  if (sources.length === 0) {
    return "No source plugins are registered in this build.";
  }

  return [
    "Add a source using one of the registered source plugins.",
    ...getExecutorSourcesAddHelpLines(),
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

const runExecutorSourceEffect = async <A>(
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
  );

  return Effect.runPromise(
    provideOptionalRuntimeLocalScope(
      effect.pipe(Effect.provide(servicesLayer)),
      input.runtimeLocalScope,
    ) as Effect.Effect<A, unknown, never>,
  );
};

const resolveSourceContribution = (
  sources: ReturnType<typeof registeredSourceContributions>,
  args: unknown,
):
  | {
      source: ReturnType<typeof registeredSourceContributions>[number];
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

export const createExecutorToolMap = (input: {
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
}): ToolMap => {
  const sources = registeredSourceContributions();
  if (sources.length === 0) {
    return {};
  }

  const host = createSourceConnectorHost({
    scopeId: input.scopeId,
    actorScopeId: input.actorScopeId,
  });

  return {
    "executor.sources.add": toTool({
      tool: {
        description: buildExecutorSourcesAddDescription(),
        inputSchema: Schema.standardSchemaV1(createExecutorSourcesAddSchema()),
        outputSchema: Schema.standardSchemaV1(SourceSchema),
        execute: async (args: unknown): Promise<Source> => {
          const matched = resolveSourceContribution(sources, args);
          if (matched === null) {
            throw new Error(
              "executor.sources.add input did not match a registered source plugin.",
            );
          }

          const createdSource = await runExecutorSourceEffect(
            matched.source.createSource({
              args: matched.parsedArgs,
              host,
            }),
            input,
          );

          return toSerializableValue(createdSource);
        },
      },
    }),
  };
};
