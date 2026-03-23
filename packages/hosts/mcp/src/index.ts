import type {
  ExecutionEnvelope,
} from "@executor/platform-sdk/schema";
import {
  EXECUTOR_SOURCES_ADD_HELP_LINES,
  RuntimeSourceCatalogStoreService,
  createExecution,
  getExecution,
  hasRegisteredExecutorAddableSourceAdapters,
  resumeExecution,
  type ExecutorRuntime,
} from "@executor/platform-sdk/runtime";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod/v4";

import {
  buildPausedResultText,
  parseInteractionPayload,
} from "./paused-result";

const pollingIntervalMs = 200;

const executeInputSchema = {
  code: z.string().trim().min(1),
};

const resumeInputSchema = {
  resumePayload: z.object({
    executionId: z.string().trim().min(1),
  }),
  response: z.object({
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
};

type ResumePayload = {
  executionId: string;
};

type ResumeResponseInput = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

type ExecutorMcpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

export type ExecutorMcpRequestHandler = {
  handleRequest: (request: Request) => Promise<Response>;
  close: () => Promise<void>;
};

const waitForProcessExit = () =>
  new Promise<void>((resolve) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      process.off("disconnect", finish);
      process.stdin.off("end", finish);
      process.stdin.off("close", finish);
      resolve();
    };

    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    process.once("disconnect", finish);
    process.stdin.once("end", finish);
    process.stdin.once("close", finish);
  });

