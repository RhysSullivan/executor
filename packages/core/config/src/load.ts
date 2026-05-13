import { Effect, Schema } from "effect";
import { FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as jsonc from "jsonc-parser";
import { ExecutorFileConfig } from "./schema";

export class ConfigParseError extends Schema.TaggedErrorClass<ConfigParseError>()(
  "ConfigParseError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Load and validate an executor config file.
 * Returns null if the file doesn't exist.
 */
export const loadConfig = (
  path: string,
): Effect.Effect<
  ExecutorFileConfig | null,
  ConfigParseError | PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const exists = yield* fs.exists(path);
    if (!exists) return null;

    const raw = yield* fs.readFileString(path);

    const errors: jsonc.ParseError[] = [];
    const parsed = jsonc.parse(raw, errors);

    if (errors.length > 0) {
      const msg = errors
        .map((e) => `offset ${e.offset}: ${jsonc.printParseErrorCode(e.error)}`)
        .join("; ");
      return yield* new ConfigParseError({ path, message: msg });
    }

    const decoded = yield* Schema.decodeUnknownEffect(ExecutorFileConfig)(parsed).pipe(
      Effect.mapError(
        (error) =>
          new ConfigParseError({
            path,
            message: error.issue.toString(),
          }),
      ),
    );

    return decoded;
  });
