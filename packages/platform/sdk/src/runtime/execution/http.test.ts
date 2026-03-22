import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeToolInvokerFromTools } from "@executor/codemode-core";
import { makeDenoSubprocessExecutor } from "@executor/runtime-deno-subprocess";

import { createLocalExecutorRuntime as createExecutorRuntime } from "../../../../sdk-file/src/index";
import { withExecutorApiClient } from "./test-http-client";

const makeExecutionResolver = () => {
  const toolInvoker = makeToolInvokerFromTools({
    tools: {
      "math.add": {
        description: "Add two numbers",
        inputSchema: Schema.standardSchemaV1(
          Schema.Struct({
            a: Schema.optional(Schema.Number),
            b: Schema.optional(Schema.Number),
          }),
        ),
        execute: ({
          a,
          b,
        }) => ({ sum: (a ?? 0) + (b ?? 0) }),
      },
    },
  });

  return () =>
    Effect.succeed({
      executor: makeDenoSubprocessExecutor(),
      toolInvoker,
    });
};

const makeRuntime = Effect.acquireRelease(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fs.makeTempDirectory({
      directory: tmpdir(),
      prefix: "executor-execution-http-",
    });

    return {
      workspaceRoot,
      homeConfigPath: join(workspaceRoot, ".executor-home.jsonc"),
      homeStateDirectory: join(workspaceRoot, ".executor-home-state"),
    };
  }).pipe(
    Effect.provide(NodeFileSystem.layer),
    Effect.flatMap(({ workspaceRoot, homeConfigPath, homeStateDirectory }) =>
      createExecutorRuntime({
        localDataDir: ":memory:",
        workspaceRoot,
        homeConfigPath,
        homeStateDirectory,
        executionResolver: makeExecutionResolver(),
      }),
    ),
  ),
  (runtime) => Effect.promise(() => runtime.close()).pipe(Effect.orDie),
);

describe("execution-http", () => {
  it.scoped("creates and persists an execution through the HTTP API", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime;
      const installation = runtime.localInstallation;

      const createExecution = yield* withExecutorApiClient(
        {
          runtime,
          accountId: installation.accountId,
        },
        (client) =>
          client.executions.create({
            path: {
              workspaceId: installation.workspaceId,
            },
            payload: {
              code: "return await tools.math.add({ a: 20, b: 22 });",
            },
          }),
      );

      expect(createExecution.execution.status).toBe("completed");
      expect(createExecution.execution.resultJson).toBe(JSON.stringify({ sum: 42 }));
      expect(createExecution.pendingInteraction).toBeNull();

      const getExecution = yield* withExecutorApiClient(
        {
          runtime,
          accountId: installation.accountId,
        },
        (client) =>
          client.executions.get({
            path: {
              workspaceId: installation.workspaceId,
              executionId: createExecution.execution.id,
            },
          }),
      );

      expect(getExecution.execution.id).toBe(createExecution.execution.id);
      expect(getExecution.execution.status).toBe("completed");
      expect(getExecution.pendingInteraction).toBeNull();
    }),
    60_000,
  );
});
