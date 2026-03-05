"use client";

import { RegistryProvider } from "@effect-atom/atom-react";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

type ProvidersProps = {
  children: ReactNode;
};

export const Providers = ({ children }: ProvidersProps) => (
  <ThemeProvider
    attribute="class"
    defaultTheme="dark"
    enableSystem
    enableColorScheme
  >
    <RegistryProvider>{children}</RegistryProvider>
  </ThemeProvider>
);
