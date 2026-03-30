import {
  FileSystem,
} from "@effect/platform";
import {
  NodeFileSystem,
} from "@effect/platform-node";
import { resolve } from "node:path";
import {
  describe,
  expect,
  it,
} from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  createLocalExecutorEffect,
} from "@executor/platform-sdk-file/effect";
import {
  defineExecutorSourcePlugin,
} from "../plugins";
import {
  runtimeEffectError,
} from "../runtime/effect-errors";

const BrokenSourceInputSchema = Schema.Struct({
  name: Schema.String,
});

type BrokenSourceInput = typeof BrokenSourceInputSchema.Type;
type BrokenStoredSource = {
  readonly name: string;
};

const makeBrokenSourcePlugin = (input: {
  syncErrorMessage?: string;
} = {}) => {
  const storage = new Map<string, BrokenStoredSource>();
  const syncErrorMessage = input.syncErrorMessage ?? "sync boom";

  return defineExecutorSourcePlugin<
    "broken",
    BrokenSourceInput,
    BrokenSourceInput,
    BrokenSourceInput,
    BrokenStoredSource,
    {
      sourceId: string;
      config: BrokenSourceInput;
    },
    {
      createSource: (input: BrokenSourceInput) => Effect.Effect<any, Error, never>;
      getSource: (sourceId: string) => Effect.Effect<any, Error, never>;
    }
  >({
    key: "broken",
    source: {
      kind: "broken",
      displayName: "Broken",
      add: {
        inputSchema: BrokenSourceInputSchema,
        toConnectInput: (input) => input,
      },
      storage: {
        get: ({ sourceId }) => Effect.succeed(storage.get(sourceId) ?? null),
        put: ({ sourceId, value }) =>
          Effect.sync(() => {
            storage.set(sourceId, value);
          }),
        remove: ({ sourceId }) =>
          Effect.sync(() => {
            storage.delete(sourceId);
          }),
      },
      source: {
        create: (input) => ({
          source: {
            name: input.name,
            kind: "broken",
            status: "connected",
            enabled: true,
            namespace: "broken",
          },
          stored: {
            name: input.name,
          },
        }),
        update: ({ source, config }) => ({
          source: {
            ...source,
            name: config.name,
          },
          stored: {
            name: config.name,
          },
        }),
        toConfig: ({ stored }) => ({
          name: stored.name,
        }),
      },
      catalog: {
        kind: "imported",
        sync: () =>
          Effect.fail(
            runtimeEffectError("sources/operations.test", syncErrorMessage),
          ),
        invoke: () =>
          Effect.fail(
            runtimeEffectError(
              "sources/operations.test",
              "invoke should not run in this test",
            ),
          ),
      },
    },
    extendExecutor: ({ source }) => ({
      createSource: (input) => source.createSource(input),
      getSource: (sourceId) => source.getSource(sourceId),
    }),
  });
};

describe("source operations", () => {
  it.scoped("returns the errored source when source sync fails during create", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectory({
        prefix: "executor-source-ops-",
      });

      const executor = yield* Effect.acquireRelease(
        createLocalExecutorEffect({
          localDataDir: ":memory:",
          workspaceRoot,
          plugins: [makeBrokenSourcePlugin()] as const,
        }),
        (executor) =>
          Effect.promise(() => executor.close()).pipe(
            Effect.orDie,
            Effect.zipRight(
              fs.remove(workspaceRoot, {
                recursive: true,
                force: true,
              }),
            ),
          ),
      );

      const created = yield* executor.broken.createSource({
          name: "Broken Source",
        });

      expect(created.status).toBe("error");

      const persisted = yield* executor.broken.getSource(created.id);

      expect(persisted.status).toBe("error");
      expect(persisted.name).toBe("Broken Source");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("marks credential failures as auth_required and records the last sync error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectory({
        prefix: "executor-source-ops-auth-",
      });

      const executor = yield* Effect.acquireRelease(
        createLocalExecutorEffect({
          localDataDir: ":memory:",
          workspaceRoot,
          plugins: [
            makeBrokenSourcePlugin({
              syncErrorMessage:
                "GraphQL introspection requires credentials (status 403)",
            }),
          ] as const,
        }),
        (executor) =>
          Effect.promise(() => executor.close()).pipe(
            Effect.orDie,
            Effect.zipRight(
              fs.remove(workspaceRoot, {
                recursive: true,
                force: true,
              }),
            ),
          ),
      );

      const created = yield* executor.broken.createSource({
        name: "Protected Source",
      });

      expect(created.status).toBe("auth_required");

      const persisted = yield* executor.broken.getSource(created.id);

      expect(persisted.status).toBe("auth_required");
      expect(persisted.name).toBe("Protected Source");

      const inspection = yield* executor.sources.inspection.get(created.id);

      expect(inspection.source.status).toBe("auth_required");
      expect(inspection.toolCount).toBe(0);
      expect(inspection.tools).toEqual([]);

      const workspaceState = JSON.parse(
        yield* fs.readFileString(
          resolve(workspaceRoot, ".executor", "state", "workspace-state.json"),
          "utf8",
        ),
      ) as {
        sources?: Record<string, { lastError?: string | null }>;
      };

      expect(workspaceState.sources?.[created.id]?.lastError).toBe(
        "GraphQL introspection requires credentials (status 403)",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
