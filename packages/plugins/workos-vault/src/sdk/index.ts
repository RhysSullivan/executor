export {
  makeConfiguredWorkOSVaultClient,
  makeWorkOSVaultClient,
  WorkOSVaultClientError,
  WorkOSVaultClientInstantiationError,
  type WorkOSVaultClient,
  type WorkOSVaultCredentials,
  type WorkOSVaultObject,
  type WorkOSVaultObjectMetadata,
  type WorkOSVaultSdk,
} from "./client";
export {
  workosVaultPlugin,
  type WorkOSVaultExtension,
  type WorkOSVaultPluginOptions,
} from "./plugin";
export {
  WORKOS_VAULT_PROVIDER_KEY,
  defaultWorkOSVaultContextForScope,
  makeWorkOSVaultSecretProvider,
  makeWorkosVaultStore,
  workosVaultSchema,
  type WorkOSVaultContextForScope,
  type WorkOSVaultSecretProviderOptions,
  type WorkosVaultSchema,
  type WorkosVaultStore,
} from "./secret-store";
