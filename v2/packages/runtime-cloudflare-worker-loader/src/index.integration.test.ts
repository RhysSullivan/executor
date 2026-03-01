import { spawn } from "node:child_process";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";

import { RuntimeAdapterError } from "@executor-v2/engine";
import { makeCloudflareWorkerLoaderRuntimeAdapter } from "./index";

type WorkerProcess = ReturnType<typeof spawn>;

type CallbackToolCall = {
  runId: string;
  callId: string;
  toolPath: string;
  input: unknown;
  internalSecret: string | null;
};

const CALLBACK_SECRET = "internal-token";

const getFreePort = async (): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    const server = createNetServer();

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to resolve free port"));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });

    server.on("error", (error) => {
      reject(error);
    });
  });

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitForWorker = async (baseUrl: string, timeoutMs = 30_000): Promise<void> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // Keep waiting while worker process starts.
    }

    await wait(200);
  }

  throw new Error(`Timed out waiting for worker health at ${baseUrl}/health`);
};

const stopWorkerProcess = async (process: WorkerProcess): Promise<void> =>
  await new Promise<void>((resolve) => {
    if (process.killed || process.exitCode !== null) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      process.kill("SIGKILL");
      resolve();
    }, 3_000);

    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    process.kill("SIGTERM");
  });

const readIncomingBody = async (request: IncomingMessage): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");

    request.on("data", (chunk) => {
      body += chunk;
    });

    request.on("end", () => {
      resolve(body);
    });

    request.on("error", (error) => {
      reject(error);
    });
  });

const writeJson = (response: ServerResponse, status: number, value: unknown): void => {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
};

