export interface Env {
  LOADER: WorkerLoader;
  AUTH_TOKEN: string;
}

/** Dynamic Worker Loader binding — provided by the `worker_loaders` config. */
export interface WorkerLoader {
  get(id: string, getCode: () => Promise<WorkerCode>): WorkerStub;
}

export interface WorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string | { js: string } | { text: string } | { json: object }>;
  env?: Record<string, unknown>;
  globalOutbound?: unknown | null;
}

export interface WorkerStub {
  getEntrypoint(name?: string, options?: { props?: unknown }): EntrypointStub;
}

export interface EntrypointStub {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export interface RunRequest {
  taskId: string;
  code: string;
  timeoutMs?: number;
  callback: {
    convexUrl: string;
    internalSecret: string;
  };
}

export interface RunResult {
  status: "completed" | "failed" | "timed_out" | "denied";
  result?: unknown;
  error?: string;
  exitCode?: number;
}

export type ToolCallResult =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      kind: "pending";
      approvalId: string;
      error?: string;
      retryAfterMs?: number;
    }
  | {
      ok: false;
      kind: "denied" | "failed";
      error: string;
      approvalId?: string;
      retryAfterMs?: number;
    };

export interface BridgeProps {
  callbackConvexUrl: string;
  callbackInternalSecret: string;
  taskId: string;
}

export interface BridgeEntrypointContext {
  props: BridgeProps;
}

export interface WorkerEntrypointExports {
  ToolBridge(opts: { props: BridgeProps }): unknown;
}
