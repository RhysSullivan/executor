import {
  type ElicitationResponse,
  type OnElicitation,
  type ToolInvocationContext,
  type ToolMetadata,
  toTool,
  type ToolMap,
  type ToolPath,
} from "@executor-v3/codemode-core";
import {
  ExecutionIdSchema,
  ExecutionInteractionIdSchema,
  SourceSchema,
  type Source,
  type WorkspaceId,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type ExecutorAddSourceInput,
  type ExecutorHttpSourceAuthInput,
  type RuntimeSourceAuthService,
} from "./source-auth-service";
import {
  deriveSchemaJson,
  deriveSchemaTypeSignature,
} from "./schema-type-signature";
import { decodeSourceCredentialSelectionContent } from "./source-credential-interactions";

const ExecutorMcpSourceAddInputSchema = Schema.Struct({
  kind: Schema.optional(Schema.Literal("mcp")),
  endpoint: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
});

const ExecutorOpenApiSourceAddInputSchema = Schema.Struct({
  kind: Schema.Literal("openapi"),
  endpoint: Schema.String,
  specUrl: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
});

const ExecutorGraphqlSourceAddInputSchema = Schema.Struct({
  kind: Schema.Literal("graphql"),
  endpoint: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
});

const ExecutorSourcesAddSchema = Schema.Union(
  ExecutorMcpSourceAddInputSchema,
  ExecutorOpenApiSourceAddInputSchema,
  ExecutorGraphqlSourceAddInputSchema,
);

const ExecutorSourcesAddInputSchema = Schema.standardSchemaV1(
  ExecutorSourcesAddSchema,
);

const ExecutorSourcesAddOutputSchema = Schema.standardSchemaV1(SourceSchema);

export const EXECUTOR_SOURCES_ADD_MCP_INPUT_SIGNATURE = deriveSchemaTypeSignature(
  ExecutorMcpSourceAddInputSchema,
  240,
);

export const EXECUTOR_SOURCES_ADD_OPENAPI_INPUT_SIGNATURE = deriveSchemaTypeSignature(
  ExecutorOpenApiSourceAddInputSchema,
  420,
);

export const EXECUTOR_SOURCES_ADD_GRAPHQL_INPUT_SIGNATURE = deriveSchemaTypeSignature(
  ExecutorGraphqlSourceAddInputSchema,
  320,
);

export const EXECUTOR_SOURCES_ADD_INPUT_HINT = deriveSchemaTypeSignature(
  ExecutorSourcesAddInputSchema,
  320,
);

export const EXECUTOR_SOURCES_ADD_OUTPUT_SIGNATURE = deriveSchemaTypeSignature(
  SourceSchema,
  260,
);

export const EXECUTOR_SOURCES_ADD_INPUT_SCHEMA_JSON = JSON.stringify(
  deriveSchemaJson(ExecutorSourcesAddSchema) ?? {},
);

export const EXECUTOR_SOURCES_ADD_OUTPUT_SCHEMA_JSON = JSON.stringify(
  deriveSchemaJson(SourceSchema) ?? {},
);

export const EXECUTOR_SOURCES_ADD_HELP_LINES = [
  "Source add input shapes:",
  `- MCP: ${EXECUTOR_SOURCES_ADD_MCP_INPUT_SIGNATURE}`,
  '  Omit kind or set kind: "mcp". endpoint is the MCP server URL.',
  `- OpenAPI: ${EXECUTOR_SOURCES_ADD_OPENAPI_INPUT_SIGNATURE}`,
  "  endpoint is the base API URL. specUrl is the OpenAPI document URL.",
  `- GraphQL: ${EXECUTOR_SOURCES_ADD_GRAPHQL_INPUT_SIGNATURE}`,
  "  endpoint is the GraphQL HTTP endpoint.",
  "  executor handles the credential setup for you.",
] as const;

export const buildExecutorSourcesAddDescription = (): string =>
  [
    "Add an MCP, OpenAPI, or GraphQL source to the current workspace.",
    ...EXECUTOR_SOURCES_ADD_HELP_LINES,
  ].join("\n");

const toExecutionId = (value: unknown) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Missing execution run id for executor.sources.add");
  }

  return ExecutionIdSchema.make(value);
};

const asToolPath = (value: string): ToolPath => value as ToolPath;

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const resolveOpenApiSourceLabel = (input: {
  name?: string | null;
  endpoint: string;
}): string => trimOrNull(input.name) ?? input.endpoint;

const resolveLocalCredentialUrl = (input: {
  baseUrl: string;
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  executionId: string;
  interactionId: string;
}): string =>
  new URL(
    `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/sources/${encodeURIComponent(input.sourceId)}/credentials?interactionId=${encodeURIComponent(`${input.executionId}:${input.interactionId}`)}`,
    input.baseUrl,
  ).toString();

