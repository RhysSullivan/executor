import { lazy } from "react";
import type { SourcePlugin } from "@executor-js/sdk/client";
import { googleDiscoveryPresets } from "../sdk/presets";

export const googleDiscoverySourcePlugin: SourcePlugin = {
  key: "googleDiscovery",
  label: "Google Discovery",
  add: lazy(() => import("./AddGoogleDiscoverySource")),
  edit: lazy(() => import("./EditGoogleDiscoverySource")),
  summary: lazy(() => import("./GoogleDiscoverySourceSummary")),
  signIn: lazy(() => import("./GoogleDiscoverySignInButton")),
  presets: googleDiscoveryPresets,
};
