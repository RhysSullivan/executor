"use client";

import { ConvexProviderWithAuthKit } from "@convex-dev/workos";
import {
  AuthKitProvider,
  useAccessToken,
  useAuth as useWorkosAuth,
} from "@workos-inc/authkit-nextjs/components";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";
import { workosEnabled } from "@/lib/auth-capabilities";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL ?? "http://127.0.0.1:3210";
const convexClient = new ConvexReactClient(convexUrl, {
  unsavedChangesWarning: false,
});

function useConvexWorkosAuth() {
  const { loading, user } = useWorkosAuth();
  const { getAccessToken } = useAccessToken();
  return {
    isLoading: loading,
    user,
    getAccessToken: async () => (await getAccessToken()) ?? null,
  };
}

export function AppConvexProvider({ children }: { children: ReactNode }) {
  if (workosEnabled) {
    return (
      <AuthKitProvider>
        <ConvexProviderWithAuthKit client={convexClient} useAuth={useConvexWorkosAuth}>
          {children}
        </ConvexProviderWithAuthKit>
      </AuthKitProvider>
    );
  }

  return <ConvexProvider client={convexClient}>{children}</ConvexProvider>;
}
