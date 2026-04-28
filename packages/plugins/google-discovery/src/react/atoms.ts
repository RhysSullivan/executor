import type { ScopeId } from "@executor/sdk";
import { ReactivityKey } from "@executor/react/api/reactivity-keys";
import { GoogleDiscoveryClient } from "./client";

export const googleDiscoverySourceAtom = (scopeId: ScopeId, namespace: string) =>
  GoogleDiscoveryClient.query("googleDiscovery", "getSource", {
    path: { scopeId, namespace },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.sources, ReactivityKey.tools],
  });

export const probeGoogleDiscovery = GoogleDiscoveryClient.mutation(
  "googleDiscovery",
  "probeDiscovery",
);
export const addGoogleDiscoverySource = GoogleDiscoveryClient.mutation(
  "googleDiscovery",
  "addSource",
);
export const updateGoogleDiscoverySource = GoogleDiscoveryClient.mutation(
  "googleDiscovery",
  "updateSource",
);
export const startGoogleDiscoveryOAuth = GoogleDiscoveryClient.mutation(
  "googleDiscovery",
  "startOAuth",
);
export const completeGoogleDiscoveryOAuth = GoogleDiscoveryClient.mutation(
  "googleDiscovery",
  "completeOAuth",
);
