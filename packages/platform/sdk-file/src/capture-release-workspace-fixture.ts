import { dirname, join, resolve } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { LocalExecutorConfig } from "@executor/platform-sdk/schema";

import {
  readOptionalLocalExecutorConfig,
  resolveLocalWorkspaceContext,
} from "./config";
import {
  ReleaseWorkspaceFixtureManifestSchema,
  defaultReleaseWorkspaceFixtureDirectoryName,
  releaseWorkspaceFixturesRoot,
  type ReleaseWorkspaceFixtureManifest,
} from "./release-upgrade-fixtures";
import { loadLocalWorkspaceState } from "./workspace-state";

class CaptureReleaseWorkspaceFixtureError extends Data.TaggedError(
  "CaptureReleaseWorkspaceFixtureError",
)<{
  readonly message: string;
}> {}

type CaptureReleaseWorkspaceFixtureArgs = {
  readonly workspaceRoot: string;
  readonly sourceId: string;
  readonly releaseVersion: string;
  readonly artifactExpectation: ReleaseWorkspaceFixtureManifest["artifactExpectation"];
  readonly description?: string;
  readonly outputDirectory?: string;
  readonly overwrite: boolean;
};

const usage = `Usage:
  bun run ./src/capture-release-workspace-fixture.ts \\
    --workspace-root /path/to/workspace \\
    --source-id google-calendar \\
    --release-version v1.2.4-beta.1 \\
    [--artifact-expectation readable|cache-miss] \\
    [--description "Google Calendar fixture"] \\
    [--output-directory /custom/output/path] \\
    [--overwrite]
`;

const fail = (message: string) =>
  new CaptureReleaseWorkspaceFixtureError({ message });

const parseCliArgs = (
  argv: readonly string[],
): CaptureReleaseWorkspaceFixtureArgs | "help" => {
  let workspaceRoot: string | undefined;
  let sourceId: string | undefined;
  let releaseVersion: string | undefined;
  let artifactExpectation: CaptureReleaseWorkspaceFixtureArgs["artifactExpectation"] =
    "readable";
  let description: string | undefined;
  let outputDirectory: string | undefined;
  let overwrite = false;

  const readValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw fail(`Missing value for ${flag}\n\n${usage}`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        return "help";
      case "--workspace-root":
        workspaceRoot = readValue(arg, index);
        index += 1;
        break;
      case "--source-id":
        sourceId = readValue(arg, index);
        index += 1;
        break;
      case "--release-version":
        releaseVersion = readValue(arg, index);
        index += 1;
        break;
      case "--artifact-expectation": {
        const value = readValue(arg, index);
        if (value !== "readable" && value !== "cache-miss") {
          throw fail(
            `Invalid --artifact-expectation value: ${value}\n\n${usage}`,
          );
        }
        artifactExpectation = value;
        index += 1;
        break;
      }
      case "--description":
        description = readValue(arg, index);
        index += 1;
        break;
      case "--output-directory":
        outputDirectory = readValue(arg, index);
        index += 1;
        break;
      case "--overwrite":
        overwrite = true;
        break;
      default:
        throw fail(`Unknown argument: ${arg}\n\n${usage}`);
    }
  }

  if (!workspaceRoot || !sourceId || !releaseVersion) {
    throw fail(`Missing required arguments\n\n${usage}`);
  }

  return {
    workspaceRoot,
    sourceId,
    releaseVersion,
    artifactExpectation,
    description,
    outputDirectory,
    overwrite,
  };
};

