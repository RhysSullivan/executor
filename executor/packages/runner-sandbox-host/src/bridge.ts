import { Result } from "better-result";
import { api } from "@executor/database/convex/_generated/api";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import type {
  BridgeEntrypointContext,
  BridgeProps,
  ToolCallResult,
  WorkerEntrypointExports,
} from "./types";

const APPROVAL_SUBSCRIPTION_TIMEOUT_MS = 10 * 60 * 1000;

function isBridgeProps(value: unknown): value is BridgeProps {
  if (!value || typeof value !== "object") return false;
  const props = value as Partial<BridgeProps>;
  return (
    typeof props.callbackConvexUrl === "string"
    && typeof props.callbackInternalSecret === "string"
    && typeof props.taskId === "string"
  );
}

export function getBridgePropsFromContext(ctx: unknown): BridgeProps {
  if (!ctx || typeof ctx !== "object") {
    throw new Error("WorkerEntrypoint context is unavailable");
  }

  const maybeContext = ctx as Partial<BridgeEntrypointContext>;
  if (!isBridgeProps(maybeContext.props)) {
    throw new Error("ToolBridge props are missing or invalid");
  }

  return maybeContext.props;
}

export function getEntrypointExports(ctx: ExecutionContext): WorkerEntrypointExports {
  const maybeCtx = ctx as ExecutionContext & { exports?: unknown };
  const exportsValue = maybeCtx.exports;

  if (!exportsValue || typeof exportsValue !== "object") {
    throw new Error("Execution context exports are unavailable");
  }

  const maybeExports = exportsValue as Partial<WorkerEntrypointExports>;
  if (typeof maybeExports.ToolBridge !== "function") {
    throw new Error("Execution context ToolBridge export is unavailable");
  }

  return { ToolBridge: maybeExports.ToolBridge };
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
        input,
      });
    });

    if (response.isErr()) {
      const cause = response.error.cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, kind: "failed", error: `Tool callback failed: ${message}` };
    }

    const result = response.value as ToolCallResult;
    if (!result.ok && result.kind === "pending") {
      if (!result.approvalId) {
        return { ok: false, kind: "failed", error: "Approval pending without approvalId" };
      }

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
