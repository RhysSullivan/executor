import { Effect, Layer } from "effect";
import {
  FEATURE_FLAG_GENERATED_UI_MCP_APPS,
  FeatureFlags,
  type FeatureFlagsShape,
} from "@executor-js/host-mcp";

const truthy = (value: string | undefined): boolean =>
  value === "1" || value === "true" || value === "TRUE" || value === "yes" || value === "on";

const envNameForFlag = (flag: string): string =>
  `EXECUTOR_FEATURE_${flag.replaceAll(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()}`;

const readFlag = (flag: string, env: NodeJS.ProcessEnv): boolean => {
  const generic = env[envNameForFlag(flag)];
  if (generic !== undefined) return truthy(generic);

  if (flag === FEATURE_FLAG_GENERATED_UI_MCP_APPS) {
    return truthy(env.EXECUTOR_GENERATED_UI) || truthy(env.EXECUTOR_DYNAMIC_UI);
  }

  return false;
};

export const makeLocalEnvFeatureFlags = (
  env: NodeJS.ProcessEnv = process.env,
): FeatureFlagsShape => ({
  isEnabled: (flag) => Effect.sync(() => readFlag(flag, env)),
});

export const LocalEnvFeatureFlags = Layer.succeed(FeatureFlags, makeLocalEnvFeatureFlags());
