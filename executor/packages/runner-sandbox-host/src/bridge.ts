import { Result } from "better-result";
import { api } from "@executor/database/convex/_generated/api";
import { decodeToolCallResultFromTransport } from "../../core/src/tool-call-result-transport";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
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

function createRealtimeClient(callbackConvexUrl: string): ConvexClient {
  return new ConvexClient(callbackConvexUrl, {
    skipConvexDeploymentUrlCheck: true,
  });
}

async function waitForApprovalUpdate(props: BridgeProps, approvalId: string): Promise<void> {
  const client = createRealtimeClient(props.callbackConvexUrl);

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
        internalSecret: props.callbackInternalSecret,
        runId: props.taskId,
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
