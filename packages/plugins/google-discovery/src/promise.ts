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

export type GoogleDiscoveryPluginOptions = Record<string, never>;

export const googleDiscoveryPlugin = (_options?: GoogleDiscoveryPluginOptions) =>
  googleDiscoveryPluginEffect();
