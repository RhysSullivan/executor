import {
  useExecutorPlugin,
  useExecutorPluginNavigation,
  useExecutorPluginRouteParams,
  useExecutorPluginSearch,
} from "./plugin-route-context";
import {
  createSourcePluginPaths,
  normalizeSourcePluginPath,
} from "./paths";
import type {
  SourcePluginNavigation,
  SourcePluginRouteParams,
  SourcePluginRouteSearch,
} from "./types";

export const useSourcePluginRoute = () => ({
  plugin: useExecutorPlugin(),
  params: useExecutorPluginRouteParams(),
  search: useExecutorPluginSearch(),
  navigation: useSourcePluginNavigation(),
});

export const useSourcePlugin = () =>
  useExecutorPlugin();

export const useSourcePluginNavigation = (): SourcePluginNavigation => {
  const plugin = useExecutorPlugin();
  const navigation = useExecutorPluginNavigation();
  const paths = createSourcePluginPaths(plugin.key);

  return {
    paths,
    home: () => navigation.home(),
    add: () => navigation.route("add"),
    detail: (sourceId, search) =>
      navigation.route(`sources/${sourceId}`, search),
    edit: (sourceId, search) =>
      navigation.route(`sources/${sourceId}/edit`, search),
    child: ({ sourceId, path, search }) => {
      const normalizedPath = normalizeSourcePluginPath(path);
      return navigation.route(
        normalizedPath.length === 0
          ? `sources/${sourceId}`
          : `sources/${sourceId}/${normalizedPath}`,
        search,
      );
    },
    updateSearch: (search) => navigation.updateSearch(search),
  };
};

export const useSourcePluginSearch = <
  TSearch extends SourcePluginRouteSearch = SourcePluginRouteSearch,
>(): TSearch =>
  useExecutorPluginSearch<TSearch>();

export const useSourcePluginRouteParams = <
  TParams extends SourcePluginRouteParams = SourcePluginRouteParams,
>(): TParams =>
  useExecutorPluginRouteParams<TParams>();

export const useSourcePluginPaths = () =>
  createSourcePluginPaths(useExecutorPlugin().key);
