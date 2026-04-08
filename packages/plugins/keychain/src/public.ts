import type { Plugin } from "@executor/sdk";
import { keychainPlugin as _keychainPlugin } from "./index";

export type { KeychainPluginConfig } from "./index";

export interface KeychainExtension {
  readonly displayName: string;
  readonly isSupported: boolean;
  readonly has: (secretId: string) => Promise<boolean>;
}

export const keychainPlugin: (
  config?: { readonly serviceName?: string },
) => Plugin<"keychain", KeychainExtension> = _keychainPlugin as any;
