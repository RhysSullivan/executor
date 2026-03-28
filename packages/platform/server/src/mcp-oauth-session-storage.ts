import type { McpOAuthSessionStorage } from "@executor/plugin-mcp-sdk";
import {
  McpOAuthSessionSchema,
} from "@executor/plugin-mcp-shared";

import {
  pluginSessionStoragePath,
  readJsonFile,
  removeJsonFile,
  writeJsonFile,
} from "./json-file-storage";

export const createFileMcpOAuthSessionStorage = (input: {
  rootDir: string;
}): McpOAuthSessionStorage => ({
  get: (sessionId) =>
    readJsonFile({
      path: pluginSessionStoragePath({
        rootDir: input.rootDir,
        sessionId,
      }),
      schema: McpOAuthSessionSchema,
    }),
  put: ({ sessionId, value }) =>
    writeJsonFile({
      path: pluginSessionStoragePath({
        rootDir: input.rootDir,
        sessionId,
      }),
      schema: McpOAuthSessionSchema,
      value,
    }),
  remove: (sessionId) =>
    removeJsonFile(
      pluginSessionStoragePath({
        rootDir: input.rootDir,
        sessionId,
      }),
    ),
});
