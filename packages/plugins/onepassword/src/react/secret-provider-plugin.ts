import { lazy } from "react";
import type { SecretProviderPlugin } from "@executor-js/sdk/client";

export const onePasswordSecretProviderPlugin: SecretProviderPlugin = {
  key: "onepassword",
  label: "1Password",
  settings: lazy(() => import("./OnePasswordSettings")),
};
