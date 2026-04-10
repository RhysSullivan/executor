import { fileSecretsPlugin as fileSecretsPluginEffect } from "./index";

export type { FileSecretsPluginConfig } from "./index";

export const fileSecretsPlugin = (config?: { readonly directory?: string }) =>
  fileSecretsPluginEffect(config);
