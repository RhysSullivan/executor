import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_EXECUTOR_DATA_DIR,
  DEFAULT_LOCAL_DATA_DIR,
  EXECUTOR_LOCAL_DATA_DIR_ENV,
  EXECUTOR_WEB_ASSETS_DIR_ENV,
} from "@executor/server";

const sourceDir = dirname(fileURLToPath(import.meta.url));

const trim = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
};

const resolveIfExists = (value: string | undefined): string | null => {
  const candidate = trim(value);
  if (!candidate) {
    return null;
  }

  const resolved = resolve(candidate);
  return existsSync(resolved) ? resolved : null;
};

const getSourceEntrypoint = (): string | null => {
  const candidate = trim(process.argv[1]);
  if (!candidate) {
    return null;
  }

  const resolved = resolve(candidate);
  const extension = extname(resolved).toLowerCase();
  return [".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(extension)
    ? resolved
    : null;
};

const isSourceCliLaunch = (): boolean => getSourceEntrypoint() !== null;

const resolveBundledNodeLauncher = (): string | null => {
  const candidate = resolve(sourceDir, "executor.js");
  return existsSync(candidate) ? candidate : null;
};


const resolveRuntimeResourcesRoot = (): string | null => {
  const compiledCandidate = resolve(dirname(process.execPath), "../resources");
  if (existsSync(compiledCandidate)) {
    return compiledCandidate;
  }

  const bundledCandidateFromModule = resolve(sourceDir, "../resources");
  if (existsSync(bundledCandidateFromModule)) {
    return bundledCandidateFromModule;
  }

  const sourceEntrypoint = getSourceEntrypoint();
  if (sourceEntrypoint) {
    const bundledCandidate = resolve(dirname(sourceEntrypoint), "../resources");
    if (existsSync(bundledCandidate)) {
      return bundledCandidate;
    }
  }

  return null;
};

export const resolveSelfCommand = (args: readonly string[]): readonly string[] => {
  const bundledLauncher = resolveBundledNodeLauncher();
  if (bundledLauncher !== null) {
    return [process.execPath, bundledLauncher, ...args];
  }

  const sourceEntrypoint = getSourceEntrypoint();
  return sourceEntrypoint === null
    ? [process.execPath, ...args]
    : [process.execPath, sourceEntrypoint, ...args];
};

export const resolveCliLocalDataDir = (): string => {
  if (trim(process.env[EXECUTOR_LOCAL_DATA_DIR_ENV])) {
    return DEFAULT_LOCAL_DATA_DIR;
  }

  return isSourceCliLaunch()
    ? join(DEFAULT_EXECUTOR_DATA_DIR, "control-plane-web-dev")
    : DEFAULT_LOCAL_DATA_DIR;
};

export const resolveRuntimeWebAssetsDir = (): string | null => {
  const explicit = resolveIfExists(process.env[EXECUTOR_WEB_ASSETS_DIR_ENV]);
  if (explicit) {
    return explicit;
  }

  const resourcesRoot = resolveRuntimeResourcesRoot();
  const bundled = resourcesRoot
    ? resolveIfExists(resolve(resourcesRoot, "web"))
    : null;
  if (bundled) {
    return bundled;
  }

  return resolveIfExists(resolve(sourceDir, "../../../web/dist"));
};
