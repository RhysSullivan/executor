import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createLocalExecutorRuntime as createExecutorRuntime } from "./index";
import { getOrProvisionLocalInstallation } from "./installation";
import { resolveLocalWorkspaceContext } from "./config";

const makeRuntime = Effect.acquireRelease(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fs.makeTempDirectory({
      directory: tmpdir(),
      prefix: "executor-local-installation-",
    });
    const homeConfigPath = join(workspaceRoot, ".executor-home.jsonc");
    const homeStateDirectory = join(workspaceRoot, ".executor-home-state");
    const runtime = yield* createExecutorRuntime({
      localDataDir: ":memory:",
      workspaceRoot,
      homeConfigPath,
      homeStateDirectory,
    });

    return {
      runtime,
      workspaceRoot,
      homeConfigPath,
      homeStateDirectory,
    };
  }).pipe(Effect.provide(NodeFileSystem.layer)),
  ({ runtime }) => Effect.promise(() => runtime.close()).pipe(Effect.orDie),
);

describe("local-installation", () => {
  it.scoped("derives a stable local identity on first boot", () =>
    Effect.gen(function* () {
      const { runtime, workspaceRoot } = yield* makeRuntime;
      const installation = runtime.localInstallation;
      const fs = yield* FileSystem.FileSystem;

      expect(installation.accountId).toBe("acc_local_default");
      expect(installation.workspaceId.startsWith("ws_local_")).toBe(true);
      expect(yield* fs.exists(join(workspaceRoot, ".executor", "executor.jsonc"))).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
    60_000,
  );

  it.scoped("is idempotent when loading the default local installation", () =>
    Effect.gen(function* () {
      const { runtime, workspaceRoot, homeConfigPath, homeStateDirectory } = yield* makeRuntime;
      const context = yield* resolveLocalWorkspaceContext({
        workspaceRoot,
        homeConfigPath,
        homeStateDirectory,
      });

      const first = runtime.localInstallation;
      const second = yield* getOrProvisionLocalInstallation({
        context,
      });

      expect(second.accountId).toBe(first.accountId);
      expect(second.workspaceId).toBe(first.workspaceId);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
