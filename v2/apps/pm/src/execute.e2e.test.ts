import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

const pmAppDir = new URL("..", import.meta.url).pathname;

type McpCallToolResult = {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
};

class ExecuteE2eError extends Data.TaggedError("ExecuteE2eError")<{
  message: string;
  details: string | null;
}> {}

const toExecuteE2eError = (message: string, cause: unknown): ExecuteE2eError =>
  new ExecuteE2eError({
    message,
    details: cause instanceof Error ? cause.message : String(cause),
  });

const findFreePort = Effect.async<number, ExecuteE2eError, never>((resume) => {
  const server = createServer();

  server.once("error", (cause) => {
    resume(Effect.fail(toExecuteE2eError("Failed to allocate free TCP port", cause)));
  });

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;

    server.close((cause) => {
      if (cause) {
        resume(Effect.fail(toExecuteE2eError("Failed closing port probe server", cause)));
        return;
      }

      if (!port) {
        resume(
          Effect.fail(
            new ExecuteE2eError({
              message: "Failed to allocate free TCP port",
              details: "No port returned from node:net server",
            }),
          ),
        );
        return;
      }

      resume(Effect.succeed(port));
    });
  });
});

const waitForHealth = (port: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const healthy = yield* Effect.tryPromise({
        try: async () => {
          const signal = AbortSignal.timeout(250);
          const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal });
          return response.status === 200;
        },
        catch: (cause) =>
          toExecuteE2eError("Failed polling PM health endpoint", cause),
      }).pipe(Effect.catchAll(() => Effect.succeed(false)));

      if (healthy) {
        return;
      }

      yield* Effect.sleep("100 millis");
    }

    return yield* new ExecuteE2eError({
      message: "PM server did not become healthy in time",
      details: `http://127.0.0.1:${port}/healthz`,
    });
  });

const withPmProcess = (port: number) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      spawn("bun", ["src/main.ts"], {
        cwd: pmAppDir,
        env: {
          ...process.env,
          PORT: String(port),
        },
        stdio: "pipe",
      }),
    ),
    (child) =>
      Effect.sync(() => {
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      }),
  );

const withMcpClient = (port: number) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const transport = new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${port}/mcp`),
        );
        const client = new Client(
          { name: "executor-v2-pm-e2e", version: "0.0.0" },
          { capabilities: {} },
        );

        await client.connect(transport);
        return { client, transport };
      },
      catch: (cause) =>
        toExecuteE2eError("Failed to initialize MCP client transport", cause),
    }),
    ({ client, transport }) =>
      Effect.tryPromise({
        try: async () => {
          await transport.close().catch(() => undefined);
          await client.close().catch(() => undefined);
        },
        catch: (cause) =>
          toExecuteE2eError("Failed closing MCP client transport", cause),
      }).pipe(Effect.orDie),
  );

describe("PM execute E2E", () => {
  it.live(
    "runs executor.execute code through MCP",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const port = yield* findFreePort;
          yield* withPmProcess(port);
          yield* waitForHealth(port);

          const { client } = yield* withMcpClient(port);

          const result = (yield* Effect.tryPromise({
            try: () =>
              client.callTool({
                name: "executor.execute",
                arguments: {
                  code: "return 2 + 3;",
                },
              }),
            catch: (cause) =>
              toExecuteE2eError("Failed calling executor.execute over MCP", cause),
          })) as McpCallToolResult;

          expect(result.isError).toBe(false);
          const textPart = result.content?.find((part) => part.type === "text");
          expect(textPart?.text).toBe("5");
        }),
      ),
    30_000,
  );
});
