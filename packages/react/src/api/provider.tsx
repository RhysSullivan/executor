import { RegistryProvider } from "@effect/atom-react";
import * as React from "react";
import { FrontendErrorReporterProvider, type FrontendErrorReporter } from "./error-reporting";
import { ScopeProvider } from "./scope-context";
import {
  ExecutorServerConnectionProvider,
  useExecutorServerConnection,
  type ExecutorServerConnectionInput,
} from "./server-connection";

function ExecutorRegistryProvider(
  props: React.PropsWithChildren<{
    readonly fallback?: React.ReactNode;
    readonly scopeFailureFallback?: React.ReactNode;
  }>,
) {
  const connection = useExecutorServerConnection();
  return (
    <RegistryProvider key={connection.key}>
      <ScopeProvider fallback={props.fallback} failureFallback={props.scopeFailureFallback}>
        {props.children}
      </ScopeProvider>
    </RegistryProvider>
  );
}

export const ExecutorProvider = (
  props: React.PropsWithChildren<{
    connection?: ExecutorServerConnectionInput;
    fallback?: React.ReactNode;
    scopeFailureFallback?: React.ReactNode;
    onHandledError?: FrontendErrorReporter;
  }>,
) => (
  <FrontendErrorReporterProvider reporter={props.onHandledError}>
    <ExecutorServerConnectionProvider connection={props.connection}>
      <ExecutorRegistryProvider
        fallback={props.fallback}
        scopeFailureFallback={props.scopeFailureFallback}
      >
        {props.children}
      </ExecutorRegistryProvider>
    </ExecutorServerConnectionProvider>
  </FrontendErrorReporterProvider>
);