describe("cloudflare worker loader runtime adapter integration", () => {
  let workerProcess: WorkerProcess | null = null;
  let workerPort = 0;
  let workerBaseUrl = "";

  let callbackServer: ReturnType<typeof createHttpServer> | null = null;
  let callbackBaseUrl = "";
  let callbackCalls: Array<CallbackToolCall> = [];

  beforeAll(async () => {
    callbackServer = createHttpServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/tool-call" || request.method !== "POST") {
        response.statusCode = 404;
        response.end("not_found");
        return;
      }

      const bodyText = await readIncomingBody(request).catch(() => "");
      let payload: unknown = null;
      try {
        payload = bodyText.length > 0 ? JSON.parse(bodyText) : null;
      } catch {
        payload = null;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        writeJson(response, 200, {
          ok: false,
          kind: "failed",
          error: "Invalid callback payload",
        });
        return;
      }

      const record = payload as Record<string, unknown>;
      if (
        typeof record.runId !== "string" ||
        typeof record.callId !== "string" ||
        typeof record.toolPath !== "string"
      ) {
        writeJson(response, 200, {
          ok: false,
          kind: "failed",
          error: "Missing callback fields",
        });
        return;
      }

      const headerValue = request.headers["x-internal-secret"];
      const internalSecret =
        typeof headerValue === "string"
          ? headerValue
          : Array.isArray(headerValue)
            ? (headerValue[0] ?? null)
            : null;

      callbackCalls.push({
        runId: record.runId,
        callId: record.callId,
        toolPath: record.toolPath,
        input: record.input,
        internalSecret,
      });

      if (internalSecret !== CALLBACK_SECRET) {
        writeJson(response, 200, {
          ok: false,
          kind: "failed",
          error: "Invalid callback internal secret",
        });
        return;
      }

      if (record.toolPath === "math.add") {
        const input =
          record.input && typeof record.input === "object" && !Array.isArray(record.input)
            ? (record.input as Record<string, unknown>)
            : {};

        const a = typeof input.a === "number" ? input.a : 0;
        const b = typeof input.b === "number" ? input.b : 0;

        writeJson(response, 200, {
          ok: true,
          value: a + b,
        });
        return;
      }

      if (record.toolPath === "math.denied") {
        writeJson(response, 200, {
          ok: false,
          kind: "denied",
          error: "tool access denied by policy",
        });
        return;
      }

      writeJson(response, 200, {
        ok: false,
        kind: "failed",
        error: `Unknown test tool path: ${record.toolPath}`,
      });
    });

    await new Promise<void>((resolve, reject) => {
      callbackServer?.listen(0, "127.0.0.1", (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    const callbackAddress = callbackServer.address();
    if (!callbackAddress || typeof callbackAddress === "string") {
      throw new Error("Failed to resolve callback server port");
    }
    callbackBaseUrl = `http://127.0.0.1:${callbackAddress.port}`;

    workerPort = await getFreePort();
    workerBaseUrl = `http://127.0.0.1:${workerPort}`;

    const workerDir = fileURLToPath(new URL("../worker", import.meta.url));

    const spawned = spawn(
      "bunx",
      [
        "wrangler",
        "dev",
        "--local",
        "--port",
        String(workerPort),
        "--config",
        "wrangler.jsonc",
        "--log-level",
        "error",
      ],
      {
        cwd: workerDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    workerProcess = spawned;

    spawned.stdout?.on("data", () => {
      // Keep stream flowing.
    });

    spawned.stderr?.on("data", () => {
      // Keep stream flowing.
    });

    await waitForWorker(workerBaseUrl, 45_000);
  });

  beforeEach(() => {
    callbackCalls = [];
  });

  afterAll(async () => {
    if (callbackServer) {
      await new Promise<void>((resolve, reject) => {
        callbackServer?.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }

    if (workerProcess) {
      await stopWorkerProcess(workerProcess);
    }
  });

  it.effect("executes user code in worker and resolves tool calls via callback bridge", () =>
    Effect.gen(function* () {
      const adapter = makeCloudflareWorkerLoaderRuntimeAdapter({
        runUrl: `${workerBaseUrl}/v1/runs`,
        authToken: "sandbox-token",
        callbackUrl: `${callbackBaseUrl}/tool-call`,
        callbackInternalSecret: CALLBACK_SECRET,
      });

      const result = yield* adapter.execute({
        runId: "run_e2e_1",
        code: "const left = await tools.math.add({ a: 2, b: 4 }); const right = await tools.math.add({ a: left, b: 3 }); return { left, right };",
      });

      expect(result).toEqual({
        left: 6,
        right: 9,
      });

      expect(callbackCalls).toHaveLength(2);
      expect(callbackCalls[0]).toMatchObject({
        runId: "run_e2e_1",
        toolPath: "math.add",
        input: { a: 2, b: 4 },
        internalSecret: CALLBACK_SECRET,
      });
      expect(callbackCalls[1]).toMatchObject({
        runId: "run_e2e_1",
        toolPath: "math.add",
        input: { a: 6, b: 3 },
        internalSecret: CALLBACK_SECRET,
      });
      expect(callbackCalls[0]?.callId.startsWith("call_")).toBe(true);
      expect(callbackCalls[1]?.callId.startsWith("call_")).toBe(true);
    }),
  );

  it.effect("maps denied tool callbacks to runtime terminal denied status", () =>
    Effect.gen(function* () {
      const adapter = makeCloudflareWorkerLoaderRuntimeAdapter({
        runUrl: `${workerBaseUrl}/v1/runs`,
        authToken: "sandbox-token",
        callbackUrl: `${callbackBaseUrl}/tool-call`,
        callbackInternalSecret: CALLBACK_SECRET,
      });

      const result = yield* Effect.either(
        adapter.execute({
          runId: "run_e2e_2",
          code: "await tools.math.denied({}); return 'unreachable';",
        }),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(RuntimeAdapterError);
        expect(result.left.operation).toBe("execute_terminal");
        expect(result.left.message).toContain("denied");
        expect(result.left.details).toBe("tool access denied by policy");
      }
    }),
  );

  it.effect("maps thrown user code errors to runtime terminal failures", () =>
    Effect.gen(function* () {
      const adapter = makeCloudflareWorkerLoaderRuntimeAdapter({
        runUrl: `${workerBaseUrl}/v1/runs`,
        authToken: "sandbox-token",
        callbackUrl: `${callbackBaseUrl}/tool-call`,
        callbackInternalSecret: CALLBACK_SECRET,
      });

      const result = yield* Effect.either(
        adapter.execute({
          runId: "run_e2e_3",
          code: "throw new Error('boom from user code');",
        }),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.operation).toBe("execute_terminal");
        expect(result.left.message).toContain("failed");
        expect(result.left.details).toContain("boom from user code");
      }
    }),
  );

  it.effect("maps worker execution timeouts to runtime timeout terminal status", () =>
    Effect.gen(function* () {
      const adapter = makeCloudflareWorkerLoaderRuntimeAdapter({
        runUrl: `${workerBaseUrl}/v1/runs`,
        authToken: "sandbox-token",
        callbackUrl: `${callbackBaseUrl}/tool-call`,
        callbackInternalSecret: CALLBACK_SECRET,
      });

      const result = yield* Effect.either(
        adapter.execute({
          runId: "run_e2e_4",
          timeoutMs: 50,
          code: "await new Promise((resolve) => setTimeout(resolve, 200)); return 'late';",
        }),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.operation).toBe("execute_terminal");
        expect(result.left.message).toContain("timed_out");
        expect(result.left.details).toContain("Execution timed out");
      }
    }),
  );

  it.effect("surfaces non-200 worker responses as dispatch errors", () =>
    Effect.gen(function* () {
      const adapter = makeCloudflareWorkerLoaderRuntimeAdapter({
        runUrl: `${workerBaseUrl}/v1/runs`,
        authToken: "wrong-token",
        callbackUrl: `${callbackBaseUrl}/tool-call`,
        callbackInternalSecret: CALLBACK_SECRET,
      });

      const result = yield* Effect.either(
        adapter.execute({
          runId: "run_e2e_5",
          code: "return 0;",
        }),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.operation).toBe("dispatch");
        expect(result.left.message).toContain("401");
      }
    }),
  );

  it.effect("surfaces invalid worker JSON as decode errors", () =>
    Effect.gen(function* () {
      const adapter = makeCloudflareWorkerLoaderRuntimeAdapter({
        runUrl: `${workerBaseUrl}/health`,
        authToken: "sandbox-token",
        callbackUrl: `${callbackBaseUrl}/tool-call`,
        callbackInternalSecret: CALLBACK_SECRET,
      });

      const result = yield* Effect.either(
        adapter.execute({
          runId: "run_e2e_6",
          code: "return 0;",
        }),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.operation).toBe("decode_response");
      }
    }),
  );
});
