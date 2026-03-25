import type { ComponentType } from "react";
import type { Source } from "@executor/platform-sdk/schema";

import type {
  ExecutorPluginPaths,
  SourcePluginPaths,
} from "./paths";

export type FrontendPluginRouteSearch = Record<string, unknown>;
export type FrontendPluginRouteParams = Readonly<Record<string, string | undefined>>;

export type ExecutorPluginNavigation = {
  paths: ExecutorPluginPaths;
  home: () => void | Promise<void>;
  route: (path?: string, search?: FrontendPluginRouteSearch) => void | Promise<void>;
  updateSearch: (search: FrontendPluginRouteSearch) => void | Promise<void>;
};

export type FrontendPluginRouteDefinition = {
  key: string;
  path?: string;
  component: ComponentType;
  navigationLabel?: string;
};

export type ExecutorPluginRouteContextValue = {
  plugin: ExecutorFrontendPlugin;
  route: FrontendPluginRouteDefinition;
  params: FrontendPluginRouteParams;
  search: FrontendPluginRouteSearch;
  navigation: ExecutorPluginNavigation;
};

export type SourcePluginRouteSearch = FrontendPluginRouteSearch;
export type SourcePluginRouteParams = FrontendPluginRouteParams;

export type SourcePluginNavigation = {
  paths: SourcePluginPaths;
  home: () => void | Promise<void>;
  add: () => void | Promise<void>;
  detail: (sourceId: string, search?: SourcePluginRouteSearch) => void | Promise<void>;
  edit: (sourceId: string, search?: SourcePluginRouteSearch) => void | Promise<void>;
  child: (input: {
    sourceId: string;
    path: string;
    search?: SourcePluginRouteSearch;
  }) => void | Promise<void>;
  updateSearch: (search: SourcePluginRouteSearch) => void | Promise<void>;
};

export type FrontendSourceDetailRouteDefinition = {
  key: string;
  path: string;
  component: ComponentType<{ source: Source }>;
};

export type FrontendSourceTypeDefinition = {
  key: string;
  kind: string;
  displayName: string;
  description?: string;
  renderAddPage: ComponentType;
  renderEditPage?: ComponentType<{ source: Source }>;
  renderDetailPage?: ComponentType<{ source: Source }>;
  detailRoutes?: readonly FrontendSourceDetailRouteDefinition[];
};

export type SourcePluginRouteContextValue = {
  plugin: ExecutorFrontendPlugin;
  definition: FrontendSourceTypeDefinition;
  params: SourcePluginRouteParams;
  search: SourcePluginRouteSearch;
  navigation: SourcePluginNavigation;
};

export type ExecutorFrontendPlugin = {
  key: string;
  displayName?: string;
  description?: string;
  routes?: readonly FrontendPluginRouteDefinition[];
  sourceTypes?: readonly FrontendSourceTypeDefinition[];
};
