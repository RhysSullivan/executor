"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import { ConvexProviderWithAuth } from "convex/react";
import {
  AuthKitProvider,
  useAccessToken,
  useAuth as useWorkosAuth,
} from "@workos-inc/authkit-nextjs/components";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";
import { useQueryClient, useQuery as useTanstackQuery } from "@tanstack/react-query";
import {
  getAnonymousAuthToken,
  readStoredAnonymousAuthToken,
} from "@/lib/anonymous-auth";
import { workosEnabled } from "@/lib/auth-capabilities";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
  throw new Error("CONVEX_URL is not set. Add it to the root .env file.");
}
const convexClient = new ConvexReactClient(convexUrl, {
  unsavedChangesWarning: false,
});

/** Exposes whether the WorkOS auth token is still being resolved. */
const WorkosAuthContext = createContext({
  loading: false,
  authenticated: false,
});

export function useWorkosAuthState() {
  return useContext(WorkosAuthContext);
}

function useConvexAuthFromAnonymous() {
  const queryClient = useQueryClient();
  const tokenQuery = useTanstackQuery<string | null>({
    queryKey: ["anonymous-auth-token"],
    queryFn: async () => {
      const auth = await getAnonymousAuthToken();
      return auth.accessToken;
    },
    initialData: () => readStoredAnonymousAuthToken()?.accessToken ?? null,
    retry: false,
  });

  const fetchAccessToken = useCallback(async () => {
    const stored = readStoredAnonymousAuthToken();
    if (stored) {
      if (stored.accessToken !== tokenQuery.data) {
        queryClient.setQueryData(["anonymous-auth-token"], stored.accessToken);
        return stored.accessToken;
      }
      queryClient.setQueryData(["anonymous-auth-token"], tokenQuery.data);
      return tokenQuery.data;
    }

    const refreshed = await getAnonymousAuthToken(true);
    queryClient.setQueryData(["anonymous-auth-token"], refreshed.accessToken);
    return refreshed.accessToken;
  }, [queryClient, tokenQuery.data]);

  return useMemo(
    () => ({
      isLoading: tokenQuery.isPending,
      isAuthenticated: Boolean(tokenQuery.data),
      fetchAccessToken,
    }),
    [fetchAccessToken, tokenQuery.isPending, tokenQuery.data],
  );
}

function useConvexAuthFromWorkosOrAnonymous() {
  const { loading: authLoading, user } = useWorkosAuth();
  const { loading: tokenLoading, getAccessToken } = useAccessToken();
  const anonymousAuth = useConvexAuthFromAnonymous();
  const workosAuthenticated = Boolean(user);
  const isLoading = authLoading || (workosAuthenticated ? tokenLoading : anonymousAuth.isLoading);
  const isAuthenticated = workosAuthenticated || anonymousAuth.isAuthenticated;

  const fetchAccessToken = useCallback(async () => {
    if (workosAuthenticated) {
      try {
        const token = await getAccessToken();
        if (token) {
          return token;
        }
      } catch {
        // Fall through to anonymous token.
      }
    }

    return await anonymousAuth.fetchAccessToken();
  }, [anonymousAuth, getAccessToken, workosAuthenticated]);

  return useMemo(
    () => ({
      isLoading,
      isAuthenticated,
      fetchAccessToken,
    }),
    [isLoading, isAuthenticated, fetchAccessToken],
  );
}

function ConvexWithWorkos({ children }: { children: ReactNode }) {
  const { loading: authLoading, user } = useWorkosAuth();
  const { loading: tokenLoading } = useAccessToken();
  const authenticated = Boolean(user);
  const loading = authLoading || (authenticated && tokenLoading);

  return (
    <WorkosAuthContext.Provider value={{ loading, authenticated }}>
      <ConvexProviderWithAuth client={convexClient} useAuth={useConvexAuthFromWorkosOrAnonymous}>
        {children}
      </ConvexProviderWithAuth>
    </WorkosAuthContext.Provider>
  );
}

export function AppConvexProvider({ children }: { children: ReactNode }) {
  if (workosEnabled) {
    return (
      <AuthKitProvider>
        <ConvexWithWorkos>{children}</ConvexWithWorkos>
      </AuthKitProvider>
    );
  }

  return (
    <WorkosAuthContext.Provider value={{ loading: false, authenticated: false }}>
      <ConvexProviderWithAuth client={convexClient} useAuth={useConvexAuthFromAnonymous}>
        {children}
      </ConvexProviderWithAuth>
    </WorkosAuthContext.Provider>
  );
}
