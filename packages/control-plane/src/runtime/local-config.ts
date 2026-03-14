import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promises as fs } from "node:fs";
import {
  type ParseError as JsoncParseError,
  parse as parseJsoncDocument,
  printParseErrorCode,
} from "jsonc-parser";

import {
  LocalExecutorConfigSchema,
  type LocalExecutorConfig,
  type LocalConfigPolicy,
  type LocalConfigSecretProvider,
  type LocalConfigSource,
} from "#schema";
import * as Schema from "effect/Schema";

const decodeLocalExecutorConfig = Schema.decodeUnknownSync(LocalExecutorConfigSchema);

const PROJECT_CONFIG_BASENAME = "executor.jsonc";
const PROJECT_CONFIG_FALLBACK_BASENAME = "executor.json";
const PROJECT_CONFIG_DIRECTORY = ".executor";
const EXECUTOR_CONFIG_DIR_ENV = "EXECUTOR_CONFIG_DIR";

const normalizeSlashPath = (value: string): string =>
  value.replaceAll("\\", "/");

const stableHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
};

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

const legacyExecutorConfigDirectory = (input: {
  homeDirectory?: string;
} = {}): string =>
  join(input.homeDirectory ?? homedir(), ".config", "executor");

export const resolveDefaultHomeConfigCandidates = (input: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
} = {}): string[] => {
  const homeDirectory = input.homeDirectory ?? homedir();
  const canonicalDirectory = defaultExecutorConfigDirectory({
    env: input.env,
    platform: input.platform,
    homeDirectory,
  });
  const legacyDirectory = legacyExecutorConfigDirectory({ homeDirectory });
  const directories = canonicalDirectory === legacyDirectory
    ? [canonicalDirectory]
    : [canonicalDirectory, legacyDirectory];

  return directories.flatMap((directory) => [
    join(directory, PROJECT_CONFIG_BASENAME),
    join(directory, PROJECT_CONFIG_FALLBACK_BASENAME),
  ]);
};

