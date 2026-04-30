import { type Plugin } from "@executor-js/sdk/core";

import {
  fileSecretsPlugin as fileSecretsPluginEffect,
  type FileSecretsExtension,
  type FileSecretsPluginConfig,
} from "./index";

export type { FileSecretsPluginConfig } from "./index";

// Explicit return type so the emitted dist/promise.d.ts references
// `import("@executor-js/sdk/core").Plugin` (where `Plugin` lives) rather
// than `import("@executor-js/sdk").Plugin` (the Promise surface, which
// doesn't re-export Plugin).
export const fileSecretsPlugin = (
  config?: FileSecretsPluginConfig,
): Plugin<"fileSecrets", FileSecretsExtension, Record<string, never>, undefined> =>
  fileSecretsPluginEffect(config);
