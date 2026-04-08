import type { Plugin } from "@executor/sdk";
import { fileSecretsPlugin as _fileSecretsPlugin } from "./index";

export type { FileSecretsPluginConfig } from "./index";

export interface FileSecretsExtension {
  readonly filePath: string;
}

export const fileSecretsPlugin: (
  config?: { readonly directory?: string },
) => Plugin<"fileSecrets", FileSecretsExtension> = _fileSecretsPlugin as any;