export const resolveHomeConfigPath = async (input: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
} = {}): Promise<string> => {
  const candidates = resolveDefaultHomeConfigCandidates(input);

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return candidates[0]!;
};

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
      throw new Error(formatJsoncParseErrors(input.content, errors));
    }

    return decodeLocalExecutorConfig(parsed);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Invalid executor config at ${input.path}: ${message}`);
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
    ...(base ?? {}),
    ...(extra ?? {}),
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
    ...(base ?? {}),
    ...(extra ?? {}),
  };
};

const mergeSecretProviderMaps = (
  base: Record<string, LocalConfigSecretProvider> | undefined,
  extra: Record<string, LocalConfigSecretProvider> | undefined,
): Record<string, LocalConfigSecretProvider> | undefined => {
  if (!base && !extra) {
    return undefined;
  }
  return {
    ...(base ?? {}),
    ...(extra ?? {}),
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
    workspace: {
      ...(base?.workspace ?? {}),
      ...(extra?.workspace ?? {}),
    },
    sources: mergeSourceMaps(base?.sources, extra?.sources),
    policies: mergePolicyMaps(base?.policies, extra?.policies),
    secrets: {
      providers: mergeSecretProviderMaps(
        base?.secrets?.providers,
        extra?.secrets?.providers,
      ),
      defaults: {
        ...(base?.secrets?.defaults ?? {}),
        ...(extra?.secrets?.defaults ?? {}),
      },
    },
  });
};

const resolveProjectConfigPath = async (workspaceRoot: string): Promise<string> => {
  const jsoncPath = join(workspaceRoot, PROJECT_CONFIG_DIRECTORY, PROJECT_CONFIG_BASENAME);
  if (await fileExists(jsoncPath)) {
    return jsoncPath;
  }

  const jsonPath = join(workspaceRoot, PROJECT_CONFIG_DIRECTORY, PROJECT_CONFIG_FALLBACK_BASENAME);
  if (await fileExists(jsonPath)) {
    return jsonPath;
  }

  return jsoncPath;
};

const hasProjectConfig = async (workspaceRoot: string): Promise<boolean> =>
  fileExists(join(workspaceRoot, PROJECT_CONFIG_DIRECTORY, PROJECT_CONFIG_BASENAME))
  || fileExists(join(workspaceRoot, PROJECT_CONFIG_DIRECTORY, PROJECT_CONFIG_FALLBACK_BASENAME));

const resolveWorkspaceRootFromCwd = async (cwd: string): Promise<string> => {
  let current = resolve(cwd);
  let nearestProjectConfigRoot: string | null = null;
  let nearestGitRoot: string | null = null;

  while (true) {
    if (nearestProjectConfigRoot === null && (await hasProjectConfig(current))) {
      nearestProjectConfigRoot = current;
    }

    if (nearestGitRoot === null && (await pathExists(join(current, ".git")))) {
      nearestGitRoot = current;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return nearestProjectConfigRoot ?? nearestGitRoot ?? resolve(cwd);
};

export type ResolvedLocalWorkspaceContext = {
  cwd: string;
  workspaceRoot: string;
  workspaceName: string;
  configDirectory: string;
  projectConfigPath: string;
  homeConfigPath: string;
  artifactsDirectory: string;
  stateDirectory: string;
  installationId: string;
};

export type LoadedLocalExecutorConfig = {
  config: LocalExecutorConfig | null;
  homeConfig: LocalExecutorConfig | null;
  projectConfig: LocalExecutorConfig | null;
  homeConfigPath: string;
  projectConfigPath: string;
};

export const resolveLocalWorkspaceContext = async (input: {
  cwd?: string;
  workspaceRoot?: string;
} = {}): Promise<ResolvedLocalWorkspaceContext> => {
  const cwd = resolve(input.cwd ?? process.cwd());
  const workspaceRoot = resolve(
    input.workspaceRoot ?? (await resolveWorkspaceRootFromCwd(cwd)),
  );
  const workspaceName = basename(workspaceRoot) || "workspace";
  const projectConfigPath = await resolveProjectConfigPath(workspaceRoot);
  const homeConfigPath = await resolveHomeConfigPath();

  return {
    cwd,
    workspaceRoot,
    workspaceName,
    configDirectory: join(workspaceRoot, PROJECT_CONFIG_DIRECTORY),
    projectConfigPath,
    homeConfigPath,
    artifactsDirectory: join(workspaceRoot, PROJECT_CONFIG_DIRECTORY, "artifacts"),
    stateDirectory: join(workspaceRoot, PROJECT_CONFIG_DIRECTORY, "state"),
    installationId: `local_${stableHash(normalizeSlashPath(workspaceRoot))}`,
  };
};

export const readOptionalLocalExecutorConfig = async (
  path: string,
): Promise<LocalExecutorConfig | null> => {
  if (!(await fileExists(path))) {
    return null;
  }

  const content = await fs.readFile(path, "utf8");
  return parseJsonc({ path, content });
};

export const loadLocalExecutorConfig = async (
  context: ResolvedLocalWorkspaceContext,
): Promise<LoadedLocalExecutorConfig> => {
  const [homeConfig, projectConfig] = await Promise.all([
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
};

export const encodeLocalExecutorConfig = (config: LocalExecutorConfig): string =>
  `${JSON.stringify(config, null, 2)}\n`;

export const writeProjectLocalExecutorConfig = async (input: {
  context: ResolvedLocalWorkspaceContext;
  config: LocalExecutorConfig;
}): Promise<void> => {
  await fs.mkdir(input.context.configDirectory, { recursive: true });
  await fs.writeFile(
    input.context.projectConfigPath,
    encodeLocalExecutorConfig(input.config),
    "utf8",
  );
};

export const resolveConfigRelativePath = (input: {
  path: string;
  workspaceRoot: string;
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
  return resolve(input.workspaceRoot, trimmed);
};

export const defaultWorkspaceDisplayName = (context: ResolvedLocalWorkspaceContext): string =>
  trimOrUndefined(context.workspaceName) ?? "workspace";
