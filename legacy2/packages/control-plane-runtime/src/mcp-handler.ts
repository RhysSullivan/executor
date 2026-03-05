import {
  buildExecuteToolDescription,
  defaultExecuteToolDescription,
  defaultExecuteToolExposureMode,
  parseExecuteToolExposureMode,
  type ExecuteToolExposureMode,
  type ToolRegistry,
} from "@executor-v2/engine";
import {
  type ExecuteRunInput,
  type ExecuteRunResult,
  createExecutorRunClient,
} from "@executor-v2/sdk";
import { handleMcpHttpRequest } from "@executor-v2/mcp-gateway";
import * as Effect from "effect/Effect";

export type RuntimeHostMcpHandlerOptions = {
  toolRegistry: ToolRegistry;
  defaultToolExposureMode?: ExecuteToolExposureMode;
};

const readToolExposureModeFromRequest = (
  request: Request,
  fallback: ExecuteToolExposureMode,
): ExecuteToolExposureMode => {
  const url = new URL(request.url);
  const rawMode =
    url.searchParams.get("toolExposureMode") ??
    url.searchParams.get("toolContextMode") ??
    undefined;

  return parseExecuteToolExposureMode(rawMode ?? undefined) ?? fallback;
};

const resolveExecuteToolDescription = async (
  toolRegistry: ToolRegistry,
  mode: ExecuteToolExposureMode,
): Promise<string> => {
  try {
    return await Effect.runPromise(
      buildExecuteToolDescription({
        toolRegistry,
        mode,
      }),
    );
  } catch {
    return defaultExecuteToolDescription;
  }
};

export const createRuntimeHostMcpHandler = (
  executeRun: (input: ExecuteRunInput) => Effect.Effect<ExecuteRunResult>,
  options: RuntimeHostMcpHandlerOptions,
): ((request: Request) => Promise<Response>) => {
  const runClient = createExecutorRunClient((input) =>
    Effect.runPromise(executeRun(input)),
  );

  const defaultMode =
    options.defaultToolExposureMode ?? defaultExecuteToolExposureMode;

  return async (request: Request) => {
    const mode = readToolExposureModeFromRequest(request, defaultMode);
    const executeToolDescription = await resolveExecuteToolDescription(
      options.toolRegistry,
      mode,
    );

    return handleMcpHttpRequest(request, {
      serverName: "executor-v2-runtime-host",
      serverVersion: "0.0.0",
      runClient,
      executeToolDescription,
    });
  };
};
