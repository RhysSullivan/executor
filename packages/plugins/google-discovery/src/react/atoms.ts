import type { ScopeId } from "@executor-js/sdk/core";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { GoogleDiscoveryClient } from "./client";

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const googleDiscoverySourceAtom = (scopeId: ScopeId, namespace: string) =>
  GoogleDiscoveryClient.query("googleDiscovery", "getSource", {
    path: { scopeId, namespace },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.sources, ReactivityKey.tools],
  });

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

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
// OAuth flow atoms live on `@executor-js/react/api/atoms` now —
// `startOAuth`, `completeOAuth`, `probeOAuth`, `cancelOAuth` — one
// pair serves every OAuth-capable plugin.
