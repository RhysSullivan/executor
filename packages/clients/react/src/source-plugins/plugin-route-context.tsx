import * as React from "react";

import type {
  ExecutorPluginRouteContextValue,
  FrontendPluginRouteParams,
  FrontendPluginRouteSearch,
} from "./types";

const ExecutorPluginRouteContext =
  React.createContext<ExecutorPluginRouteContextValue | null>(null);

export function ExecutorPluginRouteProvider(props: {
  value: ExecutorPluginRouteContextValue;
  children: React.ReactNode;
}) {
  return (
    <ExecutorPluginRouteContext.Provider value={props.value}>
      {props.children}
    </ExecutorPluginRouteContext.Provider>
  );
}

const useExecutorPluginRouteContext = (): ExecutorPluginRouteContextValue => {
  const value = React.useContext(ExecutorPluginRouteContext);
  if (value === null) {
    throw new Error("Executor plugin route context is unavailable.");
  }

  return value;
};

export const useExecutorPluginRoute = (): ExecutorPluginRouteContextValue =>
  useExecutorPluginRouteContext();

export const useExecutorPlugin = () =>
  useExecutorPluginRouteContext().plugin;

export const useExecutorPluginRouteDefinition = () =>
  useExecutorPluginRouteContext().route;

export const useExecutorPluginNavigation = () =>
  useExecutorPluginRouteContext().navigation;

export const useExecutorPluginSearch = <
  TSearch extends FrontendPluginRouteSearch = FrontendPluginRouteSearch,
>(): TSearch =>
  useExecutorPluginRouteContext().search as TSearch;

export const useExecutorPluginRouteParams = <
  TParams extends FrontendPluginRouteParams = FrontendPluginRouteParams,
>(): TParams =>
  useExecutorPluginRouteContext().params as TParams;

export const useExecutorPluginPaths = () =>
  useExecutorPluginRouteContext().navigation.paths;
