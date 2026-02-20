import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { Result } from "better-result";
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
const APPROVAL_SUBSCRIPTION_TIMEOUT_MS = 10 * 60 * 1000;

type RuntimeCallbackConfig = {
  callbackConvexUrl: string;
  callbackInternalSecret: string;
};

function toRecord(value: unknown): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  return value === undefined ? {} : { value };
}

function getRuntimeCallbackConfig(): RuntimeCallbackConfig {
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

  constructor(private readonly callbackConfig: RuntimeCallbackConfig) {
    this.client = new ConvexHttpClient(callbackConfig.callbackConvexUrl, {
      skipConvexDeploymentUrlCheck: true,
    });
  }

  private createRealtimeClient(): ConvexClient {
    return new ConvexClient(this.callbackConfig.callbackConvexUrl, {
      skipConvexDeploymentUrlCheck: true,
    });
  }

  private async waitForApprovalUpdate(runId: string, approvalId: string): Promise<void> {
    const client = this.createRealtimeClient();

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        client.close();
        reject(new Error(`Timed out waiting for approval update: ${approvalId}`));
      }, APPROVAL_SUBSCRIPTION_TIMEOUT_MS);

      const unsubscribe = client.onUpdate(
        api.runtimeCallbacks.getApprovalStatus,
        {
          internalSecret: this.callbackConfig.callbackInternalSecret,
          runId,
          approvalId,
        },
        (value: { status?: "pending" | "approved" | "denied" | "missing" } | null | undefined) => {
          const status = value?.status;
          if (!status || status === "pending") {
            return;
          }

          if (status === "missing") {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe();
            client.close();
            reject(new Error(`Approval not found: ${approvalId}`));
            return;
          }

          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          client.close();
          resolve();
        },
      );
    });
  }

  async invokeTool(call: ToolCallRequest): Promise<ToolCallResult> {
    while (true) {
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

      if (!parsed.ok && parsed.kind === "pending") {
        const waitResult = await Result.tryPromise(() => this.waitForApprovalUpdate(call.runId, parsed.approvalId));
        if (waitResult.isErr()) {
          return {
            ok: false,
            kind: "failed",
            error: `Node runtime approval subscription failed: ${describeError(waitResult.error.cause)}`,
          };
        }
        continue;
      }

      return parsed;
    }
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
