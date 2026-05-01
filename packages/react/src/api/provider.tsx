import { RegistryProvider } from "@effect/atom-react";
import * as React from "react";
import { ScopeProvider } from "./scope-context";

export const ExecutorProvider = (
  props: React.PropsWithChildren<{ fallback?: React.ReactNode }>,
) => (
  <RegistryProvider>
    <ScopeProvider fallback={props.fallback}>{props.children}</ScopeProvider>
  </RegistryProvider>
);
