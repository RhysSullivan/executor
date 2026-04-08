import type { Plugin } from "@executor/sdk";
import {
  googleDiscoveryPlugin as _googleDiscoveryPlugin,
  type GoogleDiscoveryAddSourceInput,
  type GoogleDiscoveryProbeResult,
  type GoogleDiscoveryOAuthStartInput,
  type GoogleDiscoveryOAuthStartResponse,
  type GoogleDiscoveryOAuthCompleteInput,
  type GoogleDiscoveryOAuthAuthResult,
} from "./sdk/plugin";

export type {
  GoogleDiscoveryAddSourceInput,
  GoogleDiscoveryProbeResult,
  GoogleDiscoveryOAuthStartInput,
  GoogleDiscoveryOAuthStartResponse,
  GoogleDiscoveryOAuthCompleteInput,
  GoogleDiscoveryOAuthAuthResult,
} from "./sdk/plugin";

export interface GoogleDiscoveryExtension {
  readonly probeDiscovery: (
    discoveryUrl: string,
  ) => Promise<GoogleDiscoveryProbeResult>;
  readonly addSource: (
    input: GoogleDiscoveryAddSourceInput,
  ) => Promise<{ readonly toolCount: number; readonly namespace: string }>;
  readonly removeSource: (namespace: string) => Promise<void>;
  readonly startOAuth: (
    input: GoogleDiscoveryOAuthStartInput,
  ) => Promise<GoogleDiscoveryOAuthStartResponse>;
  readonly completeOAuth: (
    input: GoogleDiscoveryOAuthCompleteInput,
  ) => Promise<GoogleDiscoveryOAuthAuthResult>;
}

export const googleDiscoveryPlugin: (
  options?: {},
) => Plugin<"googleDiscovery", GoogleDiscoveryExtension> =
  _googleDiscoveryPlugin as any;
