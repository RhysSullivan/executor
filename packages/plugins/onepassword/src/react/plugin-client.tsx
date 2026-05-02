import { defineClientPlugin } from "@executor-js/sdk/client";

import { onePasswordSecretProviderPlugin } from "./secret-provider-plugin";

export default defineClientPlugin({
  id: "onepassword" as const,
  secretProviderPlugin: onePasswordSecretProviderPlugin,
});
