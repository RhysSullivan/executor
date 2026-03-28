import type { OnePasswordStoreStorage } from "@executor/plugin-onepassword-sdk";
import {
  OnePasswordStoredStoreDataSchema,
} from "@executor/plugin-onepassword-shared";

import {
  pluginSourceStoragePath,
  readJsonFile,
  removeJsonFile,
  writeJsonFile,
} from "./json-file-storage";

export const createFileOnePasswordStoreStorage = (input: {
  rootDir: string;
}): OnePasswordStoreStorage => ({
  get: ({ scopeId, storeId }) =>
    readJsonFile({
      path: pluginSourceStoragePath({
        rootDir: input.rootDir,
        scopeId,
        sourceId: storeId,
      }),
      schema: OnePasswordStoredStoreDataSchema,
    }),
  put: ({ scopeId, storeId, value }) =>
    writeJsonFile({
      path: pluginSourceStoragePath({
        rootDir: input.rootDir,
        scopeId,
        sourceId: storeId,
      }),
      schema: OnePasswordStoredStoreDataSchema,
      value,
    }),
  remove: ({ scopeId, storeId }) =>
    removeJsonFile(
      pluginSourceStoragePath({
        rootDir: input.rootDir,
        scopeId,
        sourceId: storeId,
      }),
    ),
});
