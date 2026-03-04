import { RpcTarget } from "cloudflare:workers";

import HARNESS_CODE from "./isolate/harness.isolate.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

type RuntimeToolCallResult =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      kind: "pending";
      interactionId: string;
      retryAfterMs: number;
      error?: string;
    }
  | {
      ok: false;
      kind: "denied";
      error: string;
    }
  | {
      ok: false;
      kind: "failed";
      error: string;
    };

type RunRequest = {
  runId: string;
  taskId: string;
  code: string;
  timeoutMs?: number;
  callback: {
    url: string;
    internalSecret?: string;
  };
};

type RunResult = {
  status: "completed" | "failed" | "timed_out" | "denied";
  result?: unknown;
  error?: string;
  exitCode?: number;
};

type BridgeProps = {
  callbackUrl: string;
  callbackInternalSecret: string | null;
  runId: string;
};

type SandboxEntrypoint = {
  evaluate: (bridge: ToolBridge) => Promise<RunResult>;
};

type Env = {
  AUTH_TOKEN: string;
  LOADER: {
    get: (
      id: string,
      init: () => Promise<{
        compatibilityDate: string;
        mainModule: string;
        modules: Record<string, string>;
        env: Record<string, unknown>;
        globalOutbound: null;
      }>,
    ) => {
      getEntrypoint: () => SandboxEntrypoint;
    };
  };
};

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRuntimeToolCallResult = (value: unknown): value is RuntimeToolCallResult => {
  if (!isObjectRecord(value)) {
    return false;
  }

  if (value.ok === true) {
    return Object.prototype.hasOwnProperty.call(value, "value");
  }

  if (value.ok === false && value.kind === "pending") {
    return (
      typeof value.interactionId === "string" &&
      typeof value.retryAfterMs === "number"
    );
  }

  if (value.ok === false && value.kind === "denied") {
    return typeof value.error === "string";
  }

  if (value.ok === false && value.kind === "failed") {
    return typeof value.error === "string";
  }

  return false;
};

const isRunResult = (value: unknown): value is RunResult => {
  if (!isObjectRecord(value)) {
    return false;
  }

  if (
    value.status !== "completed" &&
    value.status !== "failed" &&
    value.status !== "timed_out" &&
    value.status !== "denied"
  ) {
    return false;
  }

  if (value.error !== undefined && typeof value.error !== "string") {
    return false;
  }

  if (value.exitCode !== undefined && typeof value.exitCode !== "number") {
    return false;
  }

  return true;
};

const toFailedResult = (error: string): RunResult => ({
  status: "failed",
  error,
});

const validateRunRequest = (value: unknown): RunRequest | null => {
  if (!isObjectRecord(value)) {
    return null;
  }

  if (
    typeof value.runId !== "string" ||
    typeof value.taskId !== "string" ||
    typeof value.code !== "string"
  ) {
    return null;
  }

  if (!isObjectRecord(value.callback) || typeof value.callback.url !== "string") {
    return null;
  }

  if (
    value.callback.internalSecret !== undefined &&
    typeof value.callback.internalSecret !== "string"
  ) {
    return null;
  }

  if (value.timeoutMs !== undefined && typeof value.timeoutMs !== "number") {
    return null;
  }

  return {
    runId: value.runId,
    taskId: value.taskId,
    code: value.code,
    timeoutMs: value.timeoutMs,
    callback: {
      url: value.callback.url,
      internalSecret: value.callback.internalSecret,
    },
  };
};

const buildUserModule = (userCode: string): string =>
  `export async function run(tools, console) {\n"use strict";\n${userCode}\n}\n`;

class ToolBridge extends RpcTarget {
  readonly #props: BridgeProps;

  constructor(props: BridgeProps) {
    super();
    this.#props = props;
  }

  async callTool(
    toolPath: string,
    input: unknown,
    callId: string,
  ): Promise<RuntimeToolCallResult> {
    const headers = new Headers({
      "content-type": "application/json",
    });

    if (this.#props.callbackInternalSecret) {
      headers.set("x-internal-secret", this.#props.callbackInternalSecret);
    }

    const response = await fetch(this.#props.callbackUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        runId: this.#props.runId,
        callId,
        toolPath,
        input,
      }),
    }).catch((error: unknown) => {
      throw new Error(
        `Tool callback transport failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    if (response.status !== 200) {
      return {
        ok: false,
        kind: "failed",
        error: `Tool callback returned ${response.status}`,
      };
    }

    const payload = await response.json().catch(() => null);
    if (!isRuntimeToolCallResult(payload)) {
      return {
        ok: false,
        kind: "failed",
        error: "Tool callback returned invalid result payload",
      };
    }

    return payload;
  }
}

const executeSandboxRun = async (
  request: RunRequest,
  env: Env,
): Promise<RunResult> => {
  const timeoutMsRaw = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(timeoutMsRaw)));

  const toolBridge = new ToolBridge({
    callbackUrl: request.callback.url,
    callbackInternalSecret: request.callback.internalSecret ?? null,
    runId: request.runId,
  });

  const worker = env.LOADER.get(request.taskId, async () => ({
    compatibilityDate: "2025-06-01",
    mainModule: "harness.js",
    modules: {
      "harness.js": HARNESS_CODE,
      "user-code.js": buildUserModule(request.code),
    },
    env: {},
    globalOutbound: null,
  }));

  const entrypoint = worker.getEntrypoint();
  let timer: ReturnType<typeof setTimeout> | null = null;

  let payload: RunResult;
  try {
    const timeoutResult = new Promise<RunResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          status: "timed_out",
          error: `Execution timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);
    });

    payload = await Promise.race([
      entrypoint.evaluate(toolBridge),
      timeoutResult,
    ]);
  } catch (error) {
    if (timer) {
      clearTimeout(timer);
    }
    return toFailedResult(
      `Sandbox isolate execution failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (timer) {
    clearTimeout(timer);
  }

  if (!isRunResult(payload)) {
    return toFailedResult("Sandbox isolate returned invalid response payload");
  }

  return payload;
};

export { ToolBridge };

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname !== "/v1/runs" || request.method !== "POST") {
      return json({ error: "not_found" }, 404);
    }

    if (typeof env.AUTH_TOKEN !== "string" || env.AUTH_TOKEN.length === 0) {
      return json({ error: "misconfigured_auth_token" }, 500);
    }

    if (request.headers.get("authorization") !== `Bearer ${env.AUTH_TOKEN}`) {
      return json({ error: "unauthorized" }, 401);
    }

    const payloadRaw = await request.json().catch(() => null);
    const payload = validateRunRequest(payloadRaw);
    if (!payload) {
      return json({ error: "invalid_payload" }, 400);
    }

    const runResult = await executeSandboxRun(payload, env);
    return json(runResult, 200);
  },
};
