import type { GoogleDiscoveryOAuthSessionStorage } from "@executor/plugin-google-discovery-sdk";
import {
  GoogleDiscoveryOAuthSessionSchema,
} from "@executor/plugin-google-discovery-shared";

import {
  pluginSessionStoragePath,
  readJsonFile,
  removeJsonFile,
  writeJsonFile,
} from "./json-file-storage";

export const createFileGoogleDiscoveryOAuthSessionStorage = (input: {
  rootDir: string;
}): GoogleDiscoveryOAuthSessionStorage => ({
  get: (sessionId) =>
    readJsonFile({
      path: pluginSessionStoragePath({
        rootDir: input.rootDir,
        sessionId,
      }),
      schema: GoogleDiscoveryOAuthSessionSchema,
    }),
  put: ({ sessionId, value }) =>
    writeJsonFile({
      path: pluginSessionStoragePath({
        rootDir: input.rootDir,
        sessionId,
      }),
      schema: GoogleDiscoveryOAuthSessionSchema,
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
