import { keychainPlugin as keychainPluginEffect } from "./index";

export type { KeychainPluginConfig } from "./index";

export const keychainPlugin = (config?: { readonly serviceName?: string }) =>
  keychainPluginEffect(config);
