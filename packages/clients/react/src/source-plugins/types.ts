import type { ComponentType } from "react";
import type { Source } from "@executor/platform-sdk/schema";

import type { SourcePluginPaths } from "./paths";

export type SourcePluginRouteSearch = Record<string, unknown>;
export type SourcePluginRouteParams = Readonly<Record<string, string | undefined>>;

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

export type SourcePluginRouteContextValue = {
  definition: FrontendSourceTypeDefinition;
  params: SourcePluginRouteParams;
  search: SourcePluginRouteSearch;
  navigation: SourcePluginNavigation;
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

export type ExecutorFrontendPluginApi = {
  sources: {
    registerType: (
      definition: FrontendSourceTypeDefinition,
    ) => void;
  };
};

export type ExecutorFrontendPlugin = {
  key: string;
  register: (api: ExecutorFrontendPluginApi) => void;
};
