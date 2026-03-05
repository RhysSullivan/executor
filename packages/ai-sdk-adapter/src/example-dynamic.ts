import {
  createDynamicDiscovery,
  type SearchProvider,
  type ToolDirectory,
  type ToolPath,
} from "./index";

const asToolPath = (value: string): ToolPath => value as ToolPath;

const directory: ToolDirectory = {
  async listNamespaces() {
    return [
      { namespace: "source.src_api", toolCount: 6800 },
      { namespace: "source.src_mcp", toolCount: 3200 },
    ];
  },
  async listTools() {
    return [{ path: asToolPath("source.src_api.github.issues.list") }];
  },
  async getByPath({ path }: { path: ToolPath; includeSchemas: boolean }) {
    return {
      path,
      sourceKey: "source.src_api",
      description: "Hydrated metadata for selected path",
      inputHint: "object",
      outputHint: "object",
    };
  },
  async getByPaths({ paths }: { paths: readonly ToolPath[]; includeSchemas: boolean }) {
    return paths.map((path) => ({
      path,
      sourceKey: "source.src_api",
      description: "Hydrated from metadata store",
      inputHint: "object",
      outputHint: "object",
    }));
  },
};

const search: SearchProvider = {
  async search({ limit }) {
    return [
      { path: asToolPath("source.src_api.github.issues.list"), score: 0.99 },
      { path: asToolPath("source.src_api.github.issues.create"), score: 0.92 },
    ].slice(0, limit);
  },
};

export const dynamicDemo = createDynamicDiscovery({
  directory,
  search,
});

console.log(dynamicDemo)
