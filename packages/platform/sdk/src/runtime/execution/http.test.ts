import {
  tmpdir,
} from "node:os";
import {
  join,
} from "node:path";
import {
  FileSystem,
} from "@effect/platform";
import {
  NodeFileSystem,
} from "@effect/platform-node";
import {
  describe,
  expect,
  it,
} from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  makeToolInvokerFromTools,
} from "@executor/codemode-core";
import {
  makeDenoSubprocessExecutor,
} from "@executor/runtime-deno-subprocess";

import {
  createLocalExecutorRuntime as createExecutorRuntime,
} from "@executor/platform-sdk-file/runtime";
import {
  withExecutorApiClient,
} from "./test-http-client";

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
    const scopeRoot = yield* fs.makeTempDirectory({
      directory: tmpdir(),
      prefix: "executor-execution-http-",
    });

    return {
      scopeRoot,
      homeConfigPath: join(scopeRoot, ".executor-home.jsonc"),
      homeStateDirectory: join(scopeRoot, ".executor-home-state"),
    };
  }).pipe(
    Effect.provide(NodeFileSystem.layer),
    Effect.flatMap(({ scopeRoot, homeConfigPath, homeStateDirectory }) =>
      createExecutorRuntime({
        localDataDir: ":memory:",
        workspaceRoot: scopeRoot,
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
          actorScopeId: installation.actorScopeId,
        },
        (client) =>
          client.executions.create({
            path: {
              workspaceId: installation.scopeId,
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
          actorScopeId: installation.actorScopeId,
        },
        (client) =>
          client.executions.get({
            path: {
              workspaceId: installation.scopeId,
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

  it.scoped("lists executions through the HTTP API", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime;
      const installation = runtime.localInstallation;

      const created = yield* withExecutorApiClient(
        {
          runtime,
          actorScopeId: installation.actorScopeId,
        },
        (client) =>
          client.executions.create({
            path: {
              workspaceId: installation.scopeId,
            },
            payload: {
              code: "return await tools.math.add({ a: 1, b: 2 });",
            },
          }),
      );

      const executions = yield* withExecutorApiClient(
        {
          runtime,
          actorScopeId: installation.actorScopeId,
        },
        (client) =>
          client.executions.list({
            path: {
              workspaceId: installation.scopeId,
            },
          }),
      );

      expect(executions.some((execution) => execution.id === created.execution.id)).toBe(
        true,
      );
    }),
    60_000,
  );
});