const mapFileSystemError = (path: string, action: string) => (cause: unknown) =>
  fail(
    `Failed to ${action} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
  );

const copyRecursive = (
  sourcePath: string,
  targetPath: string,
): Effect.Effect<void, CaptureReleaseWorkspaceFixtureError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(sourcePath).pipe(
      Effect.mapError(mapFileSystemError(sourcePath, "check path")),
    );
    if (!exists) {
      return;
    }

    const info = yield* fs.stat(sourcePath).pipe(
      Effect.mapError(mapFileSystemError(sourcePath, "stat path")),
    );

    if (info.type === "Directory") {
      yield* fs.makeDirectory(targetPath, { recursive: true }).pipe(
        Effect.mapError(mapFileSystemError(targetPath, "create directory")),
      );
      const entries = yield* fs.readDirectory(sourcePath).pipe(
        Effect.mapError(mapFileSystemError(sourcePath, "read directory")),
      );
      for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
        yield* copyRecursive(
          join(sourcePath, entry),
          join(targetPath, entry),
        );
      }
      return;
    }

    if (info.type !== "File") {
      return yield* fail(
        `Unsupported filesystem entry while copying fixture: ${sourcePath}`,
      );
    }

    const file = yield* fs.readFile(sourcePath).pipe(
      Effect.mapError(mapFileSystemError(sourcePath, "read file")),
    );
    yield* fs.makeDirectory(dirname(targetPath), { recursive: true }).pipe(
      Effect.mapError(mapFileSystemError(dirname(targetPath), "create directory")),
    );
    yield* fs.writeFile(targetPath, file).pipe(
      Effect.mapError(mapFileSystemError(targetPath, "write file")),
    );
  });

const sanitizeSourceConfig = (
  sourceConfig: NonNullable<LocalExecutorConfig["sources"]>[string],
): NonNullable<LocalExecutorConfig["sources"]>[string] => sourceConfig;

const main = Effect.gen(function* () {
  const args = yield* Effect.try({
    try: () => parseCliArgs(process.argv.slice(2)),
    catch: (cause) =>
      cause instanceof CaptureReleaseWorkspaceFixtureError
        ? cause
        : fail(
            cause instanceof Error ? cause.message : String(cause),
          ),
  });
  if (args === "help") {
    console.log(usage);
    return;
  }

  const fs = yield* FileSystem.FileSystem;
  const workspaceRoot = resolve(args.workspaceRoot);
  const context = yield* resolveLocalWorkspaceContext({
    workspaceRoot,
    homeConfigPath: join(workspaceRoot, ".executor-home.jsonc"),
    homeStateDirectory: join(workspaceRoot, ".executor-home-state"),
  }).pipe(
    Effect.mapError((cause) =>
      fail(
        `Failed to resolve workspace context for ${workspaceRoot}: ${cause.message}`,
      ),
    ),
  );

  const projectConfig = yield* readOptionalLocalExecutorConfig(
    context.projectConfigPath,
  ).pipe(
    Effect.mapError((cause) =>
      fail(
        `Failed to read project config ${context.projectConfigPath}: ${cause.message}`,
      ),
    ),
  );

  const sourceConfig = projectConfig?.sources?.[args.sourceId];
  if (!sourceConfig) {
    return yield* fail(
      `Source ${args.sourceId} was not found in ${context.projectConfigPath}`,
    );
  }

  const workspaceState = yield* loadLocalWorkspaceState(context).pipe(
    Effect.mapError((cause) =>
      fail(
        `Failed to load workspace state for ${workspaceRoot}: ${cause.message}`,
      ),
    ),
  );
  const sourceState = workspaceState.sources[args.sourceId];
  if (!sourceState) {
    return yield* fail(
      `Source ${args.sourceId} was not found in ${context.stateDirectory}/workspace-state.json`,
    );
  }

  const sourceArtifactPath = join(
    context.artifactsDirectory,
    "sources",
    `${args.sourceId}.json`,
  );
  const artifactExists = yield* fs.exists(sourceArtifactPath).pipe(
    Effect.mapError(mapFileSystemError(sourceArtifactPath, "check source artifact")),
  );
  if (!artifactExists) {
    return yield* fail(`Source artifact not found at ${sourceArtifactPath}`);
  }

  const outputDirectory =
    args.outputDirectory !== undefined
      ? resolve(args.outputDirectory)
      : join(
          releaseWorkspaceFixturesRoot,
          defaultReleaseWorkspaceFixtureDirectoryName({
            releaseVersion: args.releaseVersion,
            sourceId: args.sourceId,
          }),
        );

  const outputExists = yield* fs.exists(outputDirectory).pipe(
    Effect.mapError(mapFileSystemError(outputDirectory, "check output directory")),
  );
  if (outputExists && !args.overwrite) {
    return yield* fail(
      `Output directory already exists: ${outputDirectory}. Pass --overwrite to replace it.`,
    );
  }

  if (outputExists) {
    yield* fs.remove(outputDirectory, { recursive: true, force: true }).pipe(
      Effect.mapError(mapFileSystemError(outputDirectory, "remove output directory")),
    );
  }

  const fixtureConfig = {
    ...(projectConfig?.runtime ? { runtime: projectConfig.runtime } : {}),
    ...(projectConfig?.workspace ? { workspace: projectConfig.workspace } : {}),
    sources: {
      [args.sourceId]: sanitizeSourceConfig(sourceConfig),
    },
  } satisfies LocalExecutorConfig;

  const fixtureState = {
    version: 1 as const,
    sources: {
      [args.sourceId]: sourceState,
    },
    policies: {},
  };

  const manifest = ReleaseWorkspaceFixtureManifestSchema.make({
    schemaVersion: 1,
    kind: "release-workspace",
    id: `${args.releaseVersion}-${args.sourceId}`,
    releaseVersion: args.releaseVersion,
    sourceId: args.sourceId,
    artifactExpectation: args.artifactExpectation,
    ...(args.description ? { description: args.description } : {}),
  });

  yield* fs.makeDirectory(join(outputDirectory, ".executor", "state"), {
    recursive: true,
  }).pipe(
    Effect.mapError(
      mapFileSystemError(join(outputDirectory, ".executor", "state"), "create fixture state directory"),
    ),
  );

  yield* fs.writeFileString(
    join(outputDirectory, "fixture.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  ).pipe(
    Effect.mapError(mapFileSystemError(join(outputDirectory, "fixture.json"), "write fixture manifest")),
  );
  yield* fs.writeFileString(
    join(outputDirectory, ".executor", "executor.jsonc"),
    `${JSON.stringify(fixtureConfig, null, 2)}\n`,
  ).pipe(
    Effect.mapError(mapFileSystemError(join(outputDirectory, ".executor", "executor.jsonc"), "write fixture config")),
  );
  yield* fs.writeFileString(
    join(outputDirectory, ".executor", "state", "workspace-state.json"),
    `${JSON.stringify(fixtureState, null, 2)}\n`,
  ).pipe(
    Effect.mapError(
      mapFileSystemError(
        join(outputDirectory, ".executor", "state", "workspace-state.json"),
        "write fixture workspace state",
      ),
    ),
  );

  yield* copyRecursive(
    sourceArtifactPath,
    join(outputDirectory, ".executor", "artifacts", "sources", `${args.sourceId}.json`),
  );
  yield* copyRecursive(
    join(context.artifactsDirectory, "sources", args.sourceId),
    join(outputDirectory, ".executor", "artifacts", "sources", args.sourceId),
  );

  console.log(`Captured release workspace fixture at ${outputDirectory}`);
});

const exit = await Effect.runPromiseExit(
  main.pipe(Effect.provide(NodeFileSystem.layer)),
);

if (Exit.isFailure(exit)) {
  const error = Cause.squash(exit.cause);
  if (error instanceof CaptureReleaseWorkspaceFixtureError) {
    console.error(error.message);
  } else {
    console.error("Unexpected failure while capturing release workspace fixture");
    console.error(error);
  }

  process.exit(1);
}
