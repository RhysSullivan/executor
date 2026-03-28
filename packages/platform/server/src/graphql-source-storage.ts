import type { GraphqlSourceStorage } from "@executor/plugin-graphql-sdk";
import {
  GraphqlStoredSourceDataSchema,
} from "@executor/plugin-graphql-shared";

import {
  pluginSourceStoragePath,
  readJsonFile,
  removeJsonFile,
  writeJsonFile,
} from "./json-file-storage";

export const createFileGraphqlSourceStorage = (input: {
  rootDir: string;
}): GraphqlSourceStorage => ({
  get: ({ scopeId, sourceId }) =>
    readJsonFile({
      path: pluginSourceStoragePath({
        rootDir: input.rootDir,
        scopeId,
        sourceId,
      }),
      schema: GraphqlStoredSourceDataSchema,
    }),
  put: ({ scopeId, sourceId, value }) =>
    writeJsonFile({
      path: pluginSourceStoragePath({
        rootDir: input.rootDir,
        scopeId,
        sourceId,
      }),
      schema: GraphqlStoredSourceDataSchema,
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
