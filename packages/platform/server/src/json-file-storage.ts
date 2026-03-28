import { dirname, join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const bindNodeFileSystem = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(NodeFileSystem.layer));

export const readJsonFile = <TSchema extends Schema.Schema<any, any, never>>(input: {
  path: string;
  schema: TSchema;
}): Effect.Effect<Schema.Schema.Type<TSchema> | null, Error, never> => {
  const decode = Schema.decodeUnknownSync(input.schema);

  return bindNodeFileSystem(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const exists = yield* fileSystem.exists(input.path).pipe(Effect.mapError(toError));
      if (!exists) {
        return null;
      }

      const contents = yield* fileSystem.readFileString(input.path, "utf8").pipe(
        Effect.mapError(toError),
      );

      return decode(JSON.parse(contents));
    }),
  );
};

export const writeJsonFile = <TSchema extends Schema.Schema<any, any, never>>(input: {
  path: string;
  schema: TSchema;
  value: Schema.Schema.Type<TSchema>;
}): Effect.Effect<void, Error, never> => {
  const encode = Schema.encodeSync(input.schema);

  return bindNodeFileSystem(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(dirname(input.path), {
        recursive: true,
      }).pipe(Effect.mapError(toError));
      yield* fileSystem.writeFileString(
        input.path,
        `${JSON.stringify(encode(input.value), null, 2)}\n`,
      ).pipe(Effect.mapError(toError));
    }),
  );
};

export const removeJsonFile = (path: string): Effect.Effect<void, Error, never> =>
  bindNodeFileSystem(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const exists = yield* fileSystem.exists(path).pipe(Effect.mapError(toError));
      if (exists) {
        yield* fileSystem.remove(path).pipe(Effect.mapError(toError));
      }
    }),
  );

export const pluginSourceStoragePath = (input: {
  rootDir: string;
  scopeId: string;
  sourceId: string;
}) => join(input.rootDir, input.scopeId, `${input.sourceId}.json`);

export const pluginSessionStoragePath = (input: {
  rootDir: string;
  sessionId: string;
}) => join(input.rootDir, `${input.sessionId}.json`);
