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

import {
  createLocalExecutorRuntime as createExecutorRuntime,
} from "@executor/platform-sdk-file/runtime";
import {
  withExecutorApiClient,
} from "./test-http-client";

const writeProjectConfig = (
  scopeRoot: string,
  config: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
  const configDirectory = join(scopeRoot, ".executor");
    yield* fs.makeDirectory(configDirectory, { recursive: true });
    yield* fs.writeFileString(
      join(configDirectory, "executor.jsonc"),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  });

const makeRuntime = (config: Record<string, unknown>) => {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scopeRoot = yield* fs.makeTempDirectory({
        directory: tmpdir(),
        prefix: "executor-runtime-config-",
      });
      yield* writeProjectConfig(scopeRoot, config);

      return yield* createExecutorRuntime({
        workspaceRoot: scopeRoot,
        homeConfigPath: join(scopeRoot, ".executor-home.jsonc"),
        homeStateDirectory: join(scopeRoot, ".executor-home-state"),
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
    (runtime) => Effect.promise(() => runtime.close()).pipe(Effect.orDie),
  );
};

describe("execution runtime config", () => {
  it.scoped("defaults to QuickJS when no runtime is configured", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({
        sources: {},
      });
      const installation = runtime.localInstallation;

      const execution = yield* withExecutorApiClient(
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
              code: 'await fetch("https://example.com"); return 1;',
            },
          }),
      );

      expect(execution.execution.status).toBe("failed");
      expect(execution.execution.errorText).toContain(
        "fetch is disabled in QuickJS executor",
      );
    }),
    60_000,
  );

  it.scoped("uses the SES runtime when configured in executor.jsonc", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({
        runtime: "ses",
        sources: {},
      });
      const installation = runtime.localInstallation;

      const execution = yield* withExecutorApiClient(
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
              code: 'await fetch("https://example.com"); return 1;',
            },
          }),
      );

      expect(execution.execution.status).toBe("failed");
      expect(execution.execution.errorText).toContain(
        "fetch is disabled in SES executor",
      );
    }),
    60_000,
  );

  it.scoped("uses the Deno runtime when configured in executor.jsonc", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({
        runtime: "deno",
        sources: {},
      });
      const installation = runtime.localInstallation;

      const execution = yield* withExecutorApiClient(
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
              code: 'return typeof Deno !== "undefined";',
            },
          }),
      );

      if (execution.execution.status === "completed") {
        expect(execution.execution.resultJson).toBe("true");
        return;
      }

      expect(execution.execution.status).toBe("failed");
      expect(execution.execution.errorText).toContain("Install Deno or set DENO_BIN");
    }),
    60_000,
  );
});
