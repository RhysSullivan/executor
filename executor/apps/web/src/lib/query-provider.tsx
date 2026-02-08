"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./query-client";
import type { ReactNode } from "react";

export function QueryProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
