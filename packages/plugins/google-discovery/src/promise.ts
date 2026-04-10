import { googleDiscoveryPlugin as googleDiscoveryPluginEffect } from "./sdk/plugin";

export type {
  GoogleDiscoveryAddSourceInput,
  GoogleDiscoveryProbeResult,
  GoogleDiscoveryOAuthStartInput,
  GoogleDiscoveryOAuthStartResponse,
  GoogleDiscoveryOAuthCompleteInput,
  GoogleDiscoveryOAuthAuthResult,
} from "./sdk/plugin";

export type { GoogleDiscoveryBindingStore } from "./sdk/binding-store";

export interface GoogleDiscoveryPluginOptions {
  readonly bindingStore?: import("./sdk/binding-store").GoogleDiscoveryBindingStore;
}

export const googleDiscoveryPlugin = (options?: GoogleDiscoveryPluginOptions) =>
  googleDiscoveryPluginEffect(options);
