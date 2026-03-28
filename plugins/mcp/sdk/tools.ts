import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as Data from "effect/Data";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as PartitionedSemaphore from "effect/PartitionedSemaphore";

import {
  standardSchemaFromJsonSchema,
  toTool,
  type ElicitationRequest,
  type ElicitationResponse,
  type ToolInvocationContext,
  type ToolExecutionContext,
  type ToolMap,
  type ToolMetadata,
  type ToolPath,
  unknownInputSchema,
} from "@executor/codemode-core";

import {
  createInteractionId,
  hasElicitationRequestHandler,
  isUrlElicitationRequiredError,
  readMcpElicitationRequest,
  readUnknownRecord,
  toMcpElicitationResponse,
} from "./elicitation-bridge";
import {
  extractMcpToolManifestFromListToolsResult,
  joinToolPath,
  type McpToolManifest,
  type McpToolManifestEntry,
} from "./manifest";

export type { McpToolManifest, McpToolManifestEntry };
export { extractMcpToolManifestFromListToolsResult };

export type McpClientLike = {
  listTools: () => Promise<unknown>;
  callTool: (input: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<unknown>;
  getServerCapabilities?: () => unknown;
  getServerVersion?: () => unknown;
  getInstructions?: () => string | undefined;
};

export type McpConnection = {
  client: McpClientLike;
  close?: () => Promise<void>;
};

export type McpConnector = Effect.Effect<McpConnection, unknown, never>;

export type McpDiscoveryElicitationContext = {
  onElicitation: NonNullable<ToolExecutionContext["onElicitation"]>;
  path: ToolPath;
  sourceKey: string;
  args: Record<string, unknown>;
  metadata?: ToolMetadata;
  invocation?: ToolInvocationContext;
};

type McpDiscoveryStage = "connect" | "list_tools" | "call_tool";

export class McpToolsError extends Data.TaggedError("McpToolsError")<{
  stage: McpDiscoveryStage;
  message: string;
  details: string | null;
}> {}

const EXECUTION_SUSPENDED_SENTINEL = "__EXECUTION_SUSPENDED__";

const causeText = (cause: unknown): string => {
  if (cause instanceof Error) {
    return `${cause.message}\n${cause.stack ?? ""}`;
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

const isExecutionSuspendedCause = (cause: unknown): boolean =>
  causeText(cause).includes(EXECUTION_SUSPENDED_SENTINEL);

const toDetails = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const inputSchemaFromManifest = (inputSchema: unknown) => {
  if (inputSchema === undefined || inputSchema === null) {
    return unknownInputSchema;
  }

  try {
    return standardSchemaFromJsonSchema(inputSchema, {
      vendor: "mcp",
      fallback: unknownInputSchema,
    });
  } catch {
    return unknownInputSchema;
  }
};

const closeConnection = (connection: McpConnection): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => connection.close?.() ?? Promise.resolve(),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause ?? "mcp connection close failed")),
  }).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void),
  );

const withConnectionEffect = <A, E>(input: {
  connect: McpConnector;
  onConnectError: (cause: unknown) => McpToolsError;
  run: (connection: McpConnection) => Effect.Effect<A, E>;
}): Effect.Effect<A, E | McpToolsError> =>
  Effect.acquireUseRelease(
    input.connect.pipe(Effect.mapError(input.onConnectError)),
    input.run,
    closeConnection,
  );

const elicitationClientSemaphore = PartitionedSemaphore.makeUnsafe<McpClientLike>({
  permits: 1,
});

