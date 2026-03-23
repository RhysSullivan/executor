import {
  type ElicitationResponse,
  toTool,
  type ToolMap,
  type ToolPath,
} from "@executor/codemode-core";
import {
  type ScopeId,
  ExecutionIdSchema,
  ExecutionInteractionIdSchema,
  SourceSchema,
  type Source,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type {
  RuntimeLocalScopeState,
} from "../scope/runtime-context";
import {
  type LocalStorageServices,
  type InstallationStoreShape,
  type SourceArtifactStoreShape,
  type ScopeConfigStoreShape,
  type ScopeStateStoreShape,
  makeLocalStorageLayer,
} from "../scope/storage";
import {
  provideOptionalRuntimeLocalScope,
} from "../scope/runtime-context";

/** Run an Effect as a Promise, preserving the original error (not FiberFailure). */
const runEffect = async <A>(
  effect: Effect.Effect<A, unknown, LocalStorageServices>,
  storage: {
    installationStore: InstallationStoreShape;
    scopeConfigStore: ScopeConfigStoreShape;
    scopeStateStore: ScopeStateStoreShape;
    sourceArtifactStore: SourceArtifactStoreShape;
  },
  runtimeLocalScope: RuntimeLocalScopeState | null = null,
): Promise<A> => {
  const baseLayer = makeLocalStorageLayer(storage);
  const exit = await Effect.runPromiseExit(
    provideOptionalRuntimeLocalScope(
      effect.pipe(Effect.provide(baseLayer)),
      runtimeLocalScope,
    ),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
};

import {
  type ExecutorAddSourceInput,
  type RuntimeSourceAuthService,
} from "./source-auth-service";
import {
  deriveSchemaJson,
  deriveSchemaTypeSignature,
} from "../catalog/schema-type-signature";
import {
  ExecutorAddSourceInputSchema,
  executorAddableSourceAdapters,
  hasRegisteredExecutorAddableSourceAdapters,
} from "./source-adapters";

const ExecutorSourcesAddInputSchema = Schema.standardSchemaV1(
  ExecutorAddSourceInputSchema,
);

const ExecutorSourcesAddOutputSchema = Schema.standardSchemaV1(SourceSchema);

export const EXECUTOR_SOURCES_ADD_INPUT_HINT = hasRegisteredExecutorAddableSourceAdapters
  ? deriveSchemaTypeSignature(
      ExecutorAddSourceInputSchema,
      320,
    )
  : "Source plugins are not registered in this build.";

export const EXECUTOR_SOURCES_ADD_OUTPUT_SIGNATURE = deriveSchemaTypeSignature(
  SourceSchema,
  260,
);

export const EXECUTOR_SOURCES_ADD_INPUT_SCHEMA = hasRegisteredExecutorAddableSourceAdapters
  ? deriveSchemaJson(
      ExecutorAddSourceInputSchema,
    ) ?? {}
  : {};

export const EXECUTOR_SOURCES_ADD_OUTPUT_SCHEMA = deriveSchemaJson(
  SourceSchema,
) ?? {};

export const EXECUTOR_SOURCES_ADD_HELP_LINES = hasRegisteredExecutorAddableSourceAdapters
  ? [
      "Source add input shapes:",
      ...executorAddableSourceAdapters.flatMap((adapter) =>
        adapter.executorAddInputSchema
        && adapter.executorAddInputSignatureWidth !== null
        && adapter.executorAddHelpText
          ? [
              `- ${adapter.displayName}: ${deriveSchemaTypeSignature(adapter.executorAddInputSchema, adapter.executorAddInputSignatureWidth)}`,
              ...adapter.executorAddHelpText.map((line) => `  ${line}`),
            ]
          : [],
      ),
      "  executor handles the credential setup for you.",
    ] as const
  : [
      "Source plugins are not registered in this build.",
    ] as const;

export const buildExecutorSourcesAddDescription = (): string =>
  hasRegisteredExecutorAddableSourceAdapters
    ? [
        "Add a registered source plugin to the current scope.",
        ...EXECUTOR_SOURCES_ADD_HELP_LINES,
      ].join("\n")
    : "Source plugins are not registered in this build.";

const toExecutionId = (value: unknown) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Missing execution run id for executor.sources.add");
  }

  return ExecutionIdSchema.make(value);
};

const asToolPath = (value: string): ToolPath => value as ToolPath;

const toSerializableValue = <A>(value: A): A =>
  JSON.parse(JSON.stringify(value)) as A;

type ExecutorSourcesAddToolArgs = Omit<
  ExecutorAddSourceInput,
  "scopeId" | "actorScopeId" | "executionId" | "interactionId"
>;

