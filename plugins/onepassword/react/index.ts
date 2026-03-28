import { defineExecutorFrontendPlugin } from "@executor/react/plugins";
import { ONEPASSWORD_SECRET_STORE_KIND } from "@executor/plugin-onepassword-shared";

import { OnePasswordSecretStoreCreateForm } from "./components";

export const OnePasswordReactPlugin = defineExecutorFrontendPlugin({
  key: "onepassword",
  displayName: "1Password",
  secretStore: {
    kind: ONEPASSWORD_SECRET_STORE_KIND,
    CreateStoreForm: OnePasswordSecretStoreCreateForm,
  },
});
