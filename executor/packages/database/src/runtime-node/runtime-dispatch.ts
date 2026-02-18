import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { api } from "../../convex/_generated/api";
import { dispatchCodeWithCloudflareWorkerLoader } from "../../../core/src/runtimes/cloudflare/worker/loader-runtime";
import { runCodeWithAdapter } from "../../../core/src/runtimes/runtime-core";
import { decodeToolCallResultFromTransport } from "../../../core/src/tool-call-result-transport";
import type {
  ExecutionAdapter,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  ToolCallRequest,
  ToolCallResult,
} from "../../../core/src/types";
import { describeError } from "../../../core/src/utils";

const recordSchema = z.record(z.unknown());

function toRecord(value: unknown): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  return value === undefined ? {} : { value };
}

function getRuntimeCallbackConfig(): {
  callbackConvexUrl: string;
  callbackInternalSecret: string;
} {
  const callbackConvexUrl = process.env.CONVEX_URL ?? process.env.CONVEX_SITE_URL;
  if (!callbackConvexUrl) {
    throw new Error("Node runtime requires CONVEX_URL or CONVEX_SITE_URL for runtime callbacks");
  }

  const callbackInternalSecret = process.env.EXECUTOR_INTERNAL_TOKEN;
  if (!callbackInternalSecret) {
    throw new Error("Node runtime requires EXECUTOR_INTERNAL_TOKEN for runtime callbacks");
  }

  return { callbackConvexUrl, callbackInternalSecret };
}

class CallbackExecutionAdapter implements ExecutionAdapter {
  private readonly client: ConvexHttpClient;

  constructor(private readonly callbackConfig: { callbackInternalSecret: string; callbackConvexUrl: string }) {
    this.client = new ConvexHttpClient(callbackConfig.callbackConvexUrl, {
      skipConvexDeploymentUrlCheck: true,
    });
  }

  async invokeTool(call: ToolCallRequest): Promise<ToolCallResult> {
    const response = await this.client.action(api.runtimeCallbacks.handleToolCall, {
      internalSecret: this.callbackConfig.callbackInternalSecret,
      runId: call.runId,
      callId: call.callId,
      toolPath: call.toolPath,
      input: toRecord(call.input),
    }).catch((error: unknown) => ({
      ok: false,
      kind: "failed",
      error: `Node runtime callback failed: ${describeError(error)}`,
    } as const));

    const parsed = decodeToolCallResultFromTransport(response);
    if (!parsed) {
      return {
        ok: false,
        kind: "failed",
        error: "Node runtime callback returned invalid payload",
      };
    }
    return parsed;
  }
}

export async function executeLocalVmRun(
  request: SandboxExecutionRequest,
): Promise<SandboxExecutionResult> {
  const callbackConfig = getRuntimeCallbackConfig();
  const adapter = new CallbackExecutionAdapter(callbackConfig);
  return await runCodeWithAdapter(request, adapter);
}

export async function dispatchCloudflareWorkerRun(
  request: SandboxExecutionRequest,
) {
  return await dispatchCodeWithCloudflareWorkerLoader(request);
}