const prepareExecutorAddSourceInput = (input: {
  args: ExecutorSourcesAddToolArgs;
  scopeId: ScopeId;
  actorScopeId: ScopeId;
  executionId: ReturnType<typeof toExecutionId>;
  interactionId: ReturnType<typeof ExecutionInteractionIdSchema.make>;
}): ExecutorAddSourceInput => ({
    ...input.args,
    scopeId: input.scopeId,
    actorScopeId: input.actorScopeId,
    executionId: input.executionId,
    interactionId: input.interactionId,
  } as ExecutorAddSourceInput);

export const createExecutorToolMap = (input: {
  scopeId: ScopeId;
  actorScopeId: ScopeId;
  sourceAuthService: RuntimeSourceAuthService;
  installationStore: InstallationStoreShape;
  scopeConfigStore: ScopeConfigStoreShape;
  scopeStateStore: ScopeStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  runtimeLocalScope: RuntimeLocalScopeState | null;
}): ToolMap =>
  !hasRegisteredExecutorAddableSourceAdapters
    ? {}
    : ({
      "executor.sources.add": toTool({
    tool: {
      description: buildExecutorSourcesAddDescription(),
      inputSchema: ExecutorSourcesAddInputSchema,
      outputSchema: ExecutorSourcesAddOutputSchema,
      execute: async (args: ExecutorSourcesAddToolArgs, context): Promise<Source> => {
        const executionId = toExecutionId(context?.invocation?.runId);
        const interactionId = ExecutionInteractionIdSchema.make(
          `executor.sources.add:${crypto.randomUUID()}`,
        );
        const preparedArgs = prepareExecutorAddSourceInput({
          args,
          scopeId: input.scopeId,
          actorScopeId: input.actorScopeId,
          executionId,
          interactionId,
        });
        const result = await runEffect(
          input.sourceAuthService.addExecutorSource(
            preparedArgs,
            context?.onElicitation
              ? {
                mcpDiscoveryElicitation: {
                  onElicitation: context.onElicitation,
                  path: context.path ?? asToolPath("executor.sources.add"),
                  sourceKey: context.sourceKey,
                  args,
                  metadata: context.metadata,
                  invocation: context.invocation,
                },
              }
              : undefined,
          ),
          {
            installationStore: input.installationStore,
            scopeConfigStore: input.scopeConfigStore,
            scopeStateStore: input.scopeStateStore,
            sourceArtifactStore: input.sourceArtifactStore,
          },
          input.runtimeLocalScope,
        );

        if (result.kind === "connected") {
          return toSerializableValue(result.source);
        }
        if (!context?.onElicitation || result.kind !== "oauth_required") {
          throw new Error(
            `executor.sources.add requires plugin-managed continuation support for ${result.source.id}`,
          );
        }

        const response: ElicitationResponse = await runEffect(
          context.onElicitation({
            interactionId,
            path: context.path ?? asToolPath("executor.sources.add"),
            sourceKey: context.sourceKey,
            args: preparedArgs,
            metadata: context.metadata,
            context: context.invocation,
            elicitation: {
              mode: "url",
              message: `Open the provider sign-in page to connect ${result.source.name}`,
              url: result.authorizationUrl,
              elicitationId: result.sessionId,
            },
          }),
          {
            installationStore: input.installationStore,
            scopeConfigStore: input.scopeConfigStore,
            scopeStateStore: input.scopeStateStore,
            sourceArtifactStore: input.sourceArtifactStore,
          },
          input.runtimeLocalScope,
        );

        if (response.action !== "accept") {
          throw new Error(`Source add was not completed for ${result.source.id}`);
        }

        const connected = await runEffect(
          input.sourceAuthService.getSourceById({
            scopeId: input.scopeId,
            sourceId: result.source.id,
            actorScopeId: input.actorScopeId,
          }),
          {
            installationStore: input.installationStore,
            scopeConfigStore: input.scopeConfigStore,
            scopeStateStore: input.scopeStateStore,
            sourceArtifactStore: input.sourceArtifactStore,
          },
          input.runtimeLocalScope,
        );
        return toSerializableValue(connected);
      },
    },
    metadata: {
      contract: {
        inputTypePreview: EXECUTOR_SOURCES_ADD_INPUT_HINT,
        outputTypePreview: EXECUTOR_SOURCES_ADD_OUTPUT_SIGNATURE,
        inputSchema: EXECUTOR_SOURCES_ADD_INPUT_SCHEMA,
        outputSchema: EXECUTOR_SOURCES_ADD_OUTPUT_SCHEMA,
      },
      sourceKey: "executor",
      interaction: "auto",
    },
      }),
    });
