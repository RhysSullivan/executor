import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import {
  registerExecutorSdkPlugins,
  type ExecutorSdkPlugin,
  type ExecutorSdkPluginRegistry,
} from "../../../plugins";

export class ExecutorPluginRegistryService extends Context.Tag(
  "#runtime/ExecutorPluginRegistryService",
)<ExecutorPluginRegistryService, ExecutorSdkPluginRegistry>() {}

export const createExecutorPluginRegistry = (
  plugins: readonly ExecutorSdkPlugin<any, any>[] = [],
): ExecutorSdkPluginRegistry => registerExecutorSdkPlugins(plugins);

export const emptyExecutorPluginRegistry = (): ExecutorSdkPluginRegistry =>
  createExecutorPluginRegistry();

export const ExecutorPluginRegistryLive = (
  registry: ExecutorSdkPluginRegistry,
) => Layer.succeed(ExecutorPluginRegistryService, registry);

export const registeredSourceContributions = (
  registry: ExecutorSdkPluginRegistry,
) => registry.sources;

export const registeredSecretStoreContributions = (
  registry: ExecutorSdkPluginRegistry,
) => registry.secretStores;

export const registeredManagementToolContributions = (
  registry: ExecutorSdkPluginRegistry,
) => registry.managementTools;

export const getSourceContribution = (
  registry: ExecutorSdkPluginRegistry,
  kind: string,
) => registry.getSourceContribution(kind);

export const getSourceContributionForSource = (
  registry: ExecutorSdkPluginRegistry,
  source: Parameters<ExecutorSdkPluginRegistry["getSourceContributionForSource"]>[0],
) => registry.getSourceContributionForSource(source);

export const getSecretStoreContribution = (
  registry: ExecutorSdkPluginRegistry,
  kind: string,
) => registry.getSecretStoreContribution(kind);

export const getSecretStoreContributionForStore = (
  registry: ExecutorSdkPluginRegistry,
  store: Parameters<ExecutorSdkPluginRegistry["getSecretStoreContributionForStore"]>[0],
) => registry.getSecretStoreContributionForStore(store);

export const hasRegisteredExternalSourcePlugins = (
  registry: ExecutorSdkPluginRegistry,
) => registry.plugins.length > 0;
