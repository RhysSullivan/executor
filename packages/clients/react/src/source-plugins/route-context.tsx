import * as React from "react";

import type {
  SourcePluginRouteContextValue,
  SourcePluginRouteParams,
  SourcePluginRouteSearch,
} from "./types";

const SourcePluginRouteContext =
  React.createContext<SourcePluginRouteContextValue | null>(null);

export function SourcePluginRouteProvider(props: {
  value: SourcePluginRouteContextValue;
  children: React.ReactNode;
}) {
  return (
    <SourcePluginRouteContext.Provider value={props.value}>
      {props.children}
    </SourcePluginRouteContext.Provider>
  );
}

const useSourcePluginRouteContext = (): SourcePluginRouteContextValue => {
  const value = React.useContext(SourcePluginRouteContext);
  if (value === null) {
    throw new Error("Source plugin route context is unavailable.");
  }
  return value;
};

export const useSourcePluginRoute = (): SourcePluginRouteContextValue =>
  useSourcePluginRouteContext();

export const useSourcePluginDefinition = () =>
  useSourcePluginRouteContext().definition;

export const useSourcePluginNavigation = () =>
  useSourcePluginRouteContext().navigation;

export const useSourcePluginSearch = <
  TSearch extends SourcePluginRouteSearch = SourcePluginRouteSearch,
>(): TSearch =>
  useSourcePluginRouteContext().search as TSearch;

export const useSourcePluginRouteParams = <
  TParams extends SourcePluginRouteParams = SourcePluginRouteParams,
>(): TParams =>
  useSourcePluginRouteContext().params as TParams;

export const useSourcePluginPaths = () =>
  useSourcePluginRouteContext().navigation.paths;
