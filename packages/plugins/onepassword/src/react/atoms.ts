import type { ScopeId } from "@executor/sdk";
import { ReactivityKey } from "@executor/react/api/reactivity-keys";
import { OnePasswordClient } from "./client";

export const onepasswordWriteKeys = [ReactivityKey.secrets] as const;

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const onepasswordConfigAtom = (scopeId: ScopeId) =>
  OnePasswordClient.query("onepassword", "getConfig", {
    path: { scopeId },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.secrets],
  });

export const onepasswordStatusAtom = (scopeId: ScopeId) =>
  OnePasswordClient.query("onepassword", "status", {
    path: { scopeId },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.secrets],
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
    reactivityKeys: [ReactivityKey.secrets],
  });

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

export const configureOnePassword = OnePasswordClient.mutation("onepassword", "configure");

export const removeOnePasswordConfig = OnePasswordClient.mutation("onepassword", "removeConfig");
