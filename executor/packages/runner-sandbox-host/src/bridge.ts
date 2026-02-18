import { Result } from "better-result";
import { api } from "@executor/database/convex/_generated/api";
import { decodeToolCallResultFromTransport } from "../../core/src/tool-call-result-transport";
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import type {
  BridgeEntrypointContext,
  BridgeProps,
  ToolCallResult,
  WorkerEntrypointExports,
} from "./types";

const APPROVAL_SUBSCRIPTION_TIMEOUT_MS = 10 * 60 * 1000;

const bridgePropsSchema: z.ZodType<BridgeProps> = z.object({
  callbackConvexUrl: z.string(),
  callbackInternalSecret: z.string(),
  taskId: z.string(),
});

const recordSchema = z.record(z.unknown());

function hasToolBridgeExport(
  value: Record<string, unknown>,
): value is { ToolBridge: WorkerEntrypointExports["ToolBridge"] } {
  return typeof value.ToolBridge === "function";
}

function asObject(value: unknown): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function asRecord(value: unknown): Record<string, any> | undefined {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function getBridgePropsFromContext(
  ctx: BridgeEntrypointContext | ExecutionContext | null | undefined,
): BridgeProps {
  const context = asObject(ctx);
  if (Object.keys(context).length === 0) {
    throw new Error("WorkerEntrypoint context is unavailable");
  }

  const parsedProps = bridgePropsSchema.safeParse(context.props);
  if (!parsedProps.success) {
    throw new Error("ToolBridge props are missing or invalid");
  }

  return parsedProps.data;
}

export function getEntrypointExports(ctx: ExecutionContext): WorkerEntrypointExports {
  const context = asObject(ctx);
  const exportsValue = context.exports;

  if (!exportsValue || typeof exportsValue !== "object") {
    throw new Error("Execution context exports are unavailable");
  }

  const exportsObject = asObject(exportsValue);
  if (!hasToolBridgeExport(exportsObject)) {
    throw new Error("Execution context ToolBridge export is unavailable");
  }

  return { ToolBridge: exportsObject.ToolBridge };
}

function createConvexClient(callbackConvexUrl: string): ConvexHttpClient {
  return new ConvexHttpClient(callbackConvexUrl, {
    skipConvexDeploymentUrlCheck: true,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForApprovalUpdate(props: BridgeProps, approvalId: string): Promise<void> {
  const client = createConvexClient(props.callbackConvexUrl);
  const startedAt = Date.now();
  const pollIntervalMs = 1000;

  while (Date.now() - startedAt < APPROVAL_SUBSCRIPTION_TIMEOUT_MS) {
    const statusResult = await Result.tryPromise(() => client.query(api.runtimeCallbacks.getApprovalStatus, {
      internalSecret: props.callbackInternalSecret,
      runId: props.taskId,
      approvalId,
    }));

    if (statusResult.isErr()) {
      const cause = statusResult.error.cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Approval status poll failed: ${message}`);
    }

    const status = statusResult.value?.status;
    if (!status || status === "pending") {
      await sleep(pollIntervalMs);
      continue;
    }

    if (status === "missing") {
      throw new Error(`Approval not found: ${approvalId}`);
    }

    return;
  }

  throw new Error(`Timed out waiting for approval update: ${approvalId}`);
}

export async function callToolWithBridge(
  props: BridgeProps,
  toolPath: string,
  input: unknown,
  callId?: string,
): Promise<ToolCallResult> {
  const { callbackInternalSecret, taskId } = props;
  const effectiveCallId = callId && callId.trim().length > 0
    ? callId
    : `call_${crypto.randomUUID()}`;

  while (true) {
    const response = await Result.tryPromise(async () => {
      const convex = createConvexClient(props.callbackConvexUrl);
      return await convex.action(api.runtimeCallbacks.handleToolCall, {
        internalSecret: callbackInternalSecret,
        runId: taskId,
        callId: effectiveCallId,
        toolPath,
        input: asRecord(input),
      });
    });

    if (response.isErr()) {
      const cause = response.error.cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, kind: "failed", error: `Tool callback failed: ${message}` };
    }

    const parsedResult = decodeToolCallResultFromTransport(response.value);
    if (!parsedResult) {
      return { ok: false, kind: "failed", error: "Tool callback returned invalid result payload" };
    }
    const result = parsedResult;

    if (!result.ok && result.kind === "pending") {
      const approvalId = result.approvalId;
      const wait = await Result.tryPromise(() => waitForApprovalUpdate(props, approvalId));
      if (wait.isErr()) {
        const cause = wait.error.cause;
        const message = cause instanceof Error ? cause.message : String(cause);
        return { ok: false, kind: "failed", error: `Approval subscription failed: ${message}` };
      }
      continue;
    }

    return result;
  }
}
