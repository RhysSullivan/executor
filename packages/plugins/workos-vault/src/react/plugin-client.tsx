import { defineClientPlugin } from "@executor-js/sdk/client";

import { workosVaultSecretProviderPlugin } from "./secret-provider-plugin";

export default defineClientPlugin({
  id: "workosVault" as const,
  secretProviderPlugin: workosVaultSecretProviderPlugin,
});
