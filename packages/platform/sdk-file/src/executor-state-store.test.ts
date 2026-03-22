import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ResolvedLocalWorkspaceContext } from "./config";
import {
  loadLocalExecutorStateSnapshot,
  localExecutorStatePath,
  writeLocalExecutorStateSnapshot,
} from "./executor-state-store";

const makeContext = (): Effect.Effect<
  ResolvedLocalWorkspaceContext,
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fs.makeTempDirectory({
      directory: tmpdir(),
      prefix: "executor-state-store-",
    }).pipe(Effect.orDie);

    return {
      cwd: workspaceRoot,
      workspaceRoot,
      workspaceName: "executor-state-store",
      configDirectory: join(workspaceRoot, ".executor"),
      projectConfigPath: join(workspaceRoot, ".executor", "executor.jsonc"),
      homeConfigPath: join(workspaceRoot, ".executor-home.jsonc"),
      homeStateDirectory: join(workspaceRoot, ".executor-home-state"),
      artifactsDirectory: join(workspaceRoot, ".executor", "artifacts"),
      stateDirectory: join(workspaceRoot, ".executor", "state"),
    };
  });

describe("local-executor-state-store", () => {
  it.effect("stores secret-bearing executor state outside the workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const context = yield* makeContext();
      const expectedPath = localExecutorStatePath(context);
      const workspacePath = join(context.stateDirectory, "executor-state.json");

      yield* writeLocalExecutorStateSnapshot({
        context,
        state: {
          version: 1,
          authArtifacts: [],
          authLeases: [],
          sourceOauthClients: [],
          workspaceOauthClients: [],
          providerAuthGrants: [],
          sourceAuthSessions: [],
          secretMaterials: [],
          executions: [],
          executionInteractions: [],
          executionSteps: [],
        },
      });

      expect(expectedPath.startsWith(context.homeStateDirectory)).toBe(true);
      expect(yield* fs.exists(expectedPath)).toBe(true);
      expect(yield* fs.exists(workspacePath)).toBe(false);

      const loaded = yield* loadLocalExecutorStateSnapshot(context);
      expect(loaded.version).toBe(1);
      expect(loaded.secretMaterials).toEqual([]);

      if (process.platform !== "win32") {
        expect((yield* fs.stat(expectedPath)).mode & 0o777).toBe(0o600);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
