import {
  makeToolInvokerFromTools,
  toolDescriptorsFromTools,
  type ToolDescriptor,
  type ToolInput,
  type ToolMap,
} from "@executor/codemode-core";
import {
  createCatalogImportMetadata,
  createSourceCatalogSyncResult,
  stableHash,
} from "@executor/source-core";
import {
  defineExecutorSourcePlugin,
} from "@executor/platform-sdk/plugins";
import {
  LocalToolRuntimeLoaderService,
  provideExecutorRuntime,
  runtimeEffectError,
} from "@executor/platform-sdk/runtime";
import type {
  Source,
} from "@executor/platform-sdk/schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  createLocalToolsCatalogFragment,
} from "./catalog";

export const LOCAL_TOOLS_SOURCE_KIND = "local-tools";
export const LOCAL_TOOLS_SOURCE_NAME = "Local Tools";

const LocalToolsStoredSchema = Schema.Struct({
  kind: Schema.Literal(LOCAL_TOOLS_SOURCE_KIND),
});

type LocalToolsStored = typeof LocalToolsStoredSchema.Type;

const LOCAL_TOOLS_STORED: LocalToolsStored = {
  kind: LOCAL_TOOLS_SOURCE_KIND,
};

const LocalToolsAddInputSchema = Schema.Struct({
  kind: Schema.Literal(LOCAL_TOOLS_SOURCE_KIND),
  name: Schema.optional(Schema.String),
});

type LocalToolsAddInput = typeof LocalToolsAddInputSchema.Type;

type LocalToolsSourceConfig = {
  name: string;
};

