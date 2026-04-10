import { Effect, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import * as jsonc from "jsonc-parser";
import { ExecutorFileConfig } from "./schema";

export class ConfigParseError {
  readonly _tag = "ConfigParseError";
  constructor(
    readonly path: string,
    readonly message: string,
  ) {}
}

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
      return yield* Effect.fail(new ConfigParseError(path, msg));
    }

    const decoded = yield* Schema.decodeUnknown(ExecutorFileConfig)(parsed).pipe(
      Effect.mapError((e) => new ConfigParseError(path, String(e))),
    );

    return decoded;
  });