const parseJsonValue = (value: string | null): unknown => {
  if (value === null) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const maxResultPreviewChars = 30_000;

const truncateText = (value: string, maxLength: number): string =>
  value.length > maxLength
    ? `${value.slice(0, maxLength)}\n... [result preview truncated ${value.length - maxLength} chars]`
    : value;

const formatResultPreview = (resultJson: string): string => {
  try {
    const parsed = JSON.parse(resultJson) as unknown;
    const serialized = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2) ?? String(parsed);
    return truncateText(serialized, maxResultPreviewChars);
  } catch {
    return truncateText(resultJson, maxResultPreviewChars);
  }
};
const runControlPlane = async <A, E, R>(
  runtime: ExecutorRuntime,
  effect: Effect.Effect<A, E, R>,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(
    effect.pipe(Effect.provide(runtime.runtimeLayer)) as Effect.Effect<A, E, never>,
  );

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  const error = Cause.squash(exit.cause);
  if (error instanceof Error) {
    // Preserve the original error with its stack trace and message rather
    // than wrapping it in an opaque FiberFailure.
    throw error;
  }
  throw error;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const supportsManagedElicitation = (server: McpServer): boolean => {
  const capabilities = server.server.getClientCapabilities();
  return Boolean(capabilities?.elicitation?.form) && Boolean(capabilities?.elicitation?.url);
};

const interactionModeForServer = (server: McpServer): "live_form" | "detach" =>
  supportsManagedElicitation(server) ? "live_form" : "detach";

type CatalogLike = {
  projected: {
    toolDescriptors: Record<string, { toolPath: readonly string[] }>;
  };
  source: {
    name: string;
    enabled: boolean;
    status: string;
  };
};

const executeDescriptionToolsPerSource = 5;

const buildExecuteWorkflowText = (
  sourceToolExamples: ReadonlyArray<{
    sourceName: string;
    toolPaths: readonly string[];
  }> = [],
): string =>
  [
    "Execute TypeScript in sandbox; call tools via discovery workflow.",
    ...(sourceToolExamples.length > 0
      ? [
          "Available source tool examples:",
          ...sourceToolExamples.flatMap((source) => [
            `${source.sourceName}:`,
            ...source.toolPaths.map((toolPath) => `- ${toolPath}`),
          ]),
        ]
      : []),
    "Workflow:",
    '1) const matches = await tools.discover({ query: "<intent>", limit: 12 });',
    "2) const details = await tools.describe.tool({ path, includeSchemas: true });",
    "3) Call selected tools.<path>(input).",
    ...(hasRegisteredExecutorAddableSourceAdapters
      ? [
          "4) To connect a source plugin, call tools.executor.sources.add(...).",
          ...EXECUTOR_SOURCES_ADD_HELP_LINES,
          "5) If execution pauses for interaction, resume it with the returned resumePayload or the available resume flow.",
        ]
      : [
          "4) Source plugins are not registered in this build.",
          "5) If execution pauses for interaction, resume it with the returned resumePayload or the available resume flow.",
        ]),
    "Do not use fetch; use tools.* only.",
  ].join("\n");

const defaultExecuteDescription = buildExecuteWorkflowText();

const loadExecuteDescription = (runtime: ExecutorRuntime): Promise<string> =>
  runControlPlane(
    runtime,
    Effect.gen(function* () {
      const sourceCatalogStore = yield* RuntimeSourceCatalogStoreService;
      const catalogs = yield* sourceCatalogStore.loadWorkspaceSourceCatalogs({
        scopeId: runtime.localInstallation.scopeId,
        actorScopeId: runtime.localInstallation.actorScopeId,
      });

      const sourceToolExamples = (catalogs as ReadonlyArray<CatalogLike>)
        .filter((catalog) => catalog.source.enabled && catalog.source.status === "connected")
        .map((catalog) => ({
          sourceName: catalog.source.name,
          toolPaths: Object.values(catalog.projected.toolDescriptors)
            .map((descriptor) => descriptor.toolPath.join("."))
            .filter((toolPath) => toolPath.length > 0)
            .sort((left, right) => left.localeCompare(right))
            .slice(0, executeDescriptionToolsPerSource),
        }))
        .filter((catalog) => catalog.toolPaths.length > 0);

      if (sourceToolExamples.length === 0) {
        return defaultExecuteDescription;
      }

      return buildExecuteWorkflowText(sourceToolExamples);
    }).pipe(Effect.catchAll(() => Effect.succeed(defaultExecuteDescription))),
  );

const summarizeExecution = (execution: ExecutionEnvelope["execution"]): string => {
  switch (execution.status) {
    case "completed": {
      if (execution.resultJson === null) {
        return `Execution ${execution.id} completed.`;
      }

      return `Execution ${execution.id} completed.\nResult:\n${formatResultPreview(execution.resultJson)}`;
    }
    case "failed":
      return execution.errorText
        ? `Execution ${execution.id} failed: ${execution.errorText}`
        : `Execution ${execution.id} failed.`;
    case "waiting_for_interaction":
      return `Execution ${execution.id} is waiting for interaction.`;
    default:
      return `Execution ${execution.id} is ${execution.status}.`;
  }
};

const executionStructuredContent = (envelope: ExecutionEnvelope): Record<string, unknown> => ({
  executionId: envelope.execution.id,
  status: envelope.execution.status,
  result: parseJsonValue(envelope.execution.resultJson),
  errorText: envelope.execution.errorText,
  logs: parseJsonValue(envelope.execution.logsJson),
});

const buildFinalResult = (
  envelope: ExecutionEnvelope,
  options: { isError?: boolean } = {},
): ExecutorMcpToolResult => ({
  content: [{ type: "text", text: summarizeExecution(envelope.execution) }],
  structuredContent: executionStructuredContent(envelope),
  ...(options.isError ? { isError: true } : {}),
});

const buildPausedResult = (envelope: ExecutionEnvelope): ExecutorMcpToolResult => {
  const interaction = envelope.pendingInteraction;
  const parsed = interaction ? parseInteractionPayload(interaction) : null;

  return {
    content: [{
      type: "text",
      text: buildPausedResultText(envelope),
    }],
    structuredContent: {
      executionId: envelope.execution.id,
      status: "waiting_for_interaction",
      interaction: interaction
        ? {
            id: interaction.id,
            purpose: interaction.purpose,
            kind: interaction.kind,
            message: parsed?.message ?? "Interaction required",
            mode: parsed?.mode ?? (interaction.kind === "url" ? "url" : "form"),
            url: parsed?.url ?? null,
            requestedSchema: parsed?.requestedSchema ?? null,
          }
        : null,
      resumePayload: {
        executionId: envelope.execution.id,
      } satisfies ResumePayload,
    },
  };
};

const buildToolResult = (envelope: ExecutionEnvelope): ExecutorMcpToolResult => {
  switch (envelope.execution.status) {
    case "completed":
      return buildFinalResult(envelope);
    case "failed":
    case "cancelled":
      return buildFinalResult(envelope, { isError: true });
    case "waiting_for_interaction":
      return buildPausedResult(envelope);
    default:
      return buildFinalResult(envelope);
  }
};

const waitForInteractionProgress = async (input: {
  runtime: ExecutorRuntime;
  scopeId: string;
  executionId: string;
  pendingInteractionId: string;
}): Promise<ExecutionEnvelope> => {
  while (true) {
    const next = await runControlPlane(
      input.runtime,
      getExecution({
        scopeId: input.scopeId as never,
        executionId: input.executionId as never,
      }),
    );

    if (
      next.execution.status !== "waiting_for_interaction"
      || next.pendingInteraction?.id !== input.pendingInteractionId
    ) {
      return next;
    }

    await sleep(pollingIntervalMs);
  }
};

const driveExecutionWithElicitation = async (input: {
  runtime: ExecutorRuntime;
  scopeId: string;
  actorScopeId: string;
  server: McpServer;
  envelope: ExecutionEnvelope;
}): Promise<ExecutionEnvelope> => {
  let current = input.envelope;

  while (current.execution.status === "waiting_for_interaction") {
    const pending = current.pendingInteraction;
    if (pending === null) {
      return current;
    }

    const parsed = parseInteractionPayload(pending);
    if (!parsed) {
      return current;
    }

    if (parsed.mode === "form") {
      const response = await input.server.server.elicitInput({
        mode: "form",
        message: parsed.message,
        requestedSchema: (parsed.requestedSchema ?? {
          type: "object",
          properties: {},
        }) as never,
      });

      current = await runControlPlane(
        input.runtime,
        resumeExecution({
          scopeId: input.scopeId as never,
          executionId: current.execution.id as never,
          payload: {
            responseJson: JSON.stringify(response),
            interactionMode: interactionModeForServer(input.server),
          },
          resumedByScopeId: input.actorScopeId as never,
        }),
      );
      continue;
    }

    const response = await input.server.server.elicitInput({
      mode: "url",
      message: parsed.message,
      url: parsed.url ?? "",
      elicitationId: parsed.elicitationId ?? pending.id,
    });

    if (response.action !== "accept") {
      current = await runControlPlane(
        input.runtime,
        resumeExecution({
          scopeId: input.scopeId as never,
          executionId: current.execution.id as never,
          payload: {
            responseJson: JSON.stringify(response),
            interactionMode: interactionModeForServer(input.server),
          },
          resumedByScopeId: input.actorScopeId as never,
        }),
      );
      continue;
    }

    current = await waitForInteractionProgress({
      runtime: input.runtime,
      scopeId: input.scopeId,
      executionId: current.execution.id,
      pendingInteractionId: pending.id,
    });
  }

  return current;
};

const driveExecutionWithoutElicitation = async (input: {
  runtime: ExecutorRuntime;
  scopeId: string;
  actorScopeId: string;
  executionId: string;
  initialResponse?: ResumeResponseInput;
}): Promise<ExecutionEnvelope> => {
  let current = await runControlPlane(
    input.runtime,
    getExecution({
      scopeId: input.scopeId as never,
      executionId: input.executionId as never,
    }),
  );
  let response = input.initialResponse;

  while (current.execution.status === "waiting_for_interaction") {
    const pending = current.pendingInteraction;
    if (pending === null || response === undefined) {
      return current;
    }

    current = await runControlPlane(
      input.runtime,
        resumeExecution({
          scopeId: input.scopeId as never,
          executionId: current.execution.id as never,
          payload: {
            responseJson: JSON.stringify(response),
            interactionMode: "detach",
          },
          resumedByScopeId: input.actorScopeId as never,
        }),
    );
    response = undefined;
  }

  return current;
};

const createExecutorMcpServer = async (config: {
  runtime: ExecutorRuntime;
}): Promise<McpServer> => {
  const executeDescription = await loadExecuteDescription(config.runtime);
  const server = new McpServer(
    { name: "executor", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const scopeId = config.runtime.localInstallation.scopeId;
  const actorScopeId = config.runtime.localInstallation.actorScopeId;

  const executeTool = server.registerTool(
    "execute",
    {
      description: executeDescription,
      inputSchema: executeInputSchema,
    },
    async ({ code }: { code: string }) => {
      let created = await runControlPlane(
        config.runtime,
        createExecution({
          scopeId,
          payload: {
            code,
            interactionMode: interactionModeForServer(server),
          },
          createdByScopeId: actorScopeId,
        }),
      );

      if (supportsManagedElicitation(server)) {
        created = await driveExecutionWithElicitation({
          runtime: config.runtime,
          scopeId,
          actorScopeId,
          server,
          envelope: created,
        });
      }

      return buildToolResult(created);
    },
  );

  const resumeTool = server.registerTool(
    "resume",
    {
      description: [
        "Resume a paused executor execution using the resumePayload returned by execute.",
        "Never call this without getting approval from the user first unless they explicitly state otherwise.",
      ].join("\n"),
      inputSchema: resumeInputSchema,
    },
    async (
      input: {
        resumePayload: ResumePayload;
        response?: ResumeResponseInput;
      },
    ) => {
      const resumed = await driveExecutionWithoutElicitation({
        runtime: config.runtime,
        scopeId,
        actorScopeId,
        executionId: input.resumePayload.executionId,
        initialResponse: input.response,
      });

      return buildToolResult(resumed);
    },
  );

  const syncToolAvailability = () => {
    if (supportsManagedElicitation(server)) {
      executeTool.enable();
      resumeTool.disable();
      return;
    }

    executeTool.enable();
    resumeTool.enable();
  };

  syncToolAvailability();
  server.server.oninitialized = syncToolAvailability;

  return server;
};

export const runExecutorMcpStdioServer = async (runtime: ExecutorRuntime): Promise<void> => {
  const server = await createExecutorMcpServer({
    runtime,
  });
  const transport = new StdioServerTransport();

  try {
    await server.connect(transport);
    await waitForProcessExit();
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
};

const jsonErrorResponse = (status: number, code: number, message: string) =>
  new Response(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code,
      message,
    },
    id: null,
  }), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });

