import React, { createContext, useContext, useEffect } from "react";
import * as Atom from "effect/unstable/reactivity/Atom";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { usePostHog } from "posthog-js/react";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";

import { CloudApiClient } from "./client";

// ---------------------------------------------------------------------------
// Types (from CloudAuthApi response schema)
// ---------------------------------------------------------------------------

type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

type AuthOrganization = {
  id: string;
  name: string;
};

// ---------------------------------------------------------------------------
// Auth atom — typed query against CloudAuthApi
// ---------------------------------------------------------------------------

export const authAtom = CloudApiClient.query("cloudAuth", "me", {
  timeToLive: "5 minutes",
  reactivityKeys: [ReactivityKey.auth],
});

export const organizationsAtom = Atom.refreshOnWindowFocus(
  CloudApiClient.query("cloudAuth", "organizations", {
    timeToLive: "1 minute",
    reactivityKeys: [ReactivityKey.auth],
  }),
);

export const switchOrganization = CloudApiClient.mutation("cloudAuth", "switchOrganization");
export const createOrganization = CloudApiClient.mutation("cloudAuth", "createOrganization");

export const pendingInvitationsAtom = CloudApiClient.query("cloudAuth", "pendingInvitations", {
  timeToLive: "1 minute",
  reactivityKeys: [ReactivityKey.auth],
});

export const acceptInvitation = CloudApiClient.mutation("cloudAuth", "acceptInvitation");

// ---------------------------------------------------------------------------
// Provider + hook
// ---------------------------------------------------------------------------

type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: AuthUser; organization: AuthOrganization | null };

const AuthContext = createContext<AuthState>({ status: "loading" });

export const useAuth = () => useContext(AuthContext);

const AuthProviderClient = ({ children }: { children: React.ReactNode }) => {
  const result = useAtomValue(authAtom);
  const posthog = usePostHog();

  const state: AuthState = AsyncResult.match(result, {
    onInitial: () => ({ status: "loading" as const }),
    onSuccess: ({ value }) => ({
      status: "authenticated" as const,
      user: value.user,
      organization: value.organization,
    }),
    onFailure: () => ({ status: "unauthenticated" as const }),
  });

  const userId = state.status === "authenticated" ? state.user.id : null;
  const email = state.status === "authenticated" ? state.user.email : null;
  const name = state.status === "authenticated" ? state.user.name : null;
  const orgId = state.status === "authenticated" ? (state.organization?.id ?? null) : null;
  const orgName = state.status === "authenticated" ? (state.organization?.name ?? null) : null;
  const isUnauthenticated = state.status === "unauthenticated";

  useEffect(() => {
    if (!posthog) return;
    if (userId) {
      posthog.identify(userId, { email, name });
      if (orgId) {
        posthog.group("organization", orgId, { name: orgName });
      }
    } else if (isUnauthenticated) {
      posthog.reset();
    }
  }, [posthog, userId, email, name, orgId, orgName, isUnauthenticated]);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
};

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  if (typeof window === "undefined") {
    return <AuthContext.Provider value={{ status: "loading" }}>{children}</AuthContext.Provider>;
  }
  return <AuthProviderClient>{children}</AuthProviderClient>;
};
