import { RegistryProvider } from "@effect-atom/atom-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { ScopeProvider } from "./scope-context";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

export const ExecutorProvider = (
  props: React.PropsWithChildren<{ fallback?: React.ReactNode }>,
) => (
  <QueryClientProvider client={queryClient}>
    <RegistryProvider>
      <ScopeProvider fallback={props.fallback}>{props.children}</ScopeProvider>
    </RegistryProvider>
  </QueryClientProvider>
);