export const createExecutorMcpRequestHandler = (
  runtime: ExecutorRuntime,
): ExecutorMcpRequestHandler => {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();

  const disposeSession = async (
    sessionId: string,
    options: { closeTransport?: boolean; closeServer?: boolean } = {},
  ) => {
    const transport = transports.get(sessionId);
    const server = servers.get(sessionId);

    transports.delete(sessionId);
    servers.delete(sessionId);

    if (options.closeTransport) {
      await transport?.close().catch(() => undefined);
    }

    if (options.closeServer) {
      await server?.close().catch(() => undefined);
    }
  };

  return {
    handleRequest: async (request) => {
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) {
          return jsonErrorResponse(404, -32001, "Session not found");
        }

        return transport.handleRequest(request);
      }

      let createdServer: McpServer | undefined;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newSessionId) => {
          transports.set(newSessionId, transport);
          if (createdServer) {
            servers.set(newSessionId, createdServer);
          }
        },
        onsessionclosed: (closedSessionId) => {
          void disposeSession(closedSessionId, { closeServer: true });
        },
      });

      transport.onclose = () => {
        const closedSessionId = transport.sessionId;
        if (closedSessionId) {
          void disposeSession(closedSessionId, { closeServer: true });
        }
      };

      try {
        createdServer = await createExecutorMcpServer({
          runtime,
        });
        await createdServer.connect(transport);
        const response = await transport.handleRequest(request);

        if (!transport.sessionId) {
          await transport.close().catch(() => undefined);
          await createdServer.close().catch(() => undefined);
        }

        return response;
      } catch (error) {
        if (!transport.sessionId) {
          await transport.close().catch(() => undefined);
          await createdServer?.close().catch(() => undefined);
        }

        return jsonErrorResponse(
          500,
          -32603,
          error instanceof Error ? error.message : "Internal server error",
        );
      }
    },
    close: async () => {
      const sessionIds = new Set<string>([
        ...transports.keys(),
        ...servers.keys(),
      ]);

      await Promise.all(
        [...sessionIds].map((sessionId) =>
          disposeSession(sessionId, {
            closeTransport: true,
            closeServer: true,
          }),
        ),
      );
    },
  };
};
