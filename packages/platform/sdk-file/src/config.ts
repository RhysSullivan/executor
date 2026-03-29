import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { FileSystem } from "@effect/platform";
import {
  type ParseError as JsoncParseError,
  parse as parseJsoncDocument,
  printParseErrorCode,
} from "jsonc-parser/lib/esm/main.js";

import {
  LocalExecutorConfigSchema,
  type LocalExecutorConfig,
  type LocalConfigPolicy,
  type LocalConfigSource,
} from "@executor/platform-sdk/schema";
import type { LoadedLocalExecutorConfig } from "@executor/platform-sdk/runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  LocalExecutorConfigDecodeError,
  LocalFileSystemError,
  unknownLocalErrorDetails,
} from "./errors";

const decodeLocalExecutorConfig = Schema.decodeUnknownSync(LocalExecutorConfigSchema);

export type FileLoadedExecutorConfig = LoadedLocalExecutorConfig & {
  homeConfigPath: string;
  projectConfigPath: string;
};

export const encodeLocalExecutorConfig = (config: LocalExecutorConfig): string =>
  `${JSON.stringify(config, null, 2)}\n`;

export const resolveConfigRelativePath = (input: {
  path: string;
  scopeRoot: string;
}): string => {
  const trimmed = input.path.trim();
  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }
  if (trimmed === "~") {
    return homedir();
  }
  if (isAbsolute(trimmed)) {
    return trimmed;
  }
  return resolve(input.scopeRoot, trimmed);
};

export type { LoadedLocalExecutorConfig } from "@executor/platform-sdk/runtime";

const PROJECT_CONFIG_BASENAME = "executor.jsonc";
const PROJECT_CONFIG_DIRECTORY = ".executor";
const EXECUTOR_CONFIG_DIR_ENV = "EXECUTOR_CONFIG_DIR";
const EXECUTOR_STATE_DIR_ENV = "EXECUTOR_STATE_DIR";

const mapFileSystemError = (path: string, action: string) => (cause: unknown) =>
  new LocalFileSystemError({
    message: `Failed to ${action} ${path}: ${unknownLocalErrorDetails(cause)}`,
    action,
    path,
    details: unknownLocalErrorDetails(cause),
  });

const trimOrUndefined = (value: string | undefined | null): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const defaultExecutorConfigDirectory = (input: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
} = {}): string => {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const homeDirectory = input.homeDirectory ?? homedir();
  const explicitConfigDirectory = trimOrUndefined(env[EXECUTOR_CONFIG_DIR_ENV]);

  if (explicitConfigDirectory) {
    return explicitConfigDirectory;
  }

  if (platform === "win32") {
    return join(
      trimOrUndefined(env.LOCALAPPDATA) ?? join(homeDirectory, "AppData", "Local"),
      "Executor",
    );
  }

  if (platform === "darwin") {
    return join(homeDirectory, "Library", "Application Support", "Executor");
  }

  return join(
    trimOrUndefined(env.XDG_CONFIG_HOME) ?? join(homeDirectory, ".config"),
    "executor",
  );
};

const defaultExecutorStateDirectory = (input: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
} = {}): string => {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const homeDirectory = input.homeDirectory ?? homedir();
  const explicitStateDirectory = trimOrUndefined(env[EXECUTOR_STATE_DIR_ENV]);

  if (explicitStateDirectory) {
    return explicitStateDirectory;
  }

  if (platform === "win32") {
    return join(
      trimOrUndefined(env.LOCALAPPDATA) ?? join(homeDirectory, "AppData", "Local"),
      "Executor",
      "State",
    );
  }

  if (platform === "darwin") {
    return join(homeDirectory, "Library", "Application Support", "Executor", "State");
  }

  return join(
    trimOrUndefined(env.XDG_STATE_HOME) ?? join(homeDirectory, ".local", "state"),
    "executor",
  );
};

export const resolveDefaultHomeConfigCandidates = (input: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
} = {}): string[] => {
  const directory = defaultExecutorConfigDirectory({
    env: input.env,
    platform: input.platform,
    homeDirectory: input.homeDirectory ?? homedir(),
  });
  return [join(directory, PROJECT_CONFIG_BASENAME)];
};

