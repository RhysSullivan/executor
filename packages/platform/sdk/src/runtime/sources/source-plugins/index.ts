import {
  registerExecutorSdkPlugins,
  type ExecutorSdkPlugin,
} from "../../../plugins";

let configuredSourcePlugins: readonly ExecutorSdkPlugin<any, any>[] = [];
let registry = registerExecutorSdkPlugins(configuredSourcePlugins);

const refreshRegistry = () => {
  registry = registerExecutorSdkPlugins(configuredSourcePlugins);
};

export const configureExecutorSourcePlugins = (
  plugins: readonly ExecutorSdkPlugin<any, any>[],
): void => {
  configuredSourcePlugins = plugins;
  refreshRegistry();
};

export const registeredSourceContributions = () => registry.sources;

export const getSourceContribution = (kind: string) =>
  registry.getSourceContribution(kind);
export const getSourceContributionForSource = (
  source: Parameters<typeof registry.getSourceContributionForSource>[0],
) => registry.getSourceContributionForSource(source);

export const hasRegisteredExternalSourcePlugins = () =>
  configuredSourcePlugins.length > 0;
