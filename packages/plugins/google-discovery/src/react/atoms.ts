import type { ScopeId } from "@executor/sdk";
import { GoogleDiscoveryClient } from "./client";

export const googleDiscoverySourceAtom = (scopeId: ScopeId, namespace: string) =>
  GoogleDiscoveryClient.query("googleDiscovery", "getSource", {
    path: { scopeId, namespace },
    timeToLive: "15 seconds",
  });

export const probeGoogleDiscovery = GoogleDiscoveryClient.mutation(
  "googleDiscovery",
  "probeDiscovery",
);
export const addGoogleDiscoverySource = GoogleDiscoveryClient.mutation(
  "googleDiscovery",
  "addSource",
);
export const startGoogleDiscoveryOAuth = GoogleDiscoveryClient.mutation(
  "googleDiscovery",
  "startOAuth",
);
export const completeGoogleDiscoveryOAuth = GoogleDiscoveryClient.mutation(
  "googleDiscovery",
  "completeOAuth",
);