export const resolveHomeConfigPath = (input: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
} = {}): Effect.Effect<string, LocalFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const candidates = resolveDefaultHomeConfigCandidates(input);

    for (const candidate of candidates) {
      const exists = yield* fs.exists(candidate).pipe(
        Effect.mapError(mapFileSystemError(candidate, "check config path")),
      );
      if (exists) {
        return candidate;
      }
    }

    return candidates[0]!;
  });

export const resolveDefaultHomeStateDirectory = (input: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
} = {}): string =>
  defaultExecutorStateDirectory(input);

const formatJsoncParseErrors = (content: string, errors: readonly JsoncParseError[]): string => {
  const lines = content.split("\n");

  return errors
    .map((error) => {
      const beforeOffset = content.slice(0, error.offset).split("\n");
      const line = beforeOffset.length;
      const column = beforeOffset[beforeOffset.length - 1]?.length ?? 0;
      const lineText = lines[line - 1];
      const location = `line ${line}, column ${column + 1}`;
      const detail = printParseErrorCode(error.error);

      if (!lineText) {
        return `${detail} at ${location}`;
      }

      return `${detail} at ${location}\n${lineText}`;
    })
    .join("\n");
};

const parseJsonc = (input: { path: string; content: string }): LocalExecutorConfig => {
  const errors: JsoncParseError[] = [];

  try {
    const parsed = parseJsoncDocument(input.content, errors, {
      allowTrailingComma: true,
    });
    if (errors.length > 0) {
      throw new LocalExecutorConfigDecodeError({
        message: `Invalid executor config at ${input.path}: ${formatJsoncParseErrors(input.content, errors)}`,
        path: input.path,
        details: formatJsoncParseErrors(input.content, errors),
      });
    }

    return decodeLocalExecutorConfig(parsed);
  } catch (cause) {
    if (cause instanceof LocalExecutorConfigDecodeError) {
      throw cause;
    }
    throw new LocalExecutorConfigDecodeError({
      message: `Invalid executor config at ${input.path}: ${unknownLocalErrorDetails(cause)}`,
      path: input.path,
      details: unknownLocalErrorDetails(cause),
    });
  }
};

const mergeSourceMaps = (
  base: Record<string, LocalConfigSource> | undefined,
  extra: Record<string, LocalConfigSource> | undefined,
): Record<string, LocalConfigSource> | undefined => {
  if (!base && !extra) {
    return undefined;
  }
  return {
    ...base,
    ...extra,
  };
};

const mergePolicyMaps = (
  base: Record<string, LocalConfigPolicy> | undefined,
  extra: Record<string, LocalConfigPolicy> | undefined,
): Record<string, LocalConfigPolicy> | undefined => {
  if (!base && !extra) {
    return undefined;
  }
  return {
    ...base,
    ...extra,
  };
};

export const mergeLocalExecutorConfigs = (
  base: LocalExecutorConfig | null,
  extra: LocalExecutorConfig | null,
): LocalExecutorConfig | null => {
  if (!base && !extra) {
    return null;
  }

  return decodeLocalExecutorConfig({
    runtime: extra?.runtime ?? base?.runtime,
    workspace: {
      ...base?.workspace,
      ...extra?.workspace,
    },
    sources: mergeSourceMaps(base?.sources, extra?.sources),
    policies: mergePolicyMaps(base?.policies, extra?.policies),
  });
};

const resolveProjectConfigPathEffect = (workspaceRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const jsoncPath = join(workspaceRoot, PROJECT_CONFIG_DIRECTORY, PROJECT_CONFIG_BASENAME);
    yield* fs.exists(jsoncPath).pipe(
      Effect.mapError(mapFileSystemError(jsoncPath, "check project config path")),
    );
    return jsoncPath;
  });

const hasProjectConfigEffect = (workspaceRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const jsoncPath = join(workspaceRoot, PROJECT_CONFIG_DIRECTORY, PROJECT_CONFIG_BASENAME);
    return yield* fs.exists(jsoncPath).pipe(
      Effect.mapError(mapFileSystemError(jsoncPath, "check project config path")),
    );
  });

const resolveWorkspaceRootFromCwdEffect = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let current = resolve(cwd);
    let nearestProjectConfigRoot: string | null = null;
    let nearestGitRoot: string | null = null;

    while (true) {
      if (nearestProjectConfigRoot === null) {
        const hasProjectConfig = yield* hasProjectConfigEffect(current);
        if (hasProjectConfig) {
          nearestProjectConfigRoot = current;
        }
      }

      if (nearestGitRoot === null) {
        const gitPath = join(current, ".git");
        const gitExists = yield* fs.exists(gitPath).pipe(
          Effect.mapError(mapFileSystemError(gitPath, "check git root")),
        );
        if (gitExists) {
          nearestGitRoot = current;
        }
      }

      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    return nearestProjectConfigRoot ?? nearestGitRoot ?? resolve(cwd);
  });

