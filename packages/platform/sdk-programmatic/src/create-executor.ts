import {
  type ToolMap,
  unknownInputSchema,
} from "@executor/codemode-core";
import {
  createExecutorBackend,
  type ExecutorBackend,
} from "@executor/platform-sdk/backend";
import {
  createExecutor as createInnerExecutor,
  type Executor,
} from "@executor/platform-sdk/executor";
import {
  createLocalExecutorBackend,
} from "@executor/platform-sdk-file";
import * as Effect from "effect/Effect";

import { createElicitationAdapter } from "./elicitation-adapter";
import { createMemoryBackend } from "./memory-storage";
import type {
  CreateExecutorOptions,
  CustomStorageOptions,
  ExecuteResult,
  ExecutorSDK,
  FileStorageOptions,
  ToolsOption,
} from "./types";

const buildToolMap = (tools: ToolsOption): ToolMap => {
  const toolMap: ToolMap = {};
  for (const [path, tool] of Object.entries(tools)) {
    toolMap[path] = {
      description: tool.description,
      inputSchema: tool.inputSchema ?? unknownInputSchema,
      execute: tool.execute,
    };
  }
  return toolMap;
};

const isCustomStorage = (storage: unknown): storage is CustomStorageOptions =>
  typeof storage === "object" &&
  storage !== null &&
  "loadRepositories" in storage &&
  typeof (storage as CustomStorageOptions).loadRepositories === "function";

const isExecutorBackend = (storage: unknown): storage is ExecutorBackend =>
  typeof storage === "object" &&
  storage !== null &&
  "createRuntime" in storage &&
  typeof (storage as ExecutorBackend).createRuntime === "function";

const isFileStorage = (storage: unknown): storage is FileStorageOptions =>
  typeof storage === "object" &&
  storage !== null &&
  "kind" in storage &&
  (storage as FileStorageOptions).kind === "file";

const resolveBackend = (options: CreateExecutorOptions): ExecutorBackend => {
  const storage = options.storage ?? "memory";

  if (storage === "memory") {
    return createMemoryBackend(options);
  }

  if (isFileStorage(storage)) {
    if (storage.fs) {
      console.warn(
        "@executor/sdk: Custom `fs` in file storage is not yet supported. Using default Node.js filesystem.",
      );
    }
    return createLocalExecutorBackend({
      cwd: storage.cwd,
      workspaceRoot: storage.workspaceRoot,
    });
  }

  if (isCustomStorage(storage)) {
    return createExecutorBackend({
      loadRepositories: storage.loadRepositories as Parameters<
        typeof createExecutorBackend
      >[0]["loadRepositories"],
    });
  }

  if (isExecutorBackend(storage)) {
    return storage;
  }

  throw new Error("Invalid storage option");
};

const parseResult = (value: string | null): unknown => {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const parseInteractionPayload = (json: string): {
  path?: string;
  sourceKey?: string;
  args?: unknown;
  context?: Record<string, unknown>;
  elicitation?: {
    mode?: string;
    message?: string;
    url?: string;
    elicitationId?: string;
    requestedSchema?: Record<string, unknown>;
  };
} => {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
};

const MAX_INTERACTION_LOOPS = 50;

/**
 * Executes code and automatically handles interactions (tool approvals, auth flows).
 *
 * Uses `interactionMode: "detach"` so the execution suspends on interactions.
 * We detect the pending interaction, run the SDK's callback, then resume.
 * This loop continues until the execution completes or fails.
 */
const createExecuteFunction = (
  inner: Executor,
  options: CreateExecutorOptions,
) => {
  const elicitationAdapter = createElicitationAdapter({
    onToolApproval: options.onToolApproval,
    onInteraction: options.onInteraction,
  });

  return async (code: string): Promise<ExecuteResult> => {
    let envelope = await inner.executions.create({ code });
    let loops = 0;

    while (
      envelope.execution.status === "waiting_for_interaction" &&
      envelope.pendingInteraction !== null &&
      loops < MAX_INTERACTION_LOOPS
    ) {
      loops++;

      const interaction = envelope.pendingInteraction;
      const payload = parseInteractionPayload(interaction.payloadJson);

      // Run our elicitation adapter to get the response
      const elicitationRequest = {
        interactionId: interaction.id,
        path: (payload.path ?? "") as any,
        sourceKey: payload.sourceKey ?? "",
        args: payload.args,
        context: payload.context,
        elicitation: payload.elicitation as any,
      };

      let responseJson: string;
      try {
        const response = await Effect.runPromise(
          elicitationAdapter(elicitationRequest),
        );
        responseJson = JSON.stringify(response);
      } catch (err) {
        // If the adapter fails, cancel the interaction
        responseJson = JSON.stringify({ action: "cancel" });
      }

      envelope = await inner.executions.resume(
        envelope.execution.id,
        { responseJson },
      );
    }

    const execution = envelope.execution;

    return {
      result: parseResult(execution.resultJson),
      error: execution.errorText ?? undefined,
      logs: execution.logsJson
        ? (parseResult(execution.logsJson) as string[] | undefined) ?? undefined
        : undefined,
    };
  };
};

export const createExecutor = async (
  options: CreateExecutorOptions = {},
): Promise<ExecutorSDK> => {
  const backend = resolveBackend(options);

  const createInternalToolMap = options.tools
    ? () => buildToolMap(options.tools!)
    : undefined;

  // Pass custom CodeExecutor if runtime is an object (not a string builtin name)
  const customCodeExecutor =
    options.runtime && typeof options.runtime !== "string"
      ? options.runtime
      : undefined;

  const inner = await createInnerExecutor({
    backend,
    createInternalToolMap,
    customCodeExecutor,
  });

  const execute = createExecuteFunction(inner, options);

  return {
    execute,
    sources: inner.sources,
    policies: inner.policies,
    secrets: inner.secrets,
    oauth: inner.oauth,
    local: inner.local,
    close: inner.close,
  };
};
