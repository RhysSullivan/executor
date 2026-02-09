"use client";

import { createContext, useContext, useMemo } from "react";
import { ConvexProviderWithAuth } from "convex/react";
import {
  AuthKitProvider,
  useAccessToken,
  useAuth as useWorkosAuth,
} from "@workos-inc/authkit-nextjs/components";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";
import { workosEnabled } from "@/lib/auth-capabilities";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
  throw new Error("CONVEX_URL is not set. Add it to the root .env file.");
}
const convexClient = new ConvexReactClient(convexUrl, {
  unsavedChangesWarning: false,
});

/** Exposes whether the WorkOS auth token is still being resolved. */
const WorkosAuthLoadingContext = createContext(false);
export function useWorkosAuthLoading() {
  return useContext(WorkosAuthLoadingContext);
}

function useConvexAuthFromWorkos() {
  const { loading, user } = useWorkosAuth();
  const { getAccessToken } = useAccessToken();

  const fetchAccessToken = useMemo(
    () => async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      try {
        const token = await getAccessToken();
        return token ?? null;
      } catch {
        return null;
      }
    },
    [getAccessToken],
  );

  return useMemo(
    () => ({
      isLoading: loading,
      isAuthenticated: !!user,
      fetchAccessToken,
    }),
    [loading, user, fetchAccessToken],
  );
}

function ConvexWithWorkos({ children }: { children: ReactNode }) {
  const { loading } = useWorkosAuth();

  return (
    <WorkosAuthLoadingContext.Provider value={loading}>
      <ConvexProviderWithAuth client={convexClient} useAuth={useConvexAuthFromWorkos}>
        {children}
      </ConvexProviderWithAuth>
    </WorkosAuthLoadingContext.Provider>
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

  return <ConvexProvider client={convexClient}>{children}</ConvexProvider>;
}
