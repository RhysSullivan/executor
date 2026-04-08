import type { ScopeId } from "@executor/core";
import { OnePasswordClient } from "./client";

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const onepasswordConfigAtom = (scopeId: ScopeId) =>
  OnePasswordClient.query("onepassword", "getConfig", {
    path: { scopeId },
    timeToLive: "30 seconds",
  });

export const onepasswordStatusAtom = (scopeId: ScopeId) =>
  OnePasswordClient.query("onepassword", "status", {
    path: { scopeId },
    timeToLive: "15 seconds",
  });

// ---------------------------------------------------------------------------
// Query atoms — vaults
// ---------------------------------------------------------------------------

export const onepasswordVaultsAtom = (
  authKind: "desktop-app" | "service-account",
  account: string,
  scopeId: ScopeId,
) =>
  OnePasswordClient.query("onepassword", "listVaults", {
    path: { scopeId },
    urlParams: { authKind, account },
    timeToLive: "30 seconds",
  });

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

export const configureOnePassword = OnePasswordClient.mutation(
  "onepassword",
  "configure",
);

export const removeOnePasswordConfig = OnePasswordClient.mutation(
  "onepassword",
  "removeConfig",
);