type LocalToolsUpdateSourceInput = {
  sourceId: string;
  config: LocalToolsSourceConfig;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const loadLocalToolRuntime = () =>
  Effect.flatMap(LocalToolRuntimeLoaderService, (loader) => loader.load());

const localToolDescriptors = (input: {
  source: Source;
  tools: ToolMap;
}): ToolDescriptor[] =>
  toolDescriptorsFromTools({
    tools: input.tools,
    sourceKey: input.source.id,
  });

const localToolSourceHash = (
  descriptors: ReadonlyArray<ToolDescriptor>,
): string =>
  stableHash(
    descriptors.map((descriptor) => ({
      path: descriptor.path,
      description: descriptor.description ?? null,
      interaction: descriptor.interaction ?? "auto",
      inputSchema: descriptor.contract?.inputSchema ?? null,
      outputSchema: descriptor.contract?.outputSchema ?? null,
    })),
  );

const createLocalToolsDocument = (
  source: Source,
  descriptors: ReadonlyArray<ToolDescriptor>,
) => ({
  documentKind: "local-tools",
  documentKey: `.executor/tools:${source.id}`,
  fetchedAt: Date.now(),
  contentText: JSON.stringify(
    {
      tools: descriptors.map((descriptor) => ({
        path: descriptor.path,
        description: descriptor.description ?? null,
        interaction: descriptor.interaction ?? "auto",
        inputSchema: descriptor.contract?.inputSchema ?? null,
        outputSchema: descriptor.contract?.outputSchema ?? null,
      })),
    },
    null,
    2,
  ),
});

const extractExecutableTool = (entry: ToolInput | undefined) => {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  return "tool" in entry ? entry.tool : entry;
};

const wrappedInvocationPayload = (
  args: unknown,
): unknown => asRecord(args).input;

export const localToolsSdkPlugin = () =>
  defineExecutorSourcePlugin<
    "local-tools",
    LocalToolsAddInput,
    { name: string },
    LocalToolsSourceConfig,
    LocalToolsStored,
    LocalToolsUpdateSourceInput
  >({
    key: LOCAL_TOOLS_SOURCE_KIND,
    source: {
      kind: LOCAL_TOOLS_SOURCE_KIND,
      displayName: "Local Tools",
      add: {
        inputSchema: LocalToolsAddInputSchema,
        helpText: [
          "Auto-discovers file-backed tools from .executor/tools in this workspace.",
        ],
        toConnectInput: (input) => ({
          name: input.name?.trim() || LOCAL_TOOLS_SOURCE_NAME,
        }),
      },
      storage: {
        get: () => Effect.succeed(LOCAL_TOOLS_STORED),
        put: () => Effect.void,
        remove: () => Effect.void,
      },
      source: {
        create: (input) => ({
          source: {
            name: input.name.trim() || LOCAL_TOOLS_SOURCE_NAME,
            kind: LOCAL_TOOLS_SOURCE_KIND,
            status: "connected",
            enabled: true,
            namespace: "",
          },
          stored: LOCAL_TOOLS_STORED,
        }),
        update: (input) => ({
          source: {
            ...input.source,
            name: input.config.name.trim() || input.source.name,
          },
          stored: LOCAL_TOOLS_STORED,
        }),
        toConfig: (input) => ({
          name: input.source.name,
        }),
      },
      catalog: {
        kind: "imported",
        sync: (input) =>
          Effect.gen(function* () {
            const localToolRuntime = yield* loadLocalToolRuntime();
            const descriptors = localToolDescriptors({
              source: input.source,
              tools: localToolRuntime.tools,
            });

            return createSourceCatalogSyncResult({
              fragment: createLocalToolsCatalogFragment({
                source: input.source,
                documents: [createLocalToolsDocument(input.source, descriptors)],
                operations: descriptors.map((descriptor) => ({
                  descriptor,
                  inputSchema: descriptor.contract?.inputSchema,
                  outputSchema: descriptor.contract?.outputSchema,
                })),
              }),
              importMetadata: {
                ...createCatalogImportMetadata({
                  source: input.source,
                  pluginKey: LOCAL_TOOLS_SOURCE_KIND,
                }),
                importerVersion: "ir.v1.local-tools",
              },
              sourceHash: localToolSourceHash(descriptors),
            });
          }),
        invoke: (input) =>
          Effect.gen(function* () {
            const localToolRuntime = yield* loadLocalToolRuntime();
            const executable = extractExecutableTool(
              localToolRuntime.tools[input.descriptor.path],
            );
            if (!executable) {
              return yield* runtimeEffectError(
                "plugins/local-tools/sdk",
                `Missing local tool definition for ${input.descriptor.path}`,
              );
            }

            const binding = asRecord(input.executable.binding);
            const toolPath =
              typeof binding.toolPath === "string" && binding.toolPath.length > 0
                ? binding.toolPath
                : input.descriptor.path;
            const payload =
              binding.invocationInput === "wrapped"
                ? wrappedInvocationPayload(input.args)
                : input.args;
            const toolInvoker = makeToolInvokerFromTools({
              tools: localToolRuntime.tools,
              onElicitation: input.onElicitation,
            });
            const result = yield* toolInvoker.invoke({
              path: toolPath as never,
              args: payload,
              context: input.context,
            }).pipe(
              Effect.mapError((cause) =>
                cause instanceof Error ? cause : new Error(String(cause)),
              ),
            );

            return {
              data: result ?? null,
              error: null,
              headers: {},
              status: null,
            };
          }),
      },
    },
    start: ({ executor, source }) => {
      const provideRuntime = <A>(
        effect: Effect.Effect<A, Error, any>,
      ): Effect.Effect<A, Error, never> =>
        provideExecutorRuntime(effect, executor.runtime);

      return provideRuntime(
        Effect.gen(function* () {
          const localToolRuntime = yield* loadLocalToolRuntime();
          const existingSources = yield* executor.sources.list();
          const existingLocalToolsSource = existingSources.find(
            (candidate) => candidate.kind === LOCAL_TOOLS_SOURCE_KIND,
          ) ?? null;

          if (existingLocalToolsSource) {
            yield* source.refreshSource(existingLocalToolsSource.id);
            return;
          }

          if (localToolRuntime.toolPaths.size === 0) {
            return;
          }

          yield* source.createSource({
            name: LOCAL_TOOLS_SOURCE_NAME,
          });
        }),
      );
    },
  });
