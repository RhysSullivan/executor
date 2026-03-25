const trimSlashes = (value: string): string =>
  value.replace(/^\/+/, "").replace(/\/+$/, "");

const joinPath = (...parts: ReadonlyArray<string>): string =>
  `/${parts.map(trimSlashes).filter(Boolean).join("/")}`;

export type ExecutorPluginPaths = {
  base: string;
  routePattern: (path?: string) => string;
  route: (path?: string) => string;
};

export type SourcePluginPaths = {
  add: string;
  detailPattern: string;
  editPattern: string;
  detail: (sourceId: string) => string;
  edit: (sourceId: string) => string;
  childPattern: (path: string) => string;
  child: (sourceId: string, path: string) => string;
};

export const sourcePluginsIndexPath = "/sources/add";

export const normalizeExecutorPluginPath = (value: string): string =>
  trimSlashes(value);

export const normalizeSourcePluginPath = normalizeExecutorPluginPath;

export const executorPluginBasePath = (key: string): string =>
  joinPath("plugins", key);

export const executorPluginRoutePattern = (
  key: string,
  path = "",
): string => {
  const relativePath = normalizeExecutorPluginPath(path);
  return relativePath.length === 0
    ? executorPluginBasePath(key)
    : joinPath("plugins", key, relativePath);
};

export const executorPluginRoutePath = (
  key: string,
  path = "",
): string =>
  executorPluginRoutePattern(key, path);

export const sourcePluginAddPath = (key: string): string =>
  executorPluginRoutePath(key, "add");

export const sourcePluginDetailPattern = (key: string): string =>
  joinPath("plugins", key, "sources", "$sourceId");

export const sourcePluginEditPattern = (key: string): string =>
  joinPath("plugins", key, "sources", "$sourceId", "edit");

export const sourcePluginDetailPath = (
  key: string,
  sourceId: string,
): string =>
  joinPath("plugins", key, "sources", sourceId);

export const sourcePluginEditPath = (
  key: string,
  sourceId: string,
): string =>
  joinPath("plugins", key, "sources", sourceId, "edit");

export const sourcePluginChildPattern = (
  key: string,
  path: string,
): string => {
  const relativePath = normalizeSourcePluginPath(path);
  return relativePath.length === 0
    ? sourcePluginDetailPattern(key)
    : joinPath("plugins", key, "sources", "$sourceId", relativePath);
};

export const sourcePluginChildPath = (
  key: string,
  sourceId: string,
  path: string,
): string => {
  const relativePath = normalizeSourcePluginPath(path);
  return relativePath.length === 0
    ? sourcePluginDetailPath(key, sourceId)
    : joinPath("plugins", key, "sources", sourceId, relativePath);
};

export const createExecutorPluginPaths = (key: string): ExecutorPluginPaths => ({
  base: executorPluginBasePath(key),
  routePattern: (path = "") => executorPluginRoutePattern(key, path),
  route: (path = "") => executorPluginRoutePath(key, path),
});

export const createSourcePluginPaths = (key: string): SourcePluginPaths => ({
  add: sourcePluginAddPath(key),
  detailPattern: sourcePluginDetailPattern(key),
  editPattern: sourcePluginEditPattern(key),
  detail: (sourceId) => sourcePluginDetailPath(key, sourceId),
  edit: (sourceId) => sourcePluginEditPath(key, sourceId),
  childPattern: (path) => sourcePluginChildPattern(key, path),
  child: (sourceId, path) => sourcePluginChildPath(key, sourceId, path),
});
