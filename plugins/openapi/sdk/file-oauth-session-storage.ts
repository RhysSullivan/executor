import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  OpenApiOAuthSessionSchema,
} from "@executor/plugin-openapi-shared";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { OpenApiOAuthSessionStorage } from "./index";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const isMissingFileError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

const readJsonFile = <TSchema extends Schema.Schema<any, any, never>>(input: {
  path: string;
  schema: TSchema;
}): Effect.Effect<Schema.Schema.Type<TSchema> | null, Error, never> => {
  const decode = Schema.decodeUnknownSync(input.schema);

  return Effect.tryPromise({
    try: async () => {
      try {
        const contents = await readFile(input.path, "utf8");
        return decode(JSON.parse(contents));
      } catch (cause) {
        if (isMissingFileError(cause)) {
          return null;
        }
        throw cause;
      }
    },
    catch: toError,
  });
};

const writeJsonFile = <TSchema extends Schema.Schema<any, any, never>>(input: {
  path: string;
  schema: TSchema;
  value: Schema.Schema.Type<TSchema>;
}): Effect.Effect<void, Error, never> => {
  const encode = Schema.encodeSync(input.schema);

  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(input.path), { recursive: true });
      await writeFile(
        input.path,
        `${JSON.stringify(encode(input.value), null, 2)}\n`,
      );
    },
    catch: toError,
  });
};

const removeJsonFile = (path: string): Effect.Effect<void, Error, never> =>
  Effect.tryPromise({
    try: async () => {
      try {
        await rm(path);
      } catch (cause) {
        if (!isMissingFileError(cause)) {
          throw cause;
        }
      }
    },
    catch: toError,
  });

const pluginSessionStoragePath = (input: {
  rootDir: string;
  sessionId: string;
}) => join(input.rootDir, `${input.sessionId}.json`);

export const createFileOpenApiOAuthSessionStorage = (input: {
  rootDir: string;
}): OpenApiOAuthSessionStorage => ({
  get: (sessionId) =>
    readJsonFile({
      path: pluginSessionStoragePath({
        rootDir: input.rootDir,
        sessionId,
      }),
      schema: OpenApiOAuthSessionSchema,
    }),
  put: ({ sessionId, value }) =>
    writeJsonFile({
      path: pluginSessionStoragePath({
        rootDir: input.rootDir,
        sessionId,
      }),
      schema: OpenApiOAuthSessionSchema,
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
