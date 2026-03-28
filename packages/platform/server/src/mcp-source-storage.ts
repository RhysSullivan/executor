import type { McpSourceStorage } from "@executor/plugin-mcp-sdk";
import {
  McpStoredSourceDataSchema,
} from "@executor/plugin-mcp-shared";

import {
  pluginSourceStoragePath,
  readJsonFile,
  removeJsonFile,
  writeJsonFile,
} from "./json-file-storage";

export const createFileMcpSourceStorage = (input: {
  rootDir: string;
}): McpSourceStorage => ({
  get: ({ scopeId, sourceId }) =>
    readJsonFile({
      path: pluginSourceStoragePath({
        rootDir: input.rootDir,
        scopeId,
        sourceId,
      }),
      schema: McpStoredSourceDataSchema,
    }),
  put: ({ scopeId, sourceId, value }) =>
    writeJsonFile({
      path: pluginSourceStoragePath({
        rootDir: input.rootDir,
        scopeId,
        sourceId,
      }),
      schema: McpStoredSourceDataSchema,
      value,
    }),
  remove: ({ scopeId, sourceId }) =>
    removeJsonFile(
      pluginSourceStoragePath({
        rootDir: input.rootDir,
        scopeId,
        sourceId,
      }),
    ),
});
