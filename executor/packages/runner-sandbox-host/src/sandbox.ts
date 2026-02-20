import { z } from "zod";
import type { Env, RunRequest, RunResult } from "./types";
import { getEntrypointExports } from "./bridge";

const DEFAULT_TASK_TIMEOUT_MS = 300_000;
const MAX_TASK_TIMEOUT_MS = 900_000;

const runResultSchema: z.ZodType<RunResult> = z.object({
  status: z.enum(["completed", "failed", "timed_out", "denied"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
  exitCode: z.number().optional(),
});

/**
 * Build the user code module. The code is wrapped in an exported async
 * function `run(tools, console)` so the harness can call it with controlled
 * scope bindings. The user code runs in a separate module from the harness
 * and cannot access `req`, `env`, `ctx`, or `Response`.
 */
function buildUserModule(userCode: string): string {
  return `export async function run(tools, console) {\n"use strict";\n${userCode}\n}\n`;
}

export async function executeSandboxRun(
  request: RunRequest,
  ctx: ExecutionContext,
  env: Env,
  harnessCode: string,
  globalsModule: string,
): Promise<RunResult> {
  const timeoutMsRaw = request.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const timeoutMs = Math.max(1, Math.min(MAX_TASK_TIMEOUT_MS, Math.floor(timeoutMsRaw)));
  const isolateId = request.taskId;

  const ctxExports = getEntrypointExports(ctx);

  const toolBridgeBinding = ctxExports.ToolBridge({
    props: {
      callbackConvexUrl: request.callback.convexUrl,
      callbackInternalSecret: request.callback.internalSecret,
      taskId: request.taskId,
    },
  });

  const worker = env.LOADER.get(isolateId, async () => ({
    compatibilityDate: "2025-06-01",
    mainModule: "harness.js",
    modules: {
      "harness.js": harnessCode,
      "globals.js": globalsModule,
      "user-code.js": buildUserModule(request.code),
    },
    env: {
      TOOL_BRIDGE: toolBridgeBinding,
    },
    globalOutbound: null,
  }));

  const entrypoint = worker.getEntrypoint();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await entrypoint.fetch("http://sandbox.internal/run", {
      method: "POST",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        status: "timed_out",
        error: `Execution timed out after ${timeoutMs}ms`,
      };
    }
    throw error;
  }

  clearTimeout(timer);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      status: "failed",
      error: "Sandbox isolate returned invalid JSON",
    };
  }

  const parsedBody = runResultSchema.safeParse(body);
  if (!parsedBody.success) {
    return {
      status: "failed",
      error: "Sandbox isolate returned invalid response payload",
    };
  }

  return parsedBody.data;
}
