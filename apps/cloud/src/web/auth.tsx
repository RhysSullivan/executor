import React, { createContext, useContext } from "react";
import { Atom } from "@effect-atom/atom";
import { useAtomValue, Result } from "@effect-atom/atom-react";

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
});

export const organizationsAtom = Atom.refreshOnWindowFocus(
  CloudApiClient.query("cloudAuth", "organizations", { timeToLive: "1 minute" }),
);

export const switchOrganization = CloudApiClient.mutation("cloudAuth", "switchOrganization");
export const createOrganization = CloudApiClient.mutation("cloudAuth", "createOrganization");

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

  const state: AuthState = Result.match(result, {
    onInitial: () => ({ status: "loading" as const }),
    onSuccess: ({ value }) => ({
      status: "authenticated" as const,
      user: value.user,
      organization: value.organization,
    }),
    onFailure: () => ({ status: "unauthenticated" as const }),
  });

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
};

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  if (typeof window === "undefined") {
    return <AuthContext.Provider value={{ status: "loading" }}>{children}</AuthContext.Provider>;
  }
  return <AuthProviderClient>{children}</AuthProviderClient>;
};