const promptForSourceCredentialSelection = (input: {
  args: {
    workspaceId: WorkspaceId;
    sourceId: Source["id"];
    kind: "openapi" | "graphql";
    endpoint: string;
    specUrl?: string;
    name?: string | null;
    namespace?: string | null;
  };
  source: Source;
  executionId: string;
  interactionId: string;
  path: ToolPath;
  sourceKey: string;
  localServerBaseUrl: string | null;
  metadata?: ToolMetadata;
  invocation?: ToolInvocationContext;
  onElicitation?: OnElicitation;
}) =>
  Effect.gen(function* () {
    if (!input.onElicitation) {
      return yield* Effect.fail(
        new Error("executor.sources.add requires an elicitation-capable host"),
      );
    }

    if (input.localServerBaseUrl === null) {
      return yield* Effect.fail(
        new Error("executor.sources.add requires a local server base URL for credential capture"),
      );
    }

    const response: ElicitationResponse = yield* input.onElicitation({
      interactionId: input.interactionId,
      path: input.path,
      sourceKey: input.sourceKey,
      args: input.args,
      metadata: input.metadata,
      context: input.invocation,
      elicitation: {
        mode: "url",
        message: `Open the secure credential page to connect ${input.source.name}`,
        url: resolveLocalCredentialUrl({
          baseUrl: input.localServerBaseUrl,
          workspaceId: input.args.workspaceId,
          sourceId: input.args.sourceId,
          executionId: input.executionId,
          interactionId: input.interactionId,
        }),
        elicitationId: input.interactionId,
      },
    }).pipe(Effect.mapError((cause) => cause instanceof Error ? cause : new Error(String(cause))));

    if (response.action !== "accept") {
      return yield* Effect.fail(
        new Error(`Source credential setup was not completed for ${input.source.name}`),
      );
    }

    const content = yield* Effect.try({
      try: () => decodeSourceCredentialSelectionContent(response.content),
      catch: () =>
        new Error("Credential capture did not return a valid source auth choice for executor.sources.add"),
    });

    if (content.authKind === "none") {
      return { kind: "none" } satisfies ExecutorHttpSourceAuthInput;
    }

    return {
      kind: "bearer",
      tokenRef: content.tokenRef,
    } satisfies ExecutorHttpSourceAuthInput;
  });

export const createExecutorToolMap = (input: {
  workspaceId: WorkspaceId;
  sourceAuthService: RuntimeSourceAuthService;
}): ToolMap => ({
  "executor.sources.add": toTool({
    tool: {
      description: buildExecutorSourcesAddDescription(),
      inputSchema: ExecutorSourcesAddInputSchema,
      outputSchema: ExecutorSourcesAddOutputSchema,
      execute: async (
        args:
          | {
            kind?: "mcp";
            endpoint: string;
            name?: string | null;
            namespace?: string | null;
          }
          | {
            kind: "openapi";
            endpoint: string;
            specUrl: string;
            name?: string | null;
            namespace?: string | null;
          }
          | {
            kind: "graphql";
            endpoint: string;
            name?: string | null;
            namespace?: string | null;
          },
        context,
      ): Promise<Source> => {
        const executionId = toExecutionId(context?.invocation?.runId);
        const interactionId = ExecutionInteractionIdSchema.make(
          `executor.sources.add:${crypto.randomUUID()}`,
        );
        const preparedArgs: ExecutorAddSourceInput =
          args.kind === "openapi" || args.kind === "graphql"
            ? {
              ...args,
              workspaceId: input.workspaceId,
              executionId,
              interactionId,
            }
            : {
              kind: args.kind,
              endpoint: args.endpoint,
              name: args.name ?? null,
              namespace: args.namespace ?? null,
              workspaceId: input.workspaceId,
              executionId,
              interactionId,
            };
        const result = await Effect.runPromise(
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
        );

        if (result.kind === "connected") {
          return result.source;
        }

        if (result.kind === "credential_required") {
          const preparedHttpArgs = preparedArgs as Extract<
            ExecutorAddSourceInput,
            { kind: "openapi" | "graphql" }
          >;
          const selectedAuth = await Effect.runPromise(
            promptForSourceCredentialSelection({
              args: {
                ...preparedHttpArgs,
                workspaceId: input.workspaceId,
                sourceId: result.source.id,
              },
              source: result.source,
              executionId,
              interactionId,
              path: context?.path ?? asToolPath("executor.sources.add"),
              sourceKey: context?.sourceKey ?? "executor",
              localServerBaseUrl: input.sourceAuthService.getLocalServerBaseUrl(),
              metadata: context?.metadata,
              invocation: context?.invocation,
              onElicitation: context?.onElicitation,
            }),
          );

          const completed = await Effect.runPromise(
            input.sourceAuthService.addExecutorSource(
              {
                ...preparedHttpArgs,
                auth: selectedAuth,
              },
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
          );

          if (completed.kind === "connected") {
            return completed.source;
          }

          throw new Error(`Source add was not completed for ${result.source.id}`);
        }

        if (!context?.onElicitation) {
          throw new Error("executor.sources.add requires an elicitation-capable host");
        }

        const response: ElicitationResponse = await Effect.runPromise(
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
        );

        if (response.action !== "accept") {
          throw new Error(`Source add was not completed for ${result.source.id}`);
        }

        return await Effect.runPromise(
          input.sourceAuthService.getSourceById({
            workspaceId: input.workspaceId,
            sourceId: result.source.id,
          }),
        );
      },
    },
    metadata: {
      inputType: EXECUTOR_SOURCES_ADD_INPUT_HINT,
      outputType: EXECUTOR_SOURCES_ADD_OUTPUT_SIGNATURE,
      inputSchemaJson: EXECUTOR_SOURCES_ADD_INPUT_SCHEMA_JSON,
      outputSchemaJson: EXECUTOR_SOURCES_ADD_OUTPUT_SCHEMA_JSON,
      sourceKey: "executor",
      interaction: "auto",
    },
  }),
});