export type ResolvedLocalWorkspaceContext = {
  cwd: string;
  workspaceRoot: string;
  workspaceName: string;
  configDirectory: string;
  projectConfigPath: string;
  homeConfigPath: string;
  homeStateDirectory: string;
  artifactsDirectory: string;
  stateDirectory: string;
};

export const resolveLocalWorkspaceContext = (input: {
  cwd?: string;
  workspaceRoot?: string;
  homeConfigPath?: string;
  homeStateDirectory?: string;
} = {}): Effect.Effect<
  ResolvedLocalWorkspaceContext,
  LocalFileSystemError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const cwd = resolve(input.cwd ?? process.cwd());
    const workspaceRoot = resolve(
      input.workspaceRoot ?? (yield* resolveWorkspaceRootFromCwdEffect(cwd)),
    );
    const workspaceName = basename(workspaceRoot) || "workspace";
    const projectConfigPath = yield* resolveProjectConfigPathEffect(workspaceRoot);
    const homeConfigPath = resolve(
      input.homeConfigPath ?? (yield* resolveHomeConfigPath()),
    );
    const homeStateDirectory = resolve(
      input.homeStateDirectory ?? resolveDefaultHomeStateDirectory(),
    );

    return {
      cwd,
      workspaceRoot,
      workspaceName,
      configDirectory: join(workspaceRoot, PROJECT_CONFIG_DIRECTORY),
      projectConfigPath,
      homeConfigPath,
      homeStateDirectory,
      artifactsDirectory: join(workspaceRoot, PROJECT_CONFIG_DIRECTORY, "artifacts"),
      stateDirectory: join(workspaceRoot, PROJECT_CONFIG_DIRECTORY, "state"),
    };
  });

export const readOptionalLocalExecutorConfig = (
  path: string,
): Effect.Effect<
  LocalExecutorConfig | null,
  LocalFileSystemError | LocalExecutorConfigDecodeError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path).pipe(
      Effect.mapError(mapFileSystemError(path, "check config path")),
    );
    if (!exists) {
      return null;
    }

    const content = yield* fs.readFileString(path, "utf8").pipe(
      Effect.mapError(mapFileSystemError(path, "read config")),
    );
    return yield* Effect.try({
      try: () => parseJsonc({ path, content }),
      catch: (cause) =>
        cause instanceof LocalExecutorConfigDecodeError
          ? cause
          : new LocalExecutorConfigDecodeError({
              message: `Invalid executor config at ${path}: ${unknownLocalErrorDetails(cause)}`,
              path,
              details: unknownLocalErrorDetails(cause),
            }),
    });
  });

export const loadLocalExecutorConfig = (
  context: ResolvedLocalWorkspaceContext,
): Effect.Effect<
  FileLoadedExecutorConfig,
  LocalFileSystemError | LocalExecutorConfigDecodeError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const [homeConfig, projectConfig] = yield* Effect.all([
      readOptionalLocalExecutorConfig(context.homeConfigPath),
      readOptionalLocalExecutorConfig(context.projectConfigPath),
    ]);

    return {
      config: mergeLocalExecutorConfigs(homeConfig, projectConfig),
      homeConfig,
      projectConfig,
      homeConfigPath: context.homeConfigPath,
      projectConfigPath: context.projectConfigPath,
    };
  });

export const writeProjectLocalExecutorConfig = (input: {
  context: ResolvedLocalWorkspaceContext;
  config: LocalExecutorConfig;
}): Effect.Effect<void, LocalFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(input.context.configDirectory, { recursive: true }).pipe(
      Effect.mapError(mapFileSystemError(input.context.configDirectory, "create config directory")),
    );
    yield* fs.writeFileString(
      input.context.projectConfigPath,
      encodeLocalExecutorConfig(input.config),
    ).pipe(
      Effect.mapError(mapFileSystemError(input.context.projectConfigPath, "write config")),
    );
  });

export const defaultWorkspaceDisplayName = (context: ResolvedLocalWorkspaceContext): string =>
  trimOrUndefined(context.workspaceName) ?? "workspace";
