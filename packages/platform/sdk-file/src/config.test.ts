import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  loadLocalExecutorConfig,
  mergeLocalExecutorConfigs,
  resolveDefaultHomeConfigCandidates,
  resolveDefaultHomeStateDirectory,
  resolveLocalWorkspaceContext,
} from "./config";

const makeWorkspaceRoot = () =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.makeTempDirectory({
        directory: tmpdir(),
        prefix: "executor-local-config-",
      })
    ),
  );

describe("local-config", () => {
  it.effect("parses jsonc project config with comments and trailing commas", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* makeWorkspaceRoot();
      const configDirectory = join(workspaceRoot, ".executor");
      yield* fs.makeDirectory(configDirectory, { recursive: true });
      yield* fs.writeFileString(
        join(configDirectory, "executor.jsonc"),
        `{
  "runtime": "ses",
  // local scope config
  "sources": {
    "github": {
      "kind": "openapi",
      "binding": {
        "specUrl": "https://example.com/openapi.json",
      },
    },
  },
}
`,
      );

      const context = yield* resolveLocalWorkspaceContext({ workspaceRoot });
      const loaded = yield* loadLocalExecutorConfig(context);

      expect(loaded.config?.sources?.github?.kind).toBe("openapi");
      expect(loaded.config?.runtime).toBe("ses");
      expect(context.homeStateDirectory.toLowerCase()).toContain("executor");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("reports jsonc syntax errors with line and column details", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* makeWorkspaceRoot();
      const configDirectory = join(workspaceRoot, ".executor");
      yield* fs.makeDirectory(configDirectory, { recursive: true });
      yield* fs.writeFileString(
        join(configDirectory, "executor.jsonc"),
        `{
  "sources": {
    "github": {
      "kind": "openapi"
      "binding": {
        "specUrl": "https://api.github.com/openapi.json"
      }
    }
  }
}
`,
      );

      const context = yield* resolveLocalWorkspaceContext({ workspaceRoot });
      const failure = yield* Effect.flip(loadLocalExecutorConfig(context));

      expect(failure.message).toContain("Invalid executor config");
      expect(failure.message).toContain("line 5, column 7");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it("uses platform-standard home config candidates", () => {
    const linuxCandidates = resolveDefaultHomeConfigCandidates({
      platform: "linux",
      homeDirectory: "/home/alice",
      env: {},
    });
    const macCandidates = resolveDefaultHomeConfigCandidates({
      platform: "darwin",
      homeDirectory: "/Users/alice",
      env: {},
    });

    expect(linuxCandidates[0]).toBe("/home/alice/.config/executor/executor.jsonc");
    expect(macCandidates[0]).toBe(
      "/Users/alice/Library/Application Support/Executor/executor.jsonc",
    );
    expect(linuxCandidates).toHaveLength(1);
    expect(macCandidates).toHaveLength(1);
  });

  it("uses platform-standard home state directories", () => {
    const linuxStateDirectory = resolveDefaultHomeStateDirectory({
      platform: "linux",
      homeDirectory: "/home/alice",
      env: {},
    });
    const macStateDirectory = resolveDefaultHomeStateDirectory({
      platform: "darwin",
      homeDirectory: "/Users/alice",
      env: {},
    });

    expect(linuxStateDirectory).toBe("/home/alice/.local/state/executor");
    expect(macStateDirectory).toBe(
      "/Users/alice/Library/Application Support/Executor/State",
    );
  });

  it("lets project config override the merged runtime", () => {
    const merged = mergeLocalExecutorConfigs(
      {
        runtime: "quickjs",
        sources: {},
      },
      {
        runtime: "deno",
      },
    );

    expect(merged?.runtime).toBe("deno");
  });
});
