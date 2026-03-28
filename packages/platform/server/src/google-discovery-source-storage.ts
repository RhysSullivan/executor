import type { GoogleDiscoverySourceStorage } from "@executor/plugin-google-discovery-sdk";
import {
  GoogleDiscoveryStoredSourceDataSchema,
} from "@executor/plugin-google-discovery-shared";

import {
  pluginSourceStoragePath,
  readJsonFile,
  removeJsonFile,
  writeJsonFile,
} from "./json-file-storage";

export const createFileGoogleDiscoverySourceStorage = (input: {
  rootDir: string;
}): GoogleDiscoverySourceStorage => ({
  get: ({ scopeId, sourceId }) =>
    readJsonFile({
      path: pluginSourceStoragePath({
        rootDir: input.rootDir,
        scopeId,
        sourceId,
      }),
      schema: GoogleDiscoveryStoredSourceDataSchema,
    }),
  put: ({ scopeId, sourceId, value }) =>
    writeJsonFile({
      path: pluginSourceStoragePath({
        rootDir: input.rootDir,
        scopeId,
        sourceId,
      }),
      schema: GoogleDiscoveryStoredSourceDataSchema,
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
