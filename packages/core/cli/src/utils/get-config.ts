import { existsSync } from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import type { ExecutorCliConfig } from "@executor/sdk";

const defaultPaths = [
  "executor.config.ts",
  "executor.config.js",
  "src/executor.config.ts",
  "src/executor.config.js",
];

export const getConfig = async (opts: {
  cwd: string;
  configPath?: string;
}): Promise<ExecutorCliConfig | null> => {
  const { cwd, configPath } = opts;

  let resolvedPath: string | undefined;

  if (configPath) {
    resolvedPath = path.resolve(cwd, configPath);
    if (!existsSync(resolvedPath)) {
      console.error(`Config file not found: ${resolvedPath}`);
      return null;
    }
  } else {
    for (const p of defaultPaths) {
      const candidate = path.resolve(cwd, p);
      if (existsSync(candidate)) {
        resolvedPath = candidate;
        break;
      }
    }
  }

  if (!resolvedPath) return null;

  const jiti = createJiti(cwd, {
    interopDefault: true,
    moduleCache: false,
  });

  const mod = await jiti.import(resolvedPath);
  const config = (mod as { default?: ExecutorCliConfig }).default ?? mod;
  return config as ExecutorCliConfig;
};