const withElicitationClientLock = <A, E>(
  client: McpClientLike,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> => elicitationClientSemaphore.withPermits(client, 1)(effect);

const resolveElicitationResponse = (input: {
  toolName: string;
  onElicitation: NonNullable<ToolExecutionContext["onElicitation"]>;
  interactionId: string;
  path: ToolPath;
  sourceKey: string;
  args: Record<string, unknown>;
  executionContext?: ToolExecutionContext;
  elicitation: ElicitationRequest;
}): Effect.Effect<ElicitationResponse, McpToolsError> =>
  input.onElicitation({
    interactionId: input.interactionId,
    path: input.path,
    sourceKey: input.sourceKey,
    args: input.args,
    metadata: input.executionContext?.metadata,
    context: input.executionContext?.invocation,
    elicitation: input.elicitation,
  }).pipe(
    Effect.mapError((cause) =>
      isExecutionSuspendedCause(cause)
        ? (cause as McpToolsError)
        : new McpToolsError({
            stage: "call_tool",
            message: `Failed resolving elicitation for ${input.toolName}`,
            details: toDetails(cause),
          })),
  );

const installMcpElicitationHandler = (input: {
  client: McpClientLike;
  toolName: string;
  onElicitation: NonNullable<ToolExecutionContext["onElicitation"]>;
  path: ToolPath;
  sourceKey: string;
  args: Record<string, unknown>;
  executionContext?: ToolExecutionContext;
}): Effect.Effect<void, McpToolsError> => {
  const client = input.client;
  if (!hasElicitationRequestHandler(client)) {
    return Effect.succeed(undefined);
  }

  return Effect.try({
    try: () => {
      let sequence = 0;
      client.setRequestHandler(ElicitRequestSchema, (request: { params: unknown }) => {
        sequence += 1;

        return Effect.runPromise(
          Effect.try({
            try: () => readMcpElicitationRequest(request.params),
            catch: (cause) =>
              new McpToolsError({
                stage: "call_tool",
                message: `Failed parsing MCP elicitation for ${input.toolName}`,
                details: toDetails(cause),
              }),
          }).pipe(
            Effect.flatMap((elicitation) =>
              resolveElicitationResponse({
                toolName: input.toolName,
                onElicitation: input.onElicitation,
                interactionId: createInteractionId({
                  path: input.path,
                  invocation: input.executionContext?.invocation,
                  elicitation,
                  sequence,
                }),
                path: input.path,
                sourceKey: input.sourceKey,
                args: input.args,
                executionContext: input.executionContext,
                elicitation,
              }),
            ),
            Effect.map(toMcpElicitationResponse),
            Effect.catchAll((error) => {
              if (isExecutionSuspendedCause(error)) {
                return Effect.fail(error);
              }

              console.error(
                `[mcp-tools] elicitation failed for ${input.toolName}, treating as cancel:`,
                error instanceof Error ? error.message : String(error),
              );
              return Effect.succeed({ action: "cancel" as const });
            }),
          ),
        );
      });
    },
    catch: (cause) =>
      cause instanceof McpToolsError
        ? cause
        : new McpToolsError({
            stage: "call_tool",
            message: `Failed installing elicitation handler for ${input.toolName}`,
            details: toDetails(cause),
          }),
  });
};

const resolveUrlElicitations = (input: {
  cause: {
    elicitations: ReadonlyArray<ElicitationRequest>;
  };
  toolName: string;
  onElicitation: NonNullable<ToolExecutionContext["onElicitation"]>;
  path: ToolPath;
  sourceKey: string;
  args: Record<string, unknown>;
  executionContext?: ToolExecutionContext;
}): Effect.Effect<void, McpToolsError> =>
  Effect.forEach(
    input.cause.elicitations,
    (elicitation) =>
      resolveElicitationResponse({
        toolName: input.toolName,
        onElicitation: input.onElicitation,
        interactionId: createInteractionId({
          path: input.path,
          invocation: input.executionContext?.invocation,
          elicitation,
        }),
        path: input.path,
        sourceKey: input.sourceKey,
        args: input.args,
        executionContext: input.executionContext,
        elicitation,
      }).pipe(
        Effect.flatMap((response) =>
          response.action === "accept"
            ? Effect.succeed(undefined)
            : Effect.fail(
                new McpToolsError({
                  stage: "call_tool",
                  message: `URL elicitation was not accepted for ${input.toolName}`,
                  details: response.action,
                }),
              )),
      ),
    { discard: true },
  );

const callMcpTool = (input: {
  client: McpClientLike;
  toolName: string;
  args: Record<string, unknown>;
}): Effect.Effect<unknown, unknown> =>
  Effect.tryPromise({
    try: () =>
      input.client.callTool({
        name: input.toolName,
        arguments: input.args,
      }),
    catch: (cause) => cause,
  });

const toToolExecutionContext = (
  input: McpDiscoveryElicitationContext | undefined,
): ToolExecutionContext | undefined =>
  input
    ? {
        path: input.path,
        sourceKey: input.sourceKey,
        metadata: input.metadata,
        invocation: input.invocation,
        onElicitation: input.onElicitation,
      }
    : undefined;

const runMcpListToolsEffect = (input: {
  connection: McpConnection;
  mcpDiscoveryElicitation?: McpDiscoveryElicitationContext;
}): Effect.Effect<unknown, McpToolsError> =>
  Effect.gen(function* () {
    const executionContext = toToolExecutionContext(input.mcpDiscoveryElicitation);

    if (input.mcpDiscoveryElicitation) {
      yield* installMcpElicitationHandler({
        client: input.connection.client,
        toolName: "tools/list",
        onElicitation: input.mcpDiscoveryElicitation.onElicitation,
        path: input.mcpDiscoveryElicitation.path,
        sourceKey: input.mcpDiscoveryElicitation.sourceKey,
        args: input.mcpDiscoveryElicitation.args,
        executionContext,
      });
    }

    let retries = 0;
    while (true) {
      const attempt = yield* Effect.either(
        Effect.tryPromise({
          try: () => input.connection.client.listTools(),
          catch: (cause) => cause,
        }),
      );

      if (Either.isRight(attempt)) {
        return attempt.right;
      }

      if (isExecutionSuspendedCause(attempt.left)) {
        return yield* (attempt.left as McpToolsError);
      }

      if (
        input.mcpDiscoveryElicitation
        && isUrlElicitationRequiredError(attempt.left)
        && retries < 2
      ) {
        yield* resolveUrlElicitations({
          cause: attempt.left,
          toolName: "tools/list",
          onElicitation: input.mcpDiscoveryElicitation.onElicitation,
          path: input.mcpDiscoveryElicitation.path,
          sourceKey: input.mcpDiscoveryElicitation.sourceKey,
          args: input.mcpDiscoveryElicitation.args,
          executionContext,
        });
        retries += 1;
        continue;
      }

      return yield* new McpToolsError({
          stage: "list_tools",
          message: "Failed listing MCP tools",
          details: toDetails(attempt.left),
        });
    }
  });

const runMcpToolCallEffect = (input: {
  connection: McpConnection;
  toolName: string;
  path: ToolPath;
  sourceKey: string;
  args: Record<string, unknown>;
  executionContext?: ToolExecutionContext;
}): Effect.Effect<unknown, McpToolsError> =>
  Effect.gen(function* () {
    const onElicitation = input.executionContext?.onElicitation;
    if (onElicitation) {
      yield* installMcpElicitationHandler({
        client: input.connection.client,
        toolName: input.toolName,
        onElicitation,
        path: input.path,
        sourceKey: input.sourceKey,
        args: input.args,
        executionContext: input.executionContext,
      });
    }

    let retries = 0;
    while (true) {
      const attempt = yield* Effect.either(
        callMcpTool({
          client: input.connection.client,
          toolName: input.toolName,
          args: input.args,
        }),
      );

      if (Either.isRight(attempt)) {
        return attempt.right;
      }

      if (isExecutionSuspendedCause(attempt.left)) {
        return yield* (attempt.left as McpToolsError);
      }

      if (
        onElicitation
        && isUrlElicitationRequiredError(attempt.left)
        && retries < 2
      ) {
        yield* resolveUrlElicitations({
          cause: attempt.left,
          toolName: input.toolName,
          onElicitation,
          path: input.path,
          sourceKey: input.sourceKey,
          args: input.args,
          executionContext: input.executionContext,
        });
        retries += 1;
        continue;
      }

      return yield* new McpToolsError({
          stage: "call_tool",
          message: `Failed invoking MCP tool: ${input.toolName}`,
          details: toDetails(attempt.left),
        });
    }
  });

export const createMcpConnectorFromClient = (
  client: McpClientLike,
): McpConnector =>
  Effect.succeed({
    client,
    close: async () => undefined,
  });

export const createMcpToolsFromManifest = (input: {
  manifest: McpToolManifest;
  connect: McpConnector;
  namespace?: string;
  sourceKey?: string;
}): ToolMap => {
  const sourceKey = input.sourceKey ?? "mcp.generated";

  return Object.fromEntries(
    input.manifest.tools.map((entry) => {
      const path = joinToolPath(input.namespace, entry.toolId);

      return [
        path,
        toTool({
          tool: {
            description: entry.description ?? `MCP tool: ${entry.toolName}`,
            inputSchema: inputSchemaFromManifest(entry.inputSchema),
            execute: async (args: unknown, executionContext?: ToolExecutionContext) => {
              const exit = await Effect.runPromiseExit(
                withConnectionEffect({
                  connect: input.connect,
                  onConnectError: (cause) =>
                    new McpToolsError({
                      stage: "connect",
                      message: `Failed connecting to MCP server for ${entry.toolName}`,
                      details: toDetails(cause),
                    }),
                  run: (connection) => {
                    const payloadArgs = readUnknownRecord(args);
                    const callEffect = runMcpToolCallEffect({
                      connection,
                      toolName: entry.toolName,
                      path,
                      sourceKey,
                      args: payloadArgs,
                      executionContext,
                    });

                    return executionContext?.onElicitation
                      ? withElicitationClientLock(connection.client, callEffect)
                      : callEffect;
                  },
                }),
              );
              if (Exit.isSuccess(exit)) return exit.value;
              throw Cause.squash(exit.cause);
            },
          },
          metadata: {
            sourceKey,
            contract: {
              ...(entry.inputSchema !== undefined
                ? { inputSchema: entry.inputSchema }
                : {}),
              ...(entry.outputSchema !== undefined
                ? { outputSchema: entry.outputSchema }
                : {}),
            },
          },
        }),
      ] as const;
    }),
  );
};

export const discoverMcpToolsFromConnector = (input: {
  connect: McpConnector;
  namespace?: string;
  sourceKey?: string;
  mcpDiscoveryElicitation?: McpDiscoveryElicitationContext;
}): Effect.Effect<{ manifest: McpToolManifest; tools: ToolMap }, McpToolsError> =>
  Effect.gen(function* () {
    const listed = yield* withConnectionEffect({
      connect: input.connect,
      onConnectError: (cause) =>
        new McpToolsError({
          stage: "connect",
          message: "Failed connecting to MCP server",
          details: toDetails(cause),
        }),
      run: (connection) => {
        const listEffect = runMcpListToolsEffect({
          connection,
          mcpDiscoveryElicitation: input.mcpDiscoveryElicitation,
        });

        const settledListEffect = input.mcpDiscoveryElicitation
          ? withElicitationClientLock(connection.client, listEffect)
          : listEffect;

        return Effect.map(settledListEffect, (listed) => ({
          listed,
          serverInfo: connection.client.getServerVersion?.(),
          serverCapabilities: connection.client.getServerCapabilities?.(),
          instructions: connection.client.getInstructions?.(),
        }));
      },
    });

    const manifest = extractMcpToolManifestFromListToolsResult(
      listed.listed,
      {
        serverInfo: listed.serverInfo,
        serverCapabilities: listed.serverCapabilities,
        instructions: listed.instructions,
      },
    );

    return {
      manifest,
      tools: createMcpToolsFromManifest({
        manifest,
        connect: input.connect,
        namespace: input.namespace,
        sourceKey: input.sourceKey,
      }),
    };
  });

export const discoverMcpToolsFromClient = (input: {
  client: McpClientLike;
  namespace?: string;
  sourceKey?: string;
}): Effect.Effect<{ manifest: McpToolManifest; tools: ToolMap }, McpToolsError> =>
  discoverMcpToolsFromConnector({
    connect: createMcpConnectorFromClient(input.client),
    namespace: input.namespace,
    sourceKey: input.sourceKey,
  });
